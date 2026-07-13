# Works identically on Render and Railway — both auto-detect this Dockerfile.
#
# Two system tools are required and neither ships with Node:
#   ffmpeg  — does the actual cutting (all sources)
#   yt-dlp  — resolves YouTube stream URLs (YouTube only; Vimeo uses its API)
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp: standalone binary, no Python/pip to manage.
#
# STAYING CURRENT (this matters — YouTube breaks old versions periodically):
#   1. This pulls the LATEST release at build time, so any redeploy refreshes it.
#   2. server.js ALSO self-updates on boot if the binary is >10 days old
#      (control with AUTO_UPDATE_YTDLP = stale | always | off).
# Between the two, you should never have to think about this. If YouTube clips
# start failing anyway, just redeploy — that alone pulls a fresh yt-dlp.
RUN curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" \
      -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
