# JV Methods Bot v2.1

A Telegraf webhook bot with a separate GramJS MTProto media-transfer client. Existing processing methods and the TikTok checker UI are retained.

## Features

- `/start` and `/help`, existing inline menus and callbacks.
- Enhanced Method using Kuronai `/uploaden/`.
- Luna using the original `methods/c_method.js` MP4Patcher adapter.
- Jarvis HQ using Kuronai `/upload/`, preserving optimizer ON/OFF.
- FFmpeg method using the original timestamp-scaling implementation and 30/60 FPS options.
- TikTok Checker & Downloader using server-side `yt-dlp`; TikWM is not used.
- One configurable maximum video size, defaulting to 200 MB, checked on incoming media, processing inputs/outputs, TikTok downloads, Kuronai outputs and Telegram uploads.
- GramJS MTProto media transfer for incoming message downloads and outgoing video uploads. Telegraf remains responsible for commands, callbacks, webhook updates and the health endpoint.

## Render deployment (recommended: Docker)

Create a Render **Web Service** connected to the repository.

- **Runtime:** Docker
- **Root Directory:** the directory containing this Dockerfile (repository root if the project files are at the root)
- **Build Command:** leave blank; Render builds the Dockerfile
- **Start Command:** leave blank; Dockerfile runs `npm start`
- **Health Check Path:** `/`
- **Environment:** add the variables below in Render's Environment page

Required variables:

- `BOT_TOKEN` — bot token from BotFather
- `API_ID` — Telegram API ID
- `API_HASH` — Telegram API hash
- `MAX_VIDEO_MB` — `200` (optional; 200 is the default)
- `WEBHOOK_SECRET` — long random secret used in the webhook URL path
- `RENDER_EXTERNAL_URL` — Render service public URL if not automatically supplied
- `YTDLP_PATH` — `/opt/yt-dlp-venv/bin/yt-dlp` (already set in the Docker image)

Render supplies `PORT` automatically. Do not set a fixed production port unless you have a specific reason. The service listens on `process.env.PORT`.

The Docker image installs Python 3, a virtual environment, FFmpeg, FFprobe and yt-dlp once. Node dependencies are installed once; there is no Python `postinstall` in `package.json`. `.dockerignore` excludes `.env` from the Docker build context.

## Telegram MTProto transfer

GramJS authenticates as the bot account with `API_ID`, `API_HASH` and `BOT_TOKEN`. It fetches the exact message media by chat ID and message ID and writes it to disk, then sends outputs with `sendFile`. The session is held in memory and can be recreated at startup using the bot token, so no local session file is required across Render redeploys.

The configured 200 MB limit is below Telegram's MTProto large-file upload capability. This does not change the Bot API's ordinary file limits: the code deliberately uses MTProto for the media transfer path. Telegram's server-side limits and account/API policy can still change, so a successful transfer must be confirmed in the deployed bot.

## Security

- Never commit `.env`; it is excluded by `.gitignore` and `.dockerignore`.
- `.env.example` contains variable names and placeholders only.
- GitHub does not automatically transfer a repository's local `.env` values into Render. Add each secret as a Render Environment Variable.
- If the supplied `.env` was committed to a public/shared GitHub repository, revoke/rotate the BotFather token immediately, create replacement Telegram API credentials if the exposed application credentials can be replaced, remove `.env` from Git tracking/history, and redeploy with new Render variables. An API hash should be treated as compromised if exposed.

## Notes and limitations

- TikTok extraction depends on TikTok's availability to the server IP and may fail for region-restricted videos or URLs requiring cookies. The error message retains yt-dlp details.
- The Luna MP4Patcher implementation operates on a complete MP4 byte array; unlike the Kuronai and download/upload paths, that existing algorithm is inherently memory-intensive. It was retained to avoid changing the user's processing algorithm.
- A full Telegram transfer test requires valid live `BOT_TOKEN`, `API_ID` and `API_HASH` values and an actual Telegram chat. These credentials are not included in this project archive.
