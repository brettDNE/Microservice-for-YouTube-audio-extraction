# Use slim Node image
FROM node:20-bookworm-slim

# Install system deps: ffmpeg + curl + python (yt-dlp runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp standalone
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

# App dir
WORKDIR /app

# Install node deps (production only)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app
COPY . .

# Cloud Run listens on 8080
ENV PORT=8080
ENV NODE_ENV=production

# Start
CMD ["node", "server.js"]
