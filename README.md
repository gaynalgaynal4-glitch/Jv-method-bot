# JV Methods Bot — Node.js / Render edition

## Deploy on Render

1. Push this folder to a GitHub repo
2. Render dashboard → **New → Web Service** → connect the repo
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. **Environment variables:**
   - `BOT_TOKEN` — your token from @BotFather
   - `WEBHOOK_SECRET` — any random string (e.g. `a1b2c3d4`) — keeps your webhook URL private
   - `RENDER_EXTERNAL_URL` — Render sets this automatically, you don't need to add it
   - `FFMPEG_PATH` / `FFPROBE_PATH` — optional overrides; normally the bundled binaries are used
6. Deploy. On startup the bot automatically registers its webhook with Telegram — no manual `setWebhook` call needed.

Add an **UptimeRobot** monitor pinging `https://your-app.onrender.com/` every 5 minutes to reduce cold-start delay — same as your other Render services.

## Local testing

Render sets `RENDER_EXTERNAL_URL` for you, but locally there's no public URL, so set one with a tunnel (e.g. `ngrok http 3000`) and pass it in:

```bash
npm install
export BOT_TOKEN="123456:ABC-your-token"
export PUBLIC_URL="https://your-ngrok-url.ngrok-free.app"
npm start
```

## Commands

The bot registers these in Telegram's `/` menu automatically on startup:

| Command  | What it does                                  |
|----------|------------------------------------------------|
| `/start` | Greeting + quick instructions                  |
| `/help`  | Step-by-step usage guide                        |

Add more by editing the `bot.start(...)` / `bot.help(...)` handlers in `bot.js`, and adding the command to the `setMyCommands` list at the bottom of the file so it shows up in the menu.

## Adding your real processing logic

Each method exports an async `process(inputPath, outputPath, options)` function. Throw an `Error` on failure — the bot catches it and reports the problem.

Current methods:
- `methods/jv60fps_method.js` — FFmpeg 60 FPS re-encoding example.
- `methods/c_method.js` — existing MP4 patcher method.
- `methods/ffmpage_method.js` — detects source FPS, asks the user to choose 30 or 60 FPS, calculates `sourceFPS / targetFPS`, then uses FFmpeg `-itsscale` with `-c copy`. It does not re-encode the video or audio. The timestamp scale changes playback duration; it does not synthesize or discard encoded frames.

`ffmpeg-static` and `ffprobe-static` are installed as npm dependencies so the ffm-page method has FFmpeg and FFprobe binaries on Render without requiring a system-level FFmpeg installation. Set `FFMPEG_PATH` or `FFPROBE_PATH` only if you want to override the bundled binaries.

## Notes

- **File size limit:** Telegram's public Bot API caps downloads at 20MB regardless of what `MAX_VIDEO_MB` says — raise `MAX_VIDEO_MB` only if you're running a local Bot API server.
- **Webhook vs polling:** this bot uses webhook mode (`bot.webhookCallback`), not `bot.launch()` polling — that's what makes it work properly on Render's free tier, since a sleeping service just means Telegram waits a few seconds for the next webhook delivery instead of losing updates like polling would.
- **FFmpeg on Render:** this project bundles FFmpeg/FFprobe through `ffmpeg-static` and `ffprobe-static` for the ffm-page method. The JV-60fps method still invokes the `ffmpeg` command from PATH; set up `FFMPEG_PATH` or update that method if you also want it to use the bundled binary.
