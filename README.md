# JV Methods Bot v2.0

## Features
- **Enhanced Method**: Kuronai `POST https://api.kuronaiapp.com/uploaden/`.
- **HD Method**: Luna (the original MP4Patcher adapter) or Jarvis HQ (`POST /upload/`).
- **Jarvis Optimizer ON/OFF**: maps to the extension's `encode_video=true/false` multipart field.
- **Live Jarvis status**: displays elapsed time and server-reported NDJSON progress. If the server does not send a percentage, the bot displays a waiting/server-working status rather than inventing one.
- **Alpha**: replaces the old FFmpeg menu option. It creates a 720p WMV2/WMAV2 output at 18 Mbps by default, with optional timestamp FPS patching to 30 or 60 FPS. It displays estimated output duration and size before starting a patched job.
- **Checker & Downloader**: TikTok URLs are sent to the Netlify backend. The bot shows metadata, provides an Original Download button that submits/polls the existing TikWM original task and sends the resulting MP4 directly into Telegram, and runs FFprobe only when Check Details is tapped. Browser Playback quality buttons are not enabled until the Kuronai Browser Playback resolver source/API is supplied; the TikWM HTML explicitly does not expose those browser streams.

## Deploy
1. Use Node.js 20 or newer.
2. Set `BOT_TOKEN` to your Telegram bot token.
3. Set `XORA_API_KEY` to your private API key.
4. Set `RENDER_EXTERNAL_URL` (automatically provided by Render) or `PUBLIC_URL` to the public HTTPS service URL; Alpha exposes a short-lived, random input URL so the cloud processor can fetch the Telegram upload.
5. Optional: set `ALPHA_VIDEO_BITRATE` (default `18M`, use `15M`–`20M`), `ALPHA_AUDIO_BITRATE` (default `128k`), `ALPHA_JOB_TIMEOUT_MS` (default 900000), `WEBHOOK_SECRET`, `PORT`, `MAX_VIDEO_MB`, or `FFPROBE_PATH`.
6. Set `TIKTOK_API_URL` to your Netlify function URL, for example `https://YOUR-SITE.netlify.app/.netlify/functions/tiktok`, and set `TIKTOK_API_SECRET` to the same value as the backend's `API_SECRET`.
7. Run `npm install` then `npm start`.
8. Set `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and a long random `ADMIN_TOKEN` in Render Environment. These are required for persistent maintenance controls.
8. Deploy as a Render Web Service, not a static site.

## Maintenance dashboard
- Open `https://YOUR-RENDER-SERVICE.onrender.com/maintenance?token=YOUR_ADMIN_TOKEN`.
- Toggle Enhanced, Jarvis, Luna, or Alpha ON/OFF. ON blocks new processing and displays an under-maintenance message; OFF re-enables the method.
- Settings are stored in Upstash Redis under `jv-methods:maintenance:v1`, so they survive Render spin-downs, restarts, and redeployments.
- Keep `ADMIN_TOKEN` private. Use a long random value and do not commit your real `.env` file.

## Alpha setup
- Add `XORA_API_KEY` in Render Environment. The bot sends the Telegram upload to a short-lived, random HTTPS endpoint on this service, submits a custom FFmpeg job, polls until it finishes, downloads the WMV output, and sends it back.
- Alpha uses WMV2 video, WMAV2 audio, 720p scaling, and an 18 Mbps default video bitrate (configurable from 15M to 20M). FPS patching uses the source FPS divided by the selected target FPS as the `-itsscale` factor. The estimate shown is approximate; actual size varies with encoder output.

## Telegram delivery (v2.1 fix)
- **Upload path:** processed videos are sent to the Bot API with Node's native `fetch` + `FormData`. This is a normal `Content-Length` upload (what `curl -F video=@file.mp4` sends) instead of Telegraf's chunked stream, which Telegram was dropping with `socket hang up`. Up to 4 attempts with backoff (honours Telegram's `retry_after`), then the unchanged MP4 is sent as a document.
- **Progress message:** the live "Server encoding / Stage" updater now stops the moment the server job finishes, so it no longer overwrites "Sending processed video to Telegram…".
- **Background jobs:** processing runs outside the webhook handler, so Telegraf's 90 s handler timeout can no longer print "Something went wrong" while the job is still working.
- **Token safety:** error text shown to users is scrubbed of the bot token (Telegram library errors embed `.../bot<TOKEN>/method`).
- Optional env `TELEGRAM_API_ROOT` points the bot at a self-hosted Bot API server; `TELEGRAM_UPLOAD_TIMEOUT_MS` (default 600000) caps one upload attempt.

## Checker & Downloader / TikWM (v2.1 fix)
- TikWM answered the bot's bare Node request with `HTTP 403` (it works in a browser, which is why the supplied HTML works). Every TikWM call now sends browser-like headers (User-Agent, Origin, Referer), tries `www.tikwm.com` then `tikwm.com`, retries once on TikWM's 1-request/second limit, and gives a readable error for block pages. Downloads from tikwm.com use the same headers, and relative TikWM links are made absolute so Telegram buttons accept them.
- If your host's **IP address** is blocked, headers cannot help. The bot log shows the real reason (`[tikwm] https://www.tikwm.com/api -> HTTP 403 …`). Then either wait/redeploy to a different region, or run `tools/tikwm-relay-worker.js` as a Cloudflare Worker and set `TIKWM_API_BASE=https://<worker>.workers.dev` (comma-separate several bases to try them in order).

## Important behavior and limitations
- The bot sends the Telegram user ID as `tg_id`, matching the extension's upload request. It does not hardcode one person's ID.
- Jarvis ON sends `encode_video=true`; OFF sends `encode_video=false` to `/upload/`.
- The extension's `/uploaden/` route is used for Enhanced and does not send `encode_video`.
- Actual server encoding percentages are displayed only when the server emits a numeric `percent` in its NDJSON `progress` events. The elapsed timer continues independently.
- The original supplied HTML is retained in `assets/JV-Checker-Downloader-Full-Data.html`; its API workflow is adapted to Telegram messages/buttons. The supplied TikWM HTML exposes `region`, creator/video metadata, standard links and an original-quality task API. It does not expose Browser Playback stream variants. The country restriction reason is not provided by that API. The uploaded Kuronai project files in this deployment bundle contain the enhancement upload route reference, not the Browser Playback extraction implementation.
- FFprobe inspects the downloaded rendition only; it cannot discover all private/server-side TikTok variants.
- The original Luna method source is retained. The old FFmpeg method has been removed from the method menu and replaced by Alpha.
