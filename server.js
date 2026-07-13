// Performance Clip Tool — cutting worker
// Resolves a Vimeo progressive file link via the API, then cuts a clip with
// ffmpeg using HTTP range-seek (reads only the bytes around in/out — no full
// download). Streams the resulting MP4 straight back to the browser.
//
// Deploys identically to Render or Railway (both build the Dockerfile).
// Env vars:
//   VIMEO_TOKEN     — Vimeo personal access token (scopes: public private video_files)
//   ALLOWED_ORIGIN  — your frontend origin(s), comma-separated. Trailing
//                     slashes are tolerated. "*" allows any origin.

import express from "express";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

// ---- CORS ----
// Trailing slashes are normalized on BOTH sides, so setting ALLOWED_ORIGIN to
// "https://site.netlify.app/" (with slash) still matches the browser's origin
// header "https://site.netlify.app" (without). This mismatch is a classic
// silent killer — an origin is only ever scheme+host+port, never a path.
const stripSlash = s => (s || "").replace(/\/+$/, "");
const ALLOWED = (process.env.ALLOWED_ORIGIN || "*")
  .split(",").map(s => stripSlash(s.trim())).filter(Boolean);

// Reflect the request origin when allowed (or when "*" is configured).
// Crucially this NEVER throws — a disallowed origin just doesn't get the
// header, instead of producing a header-less 500 that masks the real error.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const normOrigin = stripSlash(origin);
  const allow = !ALLOWED.length || ALLOWED.includes("*") ||
    (normOrigin && ALLOWED.includes(normOrigin));
  if (allow && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (ALLOWED.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const TOKEN = process.env.VIMEO_TOKEN;
if (!TOKEN) console.warn("⚠  VIMEO_TOKEN not set — /clip will fail until it is.");

// Pick the best progressive rendition at or below a height cap.
function pickRendition(progressive, maxHeight) {
  const sorted = [...progressive].sort((a, b) => (b.height || 0) - (a.height || 0));
  const capped = sorted.filter(r => !maxHeight || (r.height || 0) <= maxHeight);
  return (capped[0] || sorted[0]) || null;
}

// Resolve a Vimeo video id (+ optional unlisted hash) to a direct MP4 url.
async function resolveFileUrl(videoId, hash, maxHeight) {
  const url = `https://api.vimeo.com/videos/${videoId}` +
    (hash ? `:${hash}` : "") + `?fields=play,name`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.vimeo.*+json;version=3.4",
    },
  });
  if (r.status === 401) throw httpErr(401, "Vimeo rejected the token (check scopes: public private video_files).");
  if (r.status === 404) throw httpErr(404, "Video not found, or the token's account can't access it.");
  if (!r.ok) throw httpErr(502, `Vimeo API error ${r.status}.`);
  const data = await r.json();
  const prog = data?.play?.progressive || [];
  if (!prog.length)
    throw httpErr(422, "No progressive file for this video. Your Vimeo plan tier may not expose downloadable files via API.");
  const pick = pickRendition(prog, maxHeight);
  return { fileUrl: pick.link, height: pick.height, name: data?.name || `video_${videoId}` };
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const sanitize = s => String(s || "clip").replace(/[^\w\-]+/g, "_").slice(0, 80);

// ---- health check ----
// The frontend pings this to wake sleeping free-tier servers and to confirm
// the token is configured.
app.get("/", (_req, res) => res.json({ ok: true, service: "clip-backend", tokenSet: !!TOKEN }));

// ---- main endpoint ----
// POST /clip { videoId, hash?, in (sec), out (sec), name?, maxHeight?, mode? }
app.post("/clip", async (req, res) => {
  try {
    const { videoId, hash, in: inPt, out: outPt, name, maxHeight, mode } = req.body || {};
    if (!videoId) throw httpErr(400, "videoId required");
    const start = Number(inPt), end = Number(outPt);
    if (!isFinite(start) || !isFinite(end) || end <= start)
      throw httpErr(400, "in/out invalid (out must be > in)");
    if (end - start > 1800) throw httpErr(400, "Clip too long (max 30 min per clip).");

    const { fileUrl, name: vidName } = await resolveFileUrl(videoId, hash, Number(maxHeight) || 0);
    const dur = (end - start).toFixed(3);
    const filename = `${sanitize(name || vidName)}.mp4`;

    // "accurate" re-encodes for frame-exact cuts; default "fast" stream-copies
    // (snaps to the nearest keyframe, ~tens of ms, but near-instant).
    const accurate = mode === "accurate";
    const codecArgs = accurate
      ? ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"]
      : ["-c", "copy", "-avoid_negative_ts", "make_zero"];

    // -ss BEFORE -i => ffmpeg seeks into the remote URL with HTTP range
    // requests, reading only the bytes near the clip. A 90s cut from a 2-hour
    // file transfers a few MB, not gigabytes.
    // movflags frag_keyframe+empty_moov => streamable mp4 to stdout (no seek-back).
    const args = [
      "-ss", String(start),
      "-i", fileUrl,
      "-t", dur,
      ...codecArgs,
      "-movflags", "frag_keyframe+empty_moov",
      "-f", "mp4",
      "pipe:1",
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let started = false;
    ff.stderr.on("data", d => { stderr += d.toString(); });

    // Only commit to a binary response once ffmpeg actually emits bytes.
    // Until then, any failure can still return a readable JSON error — setting
    // Content-Type early would make errors surface as opaque CORS failures.
    ff.stdout.on("data", chunk => {
      if (!started) {
        started = true;
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      }
      res.write(chunk);
    });

    ff.on("error", err => {
      console.error("spawn error:", err.message);
      if (!res.headersSent)
        res.status(500).json({ error: "ffmpeg failed to start — is it installed on the server? (" + err.message + ")" });
      else res.end();
    });

    ff.on("close", code => {
      if (started) { res.end(); return; }
      // ffmpeg exited without ever producing output -> surface the real reason.
      console.error("ffmpeg exit", code, "\n", stderr.slice(-800));
      if (!res.headersSent) {
        const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
        res.status(500).json({ error: `ffmpeg produced no output (exit ${code}). ${tail}` });
      } else res.end();
    });

    req.on("close", () => { if (!ff.killed) ff.kill("SIGKILL"); });
  } catch (e) {
    const status = e.status || 500;
    if (!res.headersSent) res.status(status).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`clip-backend listening on ${PORT}`));
