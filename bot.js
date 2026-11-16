// JV Methods Bot — Enhanced / HD (Luna + Jarvis) / FFmpeg
// Requires Node.js 18+. Kuronai routes and payloads are taken from the supplied extension.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { downloadTelegramMessage, uploadTelegramVideo, startTelegramTransfer, stopTelegramTransfer } = require('./telegram-transfer');
const { execFile } = require('child_process');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
const WEBHOOK_PATH = `/webhook/${process.env.WEBHOOK_SECRET || 'jv-bot'}`;
const METHODS_DIR = path.join(__dirname, 'methods');
const WORK_DIR = path.join(os.tmpdir(), 'jv_bot_work');
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 200);
const KURONAI_API = 'https://api.kuronaiapp.com';
const FFMPEG = process.env.FFMPEG_PATH || (require('ffmpeg-static') || 'ffmpeg');
const FFPROBE_PKG = require('ffprobe-static');
const FFPROBE = process.env.FFPROBE_PATH || (FFPROBE_PKG && FFPROBE_PKG.path) || 'ffprobe';

if (!BOT_TOKEN) { console.error('Set BOT_TOKEN environment variable.'); process.exit(1); }
if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
  console.error('Node.js 18 or newer is required (native fetch/FormData/Blob).'); process.exit(1);
}
fs.mkdirSync(WORK_DIR, { recursive: true });

const bot = new Telegraf(BOT_TOKEN);
const pendingVideos = new Map();
const busyUsers = new Set();
const METHODS = {
  enhanced: { label: '🟢 Enhanced Method', route: '/uploaden/' },
  luna: { label: '🌙 Luna (MP4Patcher)' },
  jarvis: { label: '⚠️ Jarvis (Kuronai HQ)' },
  ffmpeg: { label: '🧰 FFmpeg Method' },
};

function userDir(userId) {
  const dir = path.join(WORK_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function safeName(name) { return path.basename(name || 'video.mp4').replace(/[^\w.() -]/g, '_').slice(0, 100) || 'video.mp4'; }
function tempPath(userId, prefix, ext = '.mp4') {
  return path.join(userDir(userId), `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`);
}
function loadMethod(file) {
  const p = path.join(METHODS_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`Missing methods/${file}`);
  delete require.cache[require.resolve(p)];
  const mod = require(p);
  if (!mod || typeof mod.process !== 'function') throw new Error(`${file} must export process(inputPath, outputPath)`);
  return mod;
}
function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2,'0')}:${String(Math.floor((s % 3600) / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}
async function editProgress(ctx, messageId, text, force = false) {
  const now = Date.now();
  if (!force && ctx.__lastProgressEdit && now - ctx.__lastProgressEdit < 1100) return;
  ctx.__lastProgressEdit = now;
  try { await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text); } catch (_) {}
}
async function telegramDownload(ctx, file, userId) {
  const ext = path.extname(file.file_name || '') || '.mp4';
  const inputPath = tempPath(userId, 'input', ext);
  try {
    const bytes = await downloadTelegramMessage(ctx.chat.id, ctx.message.message_id, inputPath);
    if (bytes > MAX_VIDEO_MB * 1024 * 1024) throw new Error(`Video exceeds ${MAX_VIDEO_MB} MB limit.`);
    return inputPath;
  } catch (err) {
    await fs.promises.unlink(inputPath).catch(() => {});
    throw err;
  }
}
async function sendVideoFile(ctx, filePath, caption) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.size) throw new Error('Cannot upload an empty video file.');
  if (stat.size > MAX_VIDEO_MB * 1024 * 1024) throw new Error(`Output exceeds the configured ${MAX_VIDEO_MB} MB limit.`);
  await uploadTelegramVideo(ctx.chat.id, filePath, caption, ctx.message && ctx.message.message_thread_id);
}

async function streamResponseToFile(response, outputPath, maxBytes = MAX_VIDEO_MB * 1024 * 1024, onProgress) {
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error(`File exceeds ${MAX_VIDEO_MB} MB limit.`);
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new Error(`File exceeds ${MAX_VIDEO_MB} MB limit.`));
      if (onProgress && declared) onProgress(Math.round(received / declared * 100));
      callback(null, chunk);
    }
  });
  await pipeline(response.body, limiter, fs.createWriteStream(outputPath));
  if (!received) throw new Error('The downloaded file is empty.');
  return received;
}

