# JV Methods Bot v2.0

## Features
- **Enhanced Method**: Kuronai `POST https://api.kuronaiapp.com/uploaden/`.
- **HD Method**: Luna (the original MP4Patcher adapter) or Jarvis HQ (`POST /upload/`).
- **Jarvis Optimizer ON/OFF**: maps to the extension's `encode_video=true/false` multipart field.
- **Live Jarvis status**: displays elapsed time and server-reported NDJSON progress. If the server does not send a percentage, the bot displays a waiting/server-working status rather than inventing one.
- **FFmpeg Method**: original timestamp-scaling method, with 30/60 FPS selection.
- **Checker & Downloader**: self-hosted yt-dlp metadata and TikTok downloads, plus native FFprobe inspection of the downloaded stream.

## Deploy
1. Deploy as a Render Web Service.
2. For Render's **Node** runtime, use Node.js 18 or newer and set this Build Command:
   `npm install && python3 -m venv .venv && .venv/bin/pip install --upgrade pip yt-dlp`
3. Set Start Command to `npm start`.
4. Set `BOT_TOKEN` in Render Environment.
5. Render normally supplies `RENDER_EXTERNAL_URL` automatically. You can optionally set `WEBHOOK_SECRET`, `MAX_VIDEO_MB`, `FFMPEG_PATH`, and `FFPROBE_PATH`.
6. The bot automatically uses `.venv/bin/yt-dlp` when that file exists. You can override it with `YTDLP_PATH` if needed.

If you deploy using the included Dockerfile instead, it installs yt-dlp into `/opt/yt-dlp-venv` and configures `YTDLP_PATH` automatically. Do not use a Node build command with a Docker runtime.

## Important behavior and limitations
- The bot sends the Telegram user ID as `tg_id`, matching the extension's upload request. It does not hardcode one person's ID.
- Jarvis ON sends `encode_video=true`; OFF sends `encode_video=false` to `/upload/`.
- The extension's `/uploaden/` route is used for Enhanced and does not send `encode_video`.
- Actual server encoding percentages are displayed only when the server emits a numeric `percent` in its NDJSON `progress` events. The elapsed timer continues independently.
- The original supplied HTML is retained in `assets/JV-Checker-Downloader-Full-Data.html` as a reference asset. The active Telegram TikTok checker uses yt-dlp, not the HTML's former downloader API.
- FFprobe inspects the downloaded rendition only; it cannot discover all private/server-side TikTok variants.
- The original Luna and FFmpeg method source files are retained.


## TikTok checker/downloader (yt-dlp)

TikWM has been removed. TikTok URLs are now inspected and downloaded by `yt-dlp` running on the JV server. The bot requests JSON metadata from yt-dlp, displays fields that the extractor actually returns, and offers standard (up to 720p when available) and highest-available downloads. The inspect action downloads the highest available rendition and runs the server's FFprobe against that file.

### Install yt-dlp

The included `Dockerfile` installs yt-dlp in a Python virtual environment and sets `YTDLP_PATH` automatically. For Render's native Node runtime, the build command above installs yt-dlp into the project's `.venv` directory. The bot also falls back to `python3 -m yt_dlp` if the executable cannot be found. Keep yt-dlp updated because TikTok may change its site behavior.

Example local setup:

```bash
python3 -m venv .venv-ytdlp
.venv-ytdlp/bin/pip install -U yt-dlp
YTDLP_PATH="$PWD/.venv-ytdlp/bin/yt-dlp" npm start
```

The metadata shown is limited to what TikTok and the current yt-dlp extractor make available. Region, likes, comments, or other fields may be missing. This is self-hosted software with no paid downloader API quota, but it is not literally unlimited: server CPU, storage, bandwidth, and TikTok access controls still apply.

**Telegram file-transfer note:** this update replaces TikWM with yt-dlp; it does not yet add MTProto. The existing Telegraf Bot API transfer path still has Telegram's standard file-size restrictions.
