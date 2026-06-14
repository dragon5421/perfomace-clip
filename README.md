# Performance Clip Tool — Backend (Railway)

Cuts clips out of your Vimeo videos using the Vimeo API + ffmpeg, reading only
the bytes around each clip (HTTP range-seek) so it never downloads the full
video. Pairs with the Netlify frontend.

---

## What you need first: a Vimeo API token

1. Go to **developer.vimeo.com/apps** → **Create an app** (any name).
2. In the app, go to **Authentication** → generate a **Personal Access Token**.
3. Give it the scopes: **Public**, **Private**, and **Video Files**.
   - The `Video Files` scope is the important one — it's what returns
     downloadable file links.
   - ⚠ On some lower Vimeo plan tiers the API won't return file links even with
     this scope. If you get a "No progressive file" error, that's the cause —
     you'd need a Vimeo plan that allows API file access.
4. Copy the token. You'll paste it into Railway as `VIMEO_TOKEN`.

You must be the **owner** of the videos (or the account) for the token to
access their files.

---

## Deploy to Railway

1. Push this `clip-backend` folder to a GitHub repo (or use Railway's CLI).
2. In Railway: **New Project → Deploy from GitHub repo** → pick it.
   - Railway auto-detects the **Dockerfile** (which installs ffmpeg). No build
     config needed.
3. Add environment variables in the Railway project **Variables** tab:
   - `VIMEO_TOKEN` = your token from above
   - `ALLOWED_ORIGIN` = your Netlify site URL, e.g.
     `https://your-clip-tool.netlify.app`
     (comma-separate multiple; `*` allows any origin — fine for testing, lock
     it down for real use)
4. Deploy. Railway gives you a public URL like
   `https://your-app.up.railway.app`.
5. Open `https://your-app.up.railway.app/` in a browser — you should see
   `{"ok":true,...,"tokenSet":true}`.

Paste that Railway URL into the **Backend URL** field on the Netlify frontend.
Done.

---

## How the cutting works

- Frontend sends `{ videoId, hash, in, out, name, mode }`.
- Backend asks Vimeo for the video's `progressive` MP4 link (a temporary CDN
  URL).
- ffmpeg runs `-ss <in> -i <cdn-url> -t <len> ...` — putting `-ss` **before**
  `-i` makes ffmpeg seek into the remote file with range requests, pulling only
  the bytes near your clip. A 90-second cut from a 2-hour file transfers a few
  MB, not gigabytes.
- The cut MP4 streams straight back to the browser as a download.

**Modes:**
- `fast` (default) — stream-copy, no re-encode. Near-instant. Snaps the start
  to the nearest keyframe (typically within a few hundred ms).
- `accurate` — re-encodes (H.264/AAC) for a frame-exact start. Slower, heavier
  on the server, but precise.

---

## Endpoint

```
GET  /                 → health check
POST /clip             → cut a clip, returns video/mp4
     body: { videoId, hash?, in, out, name?, maxHeight?, mode? }
```

`maxHeight` (optional) caps the rendition, e.g. `720` to avoid pulling 1080p.

---

## Cost / limits

- Railway's free tier covers light use comfortably; range-seek keeps bandwidth
  and CPU low. `accurate` mode uses real CPU per second of clip — fine for a
  classroom, watch it if you batch hundreds.
- Vimeo's CDN file links expire after a few hours, but the backend fetches a
  fresh one on every request, so that's transparent to you.
- Per-clip cap is 30 min (adjustable in `server.js`).

---

## Security note

The Vimeo token lives only in Railway's environment — it's never sent to the
browser. Keep `ALLOWED_ORIGIN` set to your real site so other pages can't call
your backend and burn your Vimeo quota.