// Kuronai upload protocol copied from inject.js:
// POST /uploaden/ for Enhanced; POST /upload/ for HQ; multipart file/tg_id/progress;
// /upload/ additionally receives encode_video=true|false. Response may be NDJSON progress.
async function kuronaiUpload(inputPath, telegramId, route, encodeVideo, onProgress) {
  const FormData = require('form-data');
  const https = require('https');
  const form = new FormData();
  form.append('file', fs.createReadStream(inputPath), { filename: safeName(path.basename(inputPath)), contentType: 'video/mp4' });
  form.append('tg_id', String(telegramId));
  form.append('progress', 'true');
  if (route === '/upload/') form.append('encode_video', String(Boolean(encodeVideo)));

  const response = await new Promise((resolve, reject) => {
    const req = https.request(KURONAI_API + route, {
      method: 'POST',
      headers: form.getHeaders(),
      timeout: 15 * 60 * 1000,
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Kuronai upload timed out.')));
    form.on('error', reject);
    form.pipe(req);
  });
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw new Error('Kuronai response exceeded 2 MB.');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (response.statusCode < 200 || response.statusCode >= 300) {
    let detail = '';
    try { const j = JSON.parse(body); detail = j.detail || j.message || ''; } catch (_) {}
    throw new Error(detail || `Kuronai upload failed (HTTP ${response.statusCode}).`);
  }
  const contentType = String(response.headers['content-type'] || '');
  let result = null;
  if (contentType.includes('application/x-ndjson')) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (_) { continue; }
      if (event.type === 'error') throw new Error(event.message || event.code || 'Kuronai server processing failed.');
      if (event.type === 'progress' && onProgress) onProgress(event);
      if (event.type === 'complete') result = event;
    }
  } else {
    try { result = JSON.parse(body); } catch (_) { throw new Error('Kuronai returned invalid JSON.'); }
  }
  if (!result || typeof result.file_id !== 'string' || !result.file_id) throw new Error('Kuronai response did not contain a file_id.');
  return result.file_id;
}
async function kuronaiDownload(fileId, outputPath, onProgress) {
  const response = await fetch(`${KURONAI_API}/download/${encodeURIComponent(fileId)}`);
  return streamResponseToFile(response, outputPath, MAX_VIDEO_MB * 1024 * 1024, onProgress);
}
async function kuronaiCleanup(fileId) {
  try { await fetch(`${KURONAI_API}/cleanup/${encodeURIComponent(fileId)}`, { method: 'DELETE' }); } catch (_) {}
}

async function runKuronai(ctx, pending, mode, encodeVideo) {
  const enhanced = mode === 'enhanced';
  const route = enhanced ? '/uploaden/' : '/upload/';
  const title = enhanced ? 'Enhanced Method' : 'Jarvis HQ Method';
  const started = Date.now();
  const status = await ctx.reply(`⚙️ ${title}\nPreparing upload…\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON' : 'OFF')}\nServer encoding: waiting for server…\nElapsed: 00:00:00`);
  let fileId;
  let outputPath;
  let lastPercent = null;
  let lastStage = 'Uploading';
  const timer = setInterval(() => {
    const pct = lastPercent === null ? 'Waiting for server progress' : `${lastPercent}%`;
    editProgress(ctx, status.message_id, `⚙️ ${title}\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON' : 'OFF')}\nServer encoding: ${pct}\nStage: ${lastStage}\nElapsed: ${fmtTime(Date.now() - started)}`).catch(() => {});
  }, 3000);
  try {
    fileId = await kuronaiUpload(pending.inputPath, ctx.from.id, route, encodeVideo, (event) => {
      if (Number.isFinite(Number(event.percent))) lastPercent = Math.max(0, Math.min(100, Math.round(Number(event.percent))));
      if (event.stage || event.step) lastStage = String(event.stage || event.step).slice(0, 50);
      const pct = lastPercent === null ? 'Server working' : `${lastPercent}%`;
      editProgress(ctx, status.message_id, `⚙️ ${title}\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON' : 'OFF')}\nServer encoding: ${pct}\nStage: ${lastStage}\nElapsed: ${fmtTime(Date.now() - started)}`).catch(() => {});
    });
    await editProgress(ctx, status.message_id, `⬇️ ${title}\nServer processing complete. Downloading result…\nElapsed: ${fmtTime(Date.now() - started)}`, true);
    outputPath = tempPath(ctx.from.id, enhanced ? 'enhanced_result' : 'jarvis_result', '.mp4');
    await kuronaiDownload(fileId, outputPath, (percent) => {
      editProgress(ctx, status.message_id, `⬇️ ${title}\nDownloading result: ${percent}%\nElapsed: ${fmtTime(Date.now() - started)}`).catch(() => {});
    });
    await editProgress(ctx, status.message_id, '📤 Sending processed video to Telegram…', true);
    await sendVideoFile(ctx, outputPath, `✅ ${title} complete\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON — re-encode requested' : 'OFF — re-encode disabled')}`);
    await fs.promises.unlink(outputPath).catch(() => {});
    await editProgress(ctx, status.message_id, `✅ ${title} completed\nElapsed: ${fmtTime(Date.now() - started)}`, true);
    pendingVideos.delete(ctx.from.id);
    await fs.promises.unlink(pending.inputPath).catch(() => {});
  } finally {
    clearInterval(timer);
    if (fileId) await kuronaiCleanup(fileId);
    if (outputPath) await fs.promises.unlink(outputPath).catch(() => {});
  }
}

