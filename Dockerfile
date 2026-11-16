FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ffmpeg ca-certificates \
    && python3 -m venv /opt/yt-dlp-venv \
    && /opt/yt-dlp-venv/bin/pip install --no-cache-dir --upgrade pip yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    YTDLP_PATH=/opt/yt-dlp-venv/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 10000
CMD ["npm", "start"]
