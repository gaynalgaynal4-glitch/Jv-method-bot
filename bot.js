// ── JV Methods Bot — Render webhook edition ─────────────────────────────
//
// Flow:
//   1. User sends a video
//   2. Bot downloads it, shows an inline menu: JV-60fps / C method / ffm-page method
//   3. User taps a button
//   4. Bot runs the matching script from methods/ with (inputPath, outputPath)
//   5. Bot sends the processed video back
//
// Render setup:
//   - Deploy as a Web Service (not a background worker — needs an HTTP port)
//   - Env vars: BOT_TOKEN, RENDER_EXTERNAL_URL (Render sets this automatically)
//   - Render free tier sleeps after 15 min idle — webhook mode handles that
//     fine (Telegram just waits a few seconds for your server to wake up).
//     Add an UptimeRobot ping on "/" every 5 min to avoid most cold starts.

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

// ── Config ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT      = process.env.PORT || 3000;

// Render gives you this automatically; locally you can hardcode a tunnel URL for testing
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;

const WEBHOOK_PATH   = `/webhook/${process.env.WEBHOOK_SECRET || 'jv-bot'}`;
const METHODS_DIR    = path.join(__dirname, 'methods');
const WORK_DIR       = path.join(os.tmpdir(), 'jv_bot_work');
const MAX_VIDEO_MB   = 50;

if (!BOT_TOKEN) {
  console.error('❌ Set BOT_TOKEN env var first.');
  process.exit(1);
}
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ── Method registry ───────────────────────────────────────────────────
// key          = unique callback id used in the button
// label        = what the user sees on the button
// moduleFile   = file inside methods/ that exports process(inputPath, outputPath)
const METHODS = {
  jv60fps: { label: '⚡ JV-60fps',       moduleFile: 'jv60fps_method.js' },
  cmethod: { label: '🎬 C method',       moduleFile: 'c_method.js' },
  ffmpage: { label: '🧩 ffm-page method', moduleFile: 'ffmpage_method.js' },
};

function loadMethod(key) {
  const info = METHODS[key];
  if (!info) throw new Error('Unknown method key: ' + key);
  const filePath = path.join(METHODS_DIR, info.moduleFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Method script not found: methods/${info.moduleFile}\n` +
      `Create it with: module.exports.process = async (inputPath, outputPath) => { ... }`
    );
  }
  delete require.cache[require.resolve(filePath)]; // allow live edits during dev
  const mod = require(filePath);
  if (typeof mod.process !== 'function') {
    throw new Error(`methods/${info.moduleFile} must export an async process(inputPath, outputPath) function`);
  }
  return mod;
}

// In-memory per-user pending video (simple Map — fine for a single bot instance)
const pendingVideos = new Map(); // key: telegram userId -> { inputPath }

// ── Bot ────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    "👋 Send me a video and I'll show you processing methods to choose from.\n\n" +
    "Commands:\n" +
    "/start — show this message\n" +
    "/help — how to use this bot"
  );
});

bot.help((ctx) => {
  ctx.reply(
    "📖 How to use:\n" +
    "1. Send a video (as a video or file)\n" +
    "2. Tap one of the method buttons\n" +
    "3. Wait — I'll send the processed video back when it's done"
  );
});

// Handle incoming videos (and documents that are videos)
bot.on(['video', 'document'], async (ctx) => {
  const file = ctx.message.video || ctx.message.document;
  if (!file) return;

  if (ctx.message.document && !(file.mime_type || '').startsWith('video/')) {
    return; // ignore non-video documents
  }

  const sizeMB = (file.file_size || 0) / (1024 * 1024);
  if (sizeMB > MAX_VIDEO_MB) {
    return ctx.reply(`⚠️ File is ${sizeMB.toFixed(1)}MB — max supported is ${MAX_VIDEO_MB}MB.`);
  }

  const statusMsg = await ctx.reply('📥 Downloading your video…');

  try {
    const userId  = ctx.from.id;
    const userDir = path.join(WORK_DIR, String(userId));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    const link = await ctx.telegram.getFileLink(file.file_id);
    const ext  = path.extname(file.file_name || '') || '.mp4';
    const inputPath = path.join(userDir, `input_${Date.now()}${ext}`);

    await downloadToFile(link.href, inputPath);

    pendingVideos.set(userId, { inputPath });

    const buttons = Markup.inlineKeyboard(
      Object.entries(METHODS).map(([key, info]) =>
        [Markup.button.callback(info.label, `method:${key}`)]
      )
    );

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      '✅ Video received! Choose a processing method:',
      buttons
    );
  } catch (err) {
    console.error(err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, undefined,
      `❌ Download failed: ${err.message}`
    );
  }
});

// Handle method button taps
bot.action(/^method:(.+)$/, async (ctx) => {
  const key  = ctx.match[1];
  const info = METHODS[key];
  await ctx.answerCbQuery();

  if (!info) return ctx.editMessageText('⚠️ Unknown method.');

  const userId  = ctx.from.id;
  const pending = pendingVideos.get(userId);
  if (!pending || !fs.existsSync(pending.inputPath)) {
    return ctx.editMessageText("⚠️ I don't have your video anymore — please send it again.");
  }

  await ctx.editMessageText(`⚙️ Processing with ${info.label}…`);

  const inputPath  = pending.inputPath;
  const outputPath = path.join(
    path.dirname(inputPath),
    `out_${key}_${crypto.randomBytes(4).toString('hex')}${path.extname(inputPath)}`
  );

  let mod;
  try {
    mod = loadMethod(key);
  } catch (err) {
    return ctx.editMessageText(`❌ Setup error: ${err.message}`);
  }

  try {
    await mod.process(inputPath, outputPath);
  } catch (err) {
    console.error(err);
    return ctx.editMessageText(`❌ Processing failed: ${err.message}`);
  }

  if (!fs.existsSync(outputPath)) {
    return ctx.editMessageText('❌ Method finished but produced no output file.');
  }

  await ctx.editMessageText(`📤 Uploading result (${info.label})…`);

  try {
    await ctx.telegram.sendVideo(
      ctx.chat.id,
      { source: fs.createReadStream(outputPath) },
      { caption: `✅ Done — ${info.label}` }
    );
  } catch (err) {
    console.error(err);
    return ctx.editMessageText(`❌ Upload failed: ${err.message}`);
  } finally {
    fs.unlink(outputPath, () => {});
  }

  try { await ctx.deleteMessage(); } catch (_) {}
  pendingVideos.delete(userId);
});

bot.catch((err, ctx) => {
  console.error('Unhandled bot error:', err);
  try { ctx.reply('❌ Something went wrong.'); } catch (_) {}
});

// ── Download helper ───────────────────────────────────────────────────
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const file  = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ── Express app for webhook + health check ────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'JV Methods Bot' });
});

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Listening on port ${PORT}`);

  if (PUBLIC_URL) {
    const fullWebhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
    try {
      await bot.telegram.setWebhook(fullWebhookUrl);
      console.log(`[bot] Webhook set to ${fullWebhookUrl}`);
    } catch (err) {
      console.error('[bot] Failed to set webhook:', err.message);
    }
  } else {
    console.warn(
      '[bot] PUBLIC_URL / RENDER_EXTERNAL_URL not set — webhook not registered. ' +
      'On Render this is set automatically; locally set PUBLIC_URL to a tunnel URL.'
    );
  }

  // Register the command list shown in Telegram's "/" menu
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help',  description: 'How to use this bot' },
  ]);
});
