# Dockerfile
FROM node:20-bookworm-slim

# System deps: ffmpeg + curl + python (for yt-dlp runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Copy manifests. The wildcard will match package-lock.json if present.
COPY package*.json ./

# If package-lock.json exists, use ci; otherwise use install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copy the rest of your app
COPY . .

ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "server.js"]
