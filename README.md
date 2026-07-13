# Performance Clip Tool — Backend

Cuts clips from Vimeo videos using the Vimeo API + ffmpeg. Reads only the bytes
around each clip via HTTP range-seek, so a 90-second cut from a 2-hour file
transfers a few MB — never the whole video.

Deploys **identically to Render or Railway**. Same repo, same Dockerfile, no
code changes. You can run both and switch between them in the frontend.

---

## Repo layout

These files must be at the **root of the repo** (not nested in a subfolder), or
the platform won't find the Dockerfile:

```
server.js
package.json
package-lock.json
Dockerfile
.dockerignore
.gitignore
```

---

## Environment variables

| Key | Value |
|---|---|
| `VIMEO_TOKEN` | Vimeo personal access token — scopes: **Public**, **Private**, **Video Files** |
| `ALLOWED_ORIGIN` | Your frontend origin, e.g. `https://performanceclips.netlify.app` |

Don't set `PORT` — both platforms inject it automatically.

`ALLOWED_ORIGIN` tolerates a trailing slash, and accepts a comma-separated list.
`*` allows any origin (fine for testing; lock it down for real use).

### Getting the Vimeo token
1. developer.vimeo.com/apps → **Create an app**
2. **Authentication** → generate a **Personal Access Token**
3. Tick scopes: Public, Private, **Video Files** ← the important one
4. You must own the videos (or the account) for the token to reach their files.

⚠ Some lower Vimeo plan tiers don't expose downloadable files via API even with
the right scope. If you see "No progressive file for this video," that's the
cause, not a bug.

---

## Deploy to Render (free tier)

1. dashboard.render.com → **New +** → **Web Service**
2. Connect the GitHub repo.
3. Settings:
   - **Root Directory:** blank (files are at repo root)
   - **Runtime/Language:** **Docker** ← must be Docker, not Node. The Dockerfile
     is what installs ffmpeg; without it every cut fails.
   - **Instance Type:** **Free**
   - Leave build/start commands blank — the Dockerfile handles them.
4. Add the two environment variables above.
5. **Create Web Service.** First build takes a few minutes (installing ffmpeg).

**Free tier note:** the service sleeps after 15 minutes idle and takes 30–60s to
wake. The frontend pings it automatically when you load a video, so it's warm by
the time you cut.

## Deploy to Railway

New Project → Deploy from GitHub repo → pick it. Railway auto-detects the
Dockerfile. Add the same two variables. Railway has no permanent free tier
($5 trial credit, then $5/mo Hobby).

---

## Verify

Open the service root URL in a browser:

```
https://your-app.onrender.com/
```

Expect: `{"ok":true,"service":"clip-backend","tokenSet":true}`

`tokenSet:false` means `VIMEO_TOKEN` didn't take.

Then paste that URL into the frontend's backend dropdown → **Add**.

---

## Endpoint

```
GET  /       → health check (also used to wake the server)
POST /clip   → returns video/mp4
     { videoId, hash?, in, out, name?, maxHeight?, mode? }
```

- `hash` — the privacy hash for unlisted videos (`vimeo.com/123456789/abcdef` → `abcdef`)
- `mode` — `fast` (default; stream-copy, near-instant, snaps to nearest keyframe)
  or `accurate` (re-encode, frame-exact, slower)
- `maxHeight` — optional cap, e.g. `720`
- Per-clip limit: 30 min (adjustable in `server.js`)

---

## How it works

`-ss` goes **before** `-i`, which makes ffmpeg seek into the remote CDN URL with
HTTP range requests instead of downloading the file. Vimeo's CDN supports ranges,
so only the bytes near the clip ever move. The cut MP4 streams straight back to
the browser.

Response headers are deliberately deferred until ffmpeg emits its first byte —
otherwise an error would arrive with `Content-Type: video/mp4` already set and
surface in the browser as an opaque CORS failure instead of a readable message.
