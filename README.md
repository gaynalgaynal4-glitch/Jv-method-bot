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

Each file in `methods/` must export:

```js
async function process(inputPath, outputPath) {
  // read inputPath, write finished video to outputPath
}
module.exports = { process };
```

Throw an `Error` on failure — the bot catches it and shows the message to the user automatically.

Currently:
- `methods/jv60fps_method.js` — real working ffmpeg 60fps example
- `methods/c_method.js` / `methods/ffmpage_method.js` — placeholders that copy the file; replace with your real logic

## Notes

- **File size limit:** Telegram's public Bot API caps downloads at 20MB regardless of what `MAX_VIDEO_MB` says — raise `MAX_VIDEO_MB` only if you're running a local Bot API server.
- **Webhook vs polling:** this bot uses webhook mode (`bot.webhookCallback`), not `bot.launch()` polling — that's what makes it work properly on Render's free tier, since a sleeping service just means Telegram waits a few seconds for the next webhook delivery instead of losing updates like polling would.
- **FFmpeg on Render:** the free Render Node environment does **not** include `ffmpeg` by default. If `jv60fps_method.js` needs it, add a `render-build.sh` that installs it, or switch to a Docker-based Web Service with ffmpeg baked into the image — ask if you want that set up.
