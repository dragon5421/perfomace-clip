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
import fs from "fs";

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

// ---------------- YouTube (yt-dlp) ----------------
// Optional: YOUTUBE_COOKIES holds the contents of a Netscape-format cookies.txt
// exported from a browser logged into YouTube. This is the reliable way past
// YouTube's datacenter-IP bot blocking, but note the tradeoffs:
//   - it puts an authenticated session on the server
//   - cookies expire and need re-exporting periodically
//   - Google may flag an account whose session is used from a datacenter
// Prefer a throwaway/secondary Google account over your main school account.
let COOKIE_FILE = null;
if (process.env.YOUTUBE_COOKIES) {
  try {
    COOKIE_FILE = "/tmp/yt-cookies.txt";
    fs.writeFileSync(COOKIE_FILE, process.env.YOUTUBE_COOKIES);
    console.log("YouTube cookies loaded — will be used as a fallback if client spoofing fails.");
  } catch (e) {
    console.warn("Couldn't write the YouTube cookie file:", e.message);
    COOKIE_FILE = null;
  }
}

// YouTube has no API that returns a downloadable file URL, so we use yt-dlp to
// resolve a direct stream URL that ffmpeg can range-seek — same shape as the
// Vimeo path, different resolver.
//
// IMPORTANT: YouTube serves high-quality video and audio as SEPARATE streams.
// Asking for "best" naively yields a video-only URL and your clip comes out
// SILENT. The format string below prefers a pre-merged progressive MP4; if
// none exists at a usable quality, we fall back to resolving BOTH streams and
// let ffmpeg mux them (two -i inputs).
function ytdlp(args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(httpErr(504, "yt-dlp timed out resolving the video.")); }, timeoutMs);
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", e => { clearTimeout(timer); reject(httpErr(500, "yt-dlp isn't installed on the server: " + e.message)); });
    p.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = err.split("\n").filter(Boolean).slice(-2).join(" | ");
        // A broken extractor is the most common failure — say so plainly.
        if (/unable to extract|unsupported url|sign in|bot/i.test(err))
          return reject(httpErr(422, "yt-dlp couldn't read this YouTube video. It may be private, age-restricted, or YouTube changed something and yt-dlp needs updating. " + tail));
        return reject(httpErr(502, "yt-dlp failed: " + tail));
      }
      resolve(out.trim());
    });
  });
}

