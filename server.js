// Performance Clip Tool — cutting worker
// Resolves a Vimeo progressive file link via the API, then cuts a clip with
// ffmpeg using HTTP range-seek (reads only the bytes around in/out — no full
// download). Streams the resulting MP4 straight back to the browser.

import express from "express";
import cors from "cors";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

// ---- CORS: lock to your Netlify site in production ----
const ALLOWED = (process.env.ALLOWED_ORIGIN || "*")
  .split(",").map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.includes("*") || ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error("Origin not allowed"));
  },
}));

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
app.get("/", (_req, res) => res.json({ ok: true, service: "clip-backend", tokenSet: !!TOKEN }));

// ---- main endpoint ----
// POST /clip { videoId, hash?, in (sec), out (sec), name?, maxHeight? }
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

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // "accurate" re-encodes for frame-exact cuts; default "fast" stream-copies
    // (snaps to the nearest keyframe, ~tens of ms, but near-instant).
    const accurate = mode === "accurate";
    const codecArgs = accurate
      ? ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"]
      : ["-c", "copy", "-avoid_negative_ts", "make_zero"];

    // -ss before -i => ffmpeg seeks into the remote URL with range requests,
    // reading only the bytes near the clip. movflags => streamable mp4 to stdout.
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
    ff.stderr.on("data", d => { stderr += d.toString(); });
    ff.stdout.pipe(res);

    ff.on("error", err => {
      if (!res.headersSent) res.status(500).json({ error: "ffmpeg not available: " + err.message });
      else res.end();
    });
    ff.on("close", code => {
      if (code !== 0 && !res.writableEnded) {
        console.error("ffmpeg exit", code, stderr.slice(-500));
        if (!res.headersSent) res.status(500).json({ error: "Cut failed." });
        else res.end();
      }
    });

    req.on("close", () => { if (!ff.killed) ff.kill("SIGKILL"); });
  } catch (e) {
    const status = e.status || 500;
    if (!res.headersSent) res.status(status).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`clip-backend listening on ${PORT}`));