async function runLocalMethod(ctx, pending, methodKey, options = {}) {
  const userId = ctx.from.id;
  const outputPath = tempPath(userId, `out_${methodKey}`, path.extname(pending.inputPath) || '.mp4');
  const status = await ctx.reply(`⚙️ Processing with ${methodKey === 'luna' ? 'Luna (MP4Patcher)' : 'FFmpeg'}…`);
  try {
    const moduleFile = methodKey === 'luna' ? 'c_method.js' : 'ffmpage_method.js';
    const mod = loadMethod(moduleFile);
    let result;
    if (methodKey === 'ffmpeg') result = await mod.process(pending.inputPath, outputPath, options);
    else await mod.process(pending.inputPath, outputPath);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new Error('The method did not produce a valid output file.');
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '📤 Uploading processed video…');
    const caption = methodKey === 'ffmpeg'
      ? `✅ FFmpeg method completed\nSource FPS: ${result.sourceFps.toFixed(3)}\nSelected FPS: ${result.targetFps}\nTimestamp scale: ${result.scaleFactor.toFixed(4)}x\nMode: stream copy (no re-encoding)`
      : '✅ Luna MP4Patcher completed';
    await sendVideoFile(ctx, outputPath, caption);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '✅ Processing complete.');
    pendingVideos.delete(userId);
    await fs.promises.unlink(pending.inputPath).catch(() => {});
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Processing failed: ${err.message}`).catch(() => {});
    throw err;
  } finally { await fs.promises.unlink(outputPath).catch(() => {}); }
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Enhanced Method', 'method:enhanced')],
    [Markup.button.callback('⚠️ HD Method', 'menu:hd')],
    [Markup.button.callback('🧰 FFmpeg Method', 'menu:ffmpeg')],
  ]);
}
function hdKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🌙 Luna — MP4Patcher', 'method:luna')],
    [Markup.button.callback('⚠️ Jarvis — Kuronai HQ', 'menu:jarvis')],
    [Markup.button.callback('⬅️ Back', 'menu:main')],
  ]);
}
function optimizerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Optimizer ON (re-encode)', 'jarvis:optimizer:on')],
    [Markup.button.callback('⚪ Optimizer OFF (no re-encode)', 'jarvis:optimizer:off')],
    [Markup.button.callback('⬅️ Back', 'menu:hd')],
  ]);
}
function ffmpegKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('30 FPS', 'ffmpeg:fps:30'), Markup.button.callback('60 FPS', 'ffmpeg:fps:60')],
    [Markup.button.callback('⬅️ Back', 'menu:main')],
  ]);
}

bot.start((ctx) => ctx.reply('👋 JV Methods Bot\n\nSend a video to process it.', mainKeyboard()));
bot.help((ctx) => ctx.reply('Send a video, then choose Enhanced, HD (Luna/Jarvis), or FFmpeg.'));

bot.on(['video', 'document'], async (ctx) => {
  const file = ctx.message.video || ctx.message.document;
  if (!file || (ctx.message.document && !(file.mime_type || '').startsWith('video/'))) return;
  const sizeMB = (file.file_size || 0) / 1048576;
  if (sizeMB > MAX_VIDEO_MB) return ctx.reply(`⚠️ Video is ${sizeMB.toFixed(1)} MB. Maximum is ${MAX_VIDEO_MB} MB.`);
  const oldPending = pendingVideos.get(ctx.from.id);
  if (oldPending && oldPending.inputPath) await fs.promises.unlink(oldPending.inputPath).catch(() => {});
  const status = await ctx.reply('📥 Downloading your video…');
  try {
    const inputPath = await telegramDownload(ctx, file, ctx.from.id);
    pendingVideos.set(ctx.from.id, { inputPath, fileName: safeName(file.file_name || 'video.mp4') });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '✅ Video received. Choose a method:', mainKeyboard());
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Download failed: ${err.message}`).catch(() => {});
  }
});