async function resolveYouTube(videoId, maxHeight) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const cap = maxHeight || 1080;
  const fmt = `best[ext=mp4][height<=${cap}][acodec!=none][vcodec!=none]/` +
              `bestvideo[ext=mp4][height<=${cap}]+bestaudio[ext=m4a]/` +
              `best[height<=${cap}]`;

  // YouTube blocks datacenter IPs (Render/Railway/AWS) with "Sign in to confirm
  // you're not a bot" — the default web client gets flagged. Spoofing a mobile
  // app client usually sidesteps this for public videos, because those clients
  // authenticate differently. We try several in order and use the first that works.
  //
  // If a YOUTUBE_COOKIES env var is set (Netscape cookie file contents), we also
  // try a cookie-authenticated pass as a last resort.
  const clients = (process.env.YT_CLIENTS || "android,ios,tv,web").split(",").map(s => s.trim()).filter(Boolean);

  const attempts = [];
  for (const c of clients) {
    attempts.push({
      label: `client=${c}`,
      args: ["-f", fmt, "--no-playlist", "--no-warnings",
             "--extractor-args", `youtube:player_client=${c}`,
             "-O", "urls", "--print", "title", url],
    });
  }
  if (COOKIE_FILE) {
    attempts.push({
      label: "cookies",
      args: ["-f", fmt, "--no-playlist", "--no-warnings",
             "--cookies", COOKIE_FILE,
             "-O", "urls", "--print", "title", url],
    });
  }

  const errors = [];
  for (const a of attempts) {
    try {
      const raw = await ytdlp(a.args);
      const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
      const urls = lines.filter(l => /^https?:\/\//i.test(l));
      if (!urls.length) { errors.push(`${a.label}: no stream URL`); continue; }
      const title = lines.find(l => !/^https?:\/\//i.test(l)) || `youtube_${videoId}`;
      console.log(`YouTube ${videoId}: resolved via ${a.label}`);
      return { urls, name: title };
    } catch (e) {
      errors.push(`${a.label}: ${e.message}`);
      // keep trying the next client
    }
  }

  // Everything failed. Give a message that says what's actually wrong.
  const blob = errors.join(" || ");
  if (/sign in|not a bot|consent|age/i.test(blob)) {
    throw httpErr(429,
      "YouTube blocked this request. Cloud servers (Render/Railway) share datacenter IPs that YouTube flags as bots — " +
      "this is a known limitation, not a fault in the video or your setup. " +
      "Options: set YOUTUBE_COOKIES on the backend, use a residential proxy, or host the archive on Vimeo (which has a proper API). " +
      "Details: " + blob.slice(0, 300));
  }
  throw httpErr(422, "Couldn't resolve that YouTube video. " + blob.slice(0, 300));
}

function parseYouTubeId(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/^[\w-]{11}$/.test(s)) return s;                       // bare id
  let m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// ---- health check ----
// The frontend pings this to wake sleeping free-tier servers and to confirm
// the token is configured.
let ytdlpVersion = null;

// Keep yt-dlp current. YouTube changes its player periodically and stale
// versions fail with "Unable to extract". Self-updating on boot means that on
// free tiers (where the server sleeps and cold-starts often) it stays fresh
// with no maintenance from you.
//   AUTO_UPDATE_YTDLP=off   disables this entirely
//   AUTO_UPDATE_YTDLP=always updates on every boot
//   (default) updates only if the installed build is older than ~10 days
const AUTO_UPDATE = (process.env.AUTO_UPDATE_YTDLP || "stale").toLowerCase();

function ytdlpAgeDays(v) {
  // versions look like 2026.07.04
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(v || "");
  if (!m) return Infinity;
  const built = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return (Date.now() - built) / 86400000;
}

async function initYtdlp() {
  try {
    ytdlpVersion = await ytdlp(["--version"], 10000);
  } catch { ytdlpVersion = null; return; }

  if (AUTO_UPDATE === "off") return;
  const age = ytdlpAgeDays(ytdlpVersion);
  const shouldUpdate = AUTO_UPDATE === "always" || age > 10;
  if (!shouldUpdate) {
    console.log(`yt-dlp ${ytdlpVersion} (${Math.round(age)}d old) — fresh enough, skipping update.`);
    return;
  }
  console.log(`yt-dlp ${ytdlpVersion} is ${Math.round(age)}d old — updating…`);
  try {
    // -U replaces the binary in place. Runs in the background so it never
    // delays the first request; the old version keeps working meanwhile.
    await ytdlp(["-U"], 60000);
    const nv = await ytdlp(["--version"], 10000);
    if (nv !== ytdlpVersion) console.log(`yt-dlp updated: ${ytdlpVersion} -> ${nv}`);
    ytdlpVersion = nv;
  } catch (e) {
    // An update failure is not fatal — the existing binary still works.
    console.warn("yt-dlp self-update failed (keeping current version):", e.message);
  }
}
initYtdlp();

app.get("/", (_req, res) => res.json({
  ok: true,
  service: "clip-backend",
  tokenSet: !!TOKEN,              // Vimeo
  youtube: !!ytdlpVersion,        // YouTube available?
  ytdlpVersion: ytdlpVersion || "not installed",
  ytdlpAgeDays: ytdlpVersion ? Math.round(ytdlpAgeDays(ytdlpVersion)) : null,
  autoUpdate: AUTO_UPDATE,
  ytCookies: !!COOKIE_FILE,
  ytClients: (process.env.YT_CLIENTS || "android,ios,tv,web"),
}));

// ---- main endpoint ----
// POST /clip { videoId, hash?, in (sec), out (sec), name?, maxHeight?, mode? }
// ---- concurrency guard ----
// Measured peaks at 1080p: fast/stream-copy ~55MB, accurate/re-encode ~232MB.
// On a 512MB instance (Render free), two simultaneous "accurate" cuts would
// OOM and the platform would kill the container. Rather than let that happen,
// queue requests beyond the limit.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_CUTS) || 2;
let running = 0;
const waiting = [];
function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise(res => waiting.push(res));
}
function release() {
  const next = waiting.shift();
  if (next) next();          // hand the slot straight to whoever's queued
  else running--;
}

