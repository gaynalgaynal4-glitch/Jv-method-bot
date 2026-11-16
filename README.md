# JV Methods Bot v2.1

Telegram video processing bot using MTProto for Telegram media downloads and uploads.

## Features retained
- **Enhanced Method** — Kuronai `/uploaden/`.
- **HD Method**
  - **Luna (MP4Patcher)** — original local MP4 patcher adapter.
  - **Jarvis HQ** — Kuronai `/upload/`, with Optimizer ON/OFF.
- **FFmpeg Method** — original timestamp-scaling workflow with 30 FPS or 60 FPS selection.
- Video and video-document uploads are accepted.

The TikTok checker/downloader and all TikTok URL handling have been removed.

## Deploy on Render (Node Web Service)
1. Upload this project to your GitHub repository.
2. Create or update a Render **Web Service** using the repository.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Set these environment variables:
   - `BOT_TOKEN` — token from BotFather.
   - `API_ID` and `API_HASH` — obtain them from https://my.telegram.org.
   - `RENDER_EXTERNAL_URL` — Render normally provides this automatically.
   - `WEBHOOK_SECRET` — long random string.
   - `MAX_VIDEO_MB` — optional, defaults to 200.
5. Deploy. Startup logs should include `[mtproto] Telegram media transfer connected.` and `[bot] Webhook registered.`

## MTProto notes
- Uses GramJS bot authorization with the same `BOT_TOKEN`, plus `API_ID` and `API_HASH`.
- Telegram media is downloaded by retrieving the original message with MTProto and writing it to a temporary file.
- Processed videos are uploaded through MTProto, including files larger than the ordinary Bot API video-upload limit, subject to Telegram's current account/API limits.
- No user session string is required or stored.
- Do not expose `.env` or credentials in Git.

## Validation and limitations
- `npm run check` validates JavaScript syntax for the bot and retained processing modules.
- This is not a live integration test. Real Telegram MTProto authentication, Kuronai API behavior, and FFmpeg processing must be verified after deployment with your credentials and a test video.
- Luna's original MP4Patcher reads the entire MP4 into memory. Large files can therefore use substantial RAM.
- The FFmpeg method copies streams and changes timestamps; it does not re-encode the video.