bot.action('menu:main', async (ctx) => { await ctx.answerCbQuery(); return ctx.editMessageText('Choose a method:', mainKeyboard()); });
bot.action('menu:hd', async (ctx) => { await ctx.answerCbQuery(); return ctx.editMessageText('⚠️ HD METHOD\nChoose a processing engine:', hdKeyboard()); });
bot.action('menu:jarvis', async (ctx) => { await ctx.answerCbQuery(); return ctx.editMessageText('⚠️ JARVIS — HQ METHOD\n\nVideo Optimization\nChoose whether Kuronai should re-encode the video:', optimizerKeyboard()); });
bot.action('menu:ffmpeg', async (ctx) => { await ctx.answerCbQuery(); return ctx.editMessageText('🎞 FFmpeg Method\nChoose target FPS:', ffmpegKeyboard()); });
async function getPending(ctx) {
  const p = pendingVideos.get(ctx.from.id);
  if (!p || !p.inputPath || !fs.existsSync(p.inputPath)) {
    await ctx.reply('⚠️ Please send a video first, then choose the method.');
    return null;
  }
  return p;
}
async function withBusy(ctx, fn) {
  const id = ctx.from.id;
  if (busyUsers.has(id)) { await ctx.reply('⏳ You already have a processing task running.'); return; }
  busyUsers.add(id);
  try { await fn(); } catch (err) { console.error(err); await ctx.reply(`❌ ${err.message || 'Operation failed.'}`).catch(() => {}); }
  finally { busyUsers.delete(id); }
}
bot.action('method:enhanced', async (ctx) => {
  await ctx.answerCbQuery();
  return withBusy(ctx, async () => { const p = await getPending(ctx); if (p) await runKuronai(ctx, p, 'enhanced', false); });
});
bot.action('method:luna', async (ctx) => {
  await ctx.answerCbQuery();
  return withBusy(ctx, async () => { const p = await getPending(ctx); if (p) await runLocalMethod(ctx, p, 'luna'); });
});
bot.action(/^jarvis:optimizer:(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return withBusy(ctx, async () => { const p = await getPending(ctx); if (p) await runKuronai(ctx, p, 'jarvis', ctx.match[1] === 'on'); });
});
bot.action(/^ffmpeg:fps:(30|60)$/, async (ctx) => {
  const fps = Number(ctx.match[1]); await ctx.answerCbQuery();
  return withBusy(ctx, async () => { const p = await getPending(ctx); if (p) await runLocalMethod(ctx, p, 'ffmpeg', { targetFps: fps }); });
});

bot.catch((err, ctx) => {
  console.error('[bot] Unhandled update error:', err && err.stack ? err.stack : err);
  if (ctx) ctx.reply(`❌ Operation failed: ${(err && err.message ? err.message : 'Unknown error').slice(0, 700)}`).catch(() => {});
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'JV Methods Bot' }));
app.use(bot.webhookCallback(WEBHOOK_PATH));
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Listening on ${PORT}`);
  try { await startTelegramTransfer(); }
  catch (err) { console.error('[mtproto] Startup failed:', err.stack || err); process.exit(1); }
  if (PUBLIC_URL) {
    try { await bot.telegram.setWebhook(`${PUBLIC_URL}${WEBHOOK_PATH}`); console.log('[bot] Webhook registered.'); }
    catch (err) { console.error('[bot] Webhook registration failed:', err.message); }
  } else {
    console.warn('[bot] PUBLIC_URL / RENDER_EXTERNAL_URL missing. Set it for webhook deployment.');
  }
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'How to use the bot' }
  ]);
});

async function shutdown(signal) {
  console.log(`[server] ${signal} received; shutting down.`);
  try { await stopTelegramTransfer(); } catch (_) {}
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
