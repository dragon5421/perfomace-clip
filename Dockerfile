# Works identically on Render and Railway — both auto-detect this Dockerfile.
# ffmpeg is the whole reason we use Docker: Node base images don't include it,
# and without it every cut fails.
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Both platforms inject PORT; server.js reads it and falls back to 3000.
EXPOSE 3000
CMD ["node", "server.js"]
