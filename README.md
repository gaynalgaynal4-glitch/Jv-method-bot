# JV Methods Bot v2.0

## Features
- **Enhanced Method**: Kuronai `POST https://api.kuronaiapp.com/uploaden/`.
- **HD Method**: Luna (the original MP4Patcher adapter) or Jarvis HQ (`POST /upload/`).
- **Jarvis Optimizer ON/OFF**: maps to the extension's `encode_video=true/false` multipart field.
- **Live Jarvis status**: displays elapsed time and server-reported NDJSON progress. If the server does not send a percentage, the bot displays a waiting/server-working status rather than inventing one.
- **FFmpeg Method**: original timestamp-scaling method, with 30/60 FPS selection.
- **Checker & Downloader**: TikWM metadata, region field where returned, standard/HD download links, original-quality task flow, and native FFprobe inspection of the downloaded stream.

## Deploy
1. Use Node.js 18 or newer.
2. Set `BOT_TOKEN` to your Telegram bot token.
3. Set `RENDER_EXTERNAL_URL` (automatically provided by Render) or `PUBLIC_URL` to your public HTTPS service URL.
4. Optional: set `WEBHOOK_SECRET`, `PORT`, `MAX_VIDEO_MB`, `FFMPEG_PATH`, or `FFPROBE_PATH`.
5. Run `npm install` then `npm start`.
6. Deploy as a Render Web Service, not a static site.

## Important behavior and limitations
- The bot sends the Telegram user ID as `tg_id`, matching the extension's upload request. It does not hardcode one person's ID.
- Jarvis ON sends `encode_video=true`; OFF sends `encode_video=false` to `/upload/`.
- The extension's `/uploaden/` route is used for Enhanced and does not send `encode_video`.
- Actual server encoding percentages are displayed only when the server emits a numeric `percent` in its NDJSON `progress` events. The elapsed timer continues independently.
- The original supplied HTML is retained in `assets/JV-Checker-Downloader-Full-Data.html`; its API workflow is adapted to Telegram messages/buttons. The supplied TikWM HTML exposes `region`, creator/video metadata, standard links and an original-quality task API. It explicitly does not expose browser/phone playback quality. The country restriction reason is not provided by that API.
- FFprobe inspects the downloaded rendition only; it cannot discover all private/server-side TikTok variants.
- The original Luna and FFmpeg method source files are retained.


## TikTok checker/downloader (yt-dlp)

TikWM has been removed. TikTok URLs are now inspected and downloaded by `yt-dlp` running on the JV server. The bot requests JSON metadata from yt-dlp, displays fields that the extractor actually returns, and offers standard (up to 720p when available) and highest-available downloads. The inspect action downloads the highest available rendition and runs the server's FFprobe against that file.

### Install yt-dlp

The included `Dockerfile` installs yt-dlp in a Python virtual environment and sets `YTDLP_PATH` automatically. For a non-Docker deployment, install a current yt-dlp release on the host and set `YTDLP_PATH` to its executable path. Keep yt-dlp updated because TikTok may change its site behavior.

Example local setup:

```bash
python3 -m venv .venv-ytdlp
.venv-ytdlp/bin/pip install -U yt-dlp
YTDLP_PATH="$PWD/.venv-ytdlp/bin/yt-dlp" npm start
```

The metadata shown is limited to what TikTok and the current yt-dlp extractor make available. Region, likes, comments, or other fields may be missing. This is self-hosted software with no paid downloader API quota, but it is not literally unlimited: server CPU, storage, bandwidth, and TikTok access controls still apply.

**Telegram file-transfer note:** this update replaces TikWM with yt-dlp; it does not yet add MTProto. The existing Telegraf Bot API transfer path still has Telegram's standard file-size restrictions.
