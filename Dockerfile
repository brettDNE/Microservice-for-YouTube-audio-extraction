# Reliable base with Debian + apt
FROM node:20-bookworm-slim

# Install ffmpeg + yt-dlp (binary)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
# Cloud Run injects PORT; we just honor it in server.js
CMD ["node", "server.js"]