app.post("/clip", async (req, res) => {
  await acquire();
  let releasedFlag = false;
  const done = () => { if (!releasedFlag) { releasedFlag = true; release(); } };
  try {
    const { videoId, hash, in: inPt, out: outPt, name, maxHeight, mode } = req.body || {};
    const source = (req.body?.source || "vimeo").toLowerCase();
    if (!videoId) throw httpErr(400, "videoId required");
    const start = Number(inPt), end = Number(outPt);
    if (!isFinite(start) || !isFinite(end) || end <= start)
      throw httpErr(400, "in/out invalid (out must be > in)");
    if (end - start > 1800) throw httpErr(400, "Clip too long (max 30 min per clip).");

    // Resolve the source to one or more directly-seekable stream URLs.
    let streamUrls, vidName;
    if (source === "youtube") {
      const yt = await resolveYouTube(videoId, Number(maxHeight) || 0);
      streamUrls = yt.urls; vidName = yt.name;
    } else {
      const vm = await resolveFileUrl(videoId, hash, Number(maxHeight) || 0);
      streamUrls = [vm.fileUrl]; vidName = vm.name;
    }

    const dur = (end - start).toFixed(3);
    const filename = `${sanitize(name || vidName)}.mp4`;

    // If YouTube gave us separate video + audio streams, ffmpeg takes BOTH as
    // inputs and muxes them. Stream-copy can't always combine them cleanly, so
    // a 2-input cut re-encodes audio to be safe (video still copies when it can).
    const twoStream = streamUrls.length > 1;
    const accurate = mode === "accurate";

    let codecArgs;
    if (accurate) {
      codecArgs = ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"];
    } else if (twoStream) {
      // copy video (fast), re-encode audio (cheap) so the mux is always valid
      codecArgs = ["-c:v", "copy", "-c:a", "aac", "-avoid_negative_ts", "make_zero"];
    } else {
      codecArgs = ["-c", "copy", "-avoid_negative_ts", "make_zero"];
    }

    // -ss BEFORE each -i => ffmpeg seeks into the remote URL with HTTP range
    // requests, reading only the bytes near the clip. A 90s cut from a 2-hour
    // file transfers a few MB, not gigabytes.
    // movflags frag_keyframe+empty_moov => streamable mp4 to stdout (no seek-back).
    const args = [];
    streamUrls.forEach(u => { args.push("-ss", String(start), "-i", u); });
    args.push("-t", dur);
    if (twoStream) args.push("-map", "0:v:0", "-map", "1:a:0");
    args.push(...codecArgs,
      "-movflags", "frag_keyframe+empty_moov",
      "-f", "mp4",
      "pipe:1");

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
      done();
    });

    ff.on("close", code => {
      if (started) { res.end(); done(); return; }
      // ffmpeg exited without ever producing output -> surface the real reason.
      console.error("ffmpeg exit", code, "\n", stderr.slice(-800));
      if (!res.headersSent) {
        const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
        res.status(500).json({ error: `ffmpeg produced no output (exit ${code}). ${tail}` });
      } else res.end();
      done();
    });

    // Client hung up (closed tab, cancelled download) — kill ffmpeg so it
    // doesn't keep burning CPU/memory on a clip nobody will receive.
    req.on("close", () => { if (!ff.killed) ff.kill("SIGKILL"); done(); });
  } catch (e) {
    const status = e.status || 500;
    if (!res.headersSent) res.status(status).json({ error: e.message });
    done();   // never leak a slot — a leak would eventually deadlock the server
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`clip-backend listening on ${PORT}`));
