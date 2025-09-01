# Dockerfile
FROM node:20-bookworm-slim

# ffmpeg + yt-dlp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# If you don't commit a lockfile, use npm install (not npm ci)
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

# Cloud Run provides PORT; server listens on 0.0.0.0:PORT
CMD ["node", "server.js"]
