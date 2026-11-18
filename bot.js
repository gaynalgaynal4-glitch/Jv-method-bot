// JV Methods Bot — Enhanced / HD (Luna + Jarvis) / FFmpeg / TikTok Checker
// Requires Node.js 18+. Kuronai routes and payloads are taken from the supplied extension.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
const WEBHOOK_PATH = `/webhook/${process.env.WEBHOOK_SECRET || 'jv-bot'}`;
const METHODS_DIR = path.join(__dirname, 'methods');
const WORK_DIR = path.join(os.tmpdir(), 'jv_bot_work');
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 50);
// Required-channel gate. The bot must be an administrator in this channel
// so Telegram can reliably return membership status for other users.
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || '@jv_60fps';
const REQUIRED_CHANNEL_URL = process.env.REQUIRED_CHANNEL_URL || 'https://t.me/jv_60fps';
const KURONAI_API = 'https://api.kuronaiapp.com';
// Optional: point at a self-hosted Telegram Bot API server (lifts the 50 MB upload limit).
const TELEGRAM_API_ROOT = (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/$/, '');
// TikWM sits behind bot protection and answers Node's bare default request (User-Agent "node", no Referer)
// with HTTP 403 even though the same call works from a browser. We send browser-like headers and try both hostnames.
// TIKWM_API_BASE may hold one or more comma-separated base URLs (e.g. your own relay) and replaces the defaults.
const TIKWM_HOSTS = (process.env.TIKWM_API_BASE || 'https://www.tikwm.com,https://tikwm.com')
  .split(',').map(h => h.trim().replace(/\/$/, '')).filter(Boolean);
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.tikwm.com',
  Referer: 'https://www.tikwm.com/',
};
const FFMPEG = process.env.FFMPEG_PATH || (require('ffmpeg-static') || 'ffmpeg');
const FFPROBE_PKG = require('ffprobe-static');
const FFPROBE = process.env.FFPROBE_PATH || (FFPROBE_PKG && FFPROBE_PKG.path) || 'ffprobe';

if (!BOT_TOKEN) { console.error('Set BOT_TOKEN environment variable.'); process.exit(1); }
if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
  console.error('Node.js 18 or newer is required (native fetch/FormData/Blob).'); process.exit(1);
}
fs.mkdirSync(WORK_DIR, { recursive: true });

// Never show the bot token to users. Network errors from Telegram libraries embed the full
// request URL (".../bot<TOKEN>/sendVideo"), so every user-visible error goes through this.
function scrub(value) {
  return String(value == null ? '' : value)
    .split(BOT_TOKEN).join('[bot-token]')
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot[token]');
}

const bot = new Telegraf(BOT_TOKEN, {
  // Long jobs now run in the background (see withBusy), but never let Telegraf abort a handler at its 90 s default.
  handlerTimeout: 30 * 60 * 1000,
  // Fresh connection per API call: a pooled keep-alive socket that Telegram already closed is a classic "socket hang up".
  telegram: { agent: new https.Agent({ keepAlive: false }), apiRoot: TELEGRAM_API_ROOT },
});
const pendingVideos = new Map();
const busyUsers = new Set();

// Check membership on every interaction. The explicit check button bypasses
// this middleware so users can re-check after joining.
bot.use(async (ctx, next) => {
  if (!ctx.from || (ctx.callbackQuery && ctx.callbackQuery.data === 'membership:check')) {
    return next();
  }
  try {
    const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, ctx.from.id);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status)
      || (member.status === 'restricted' && member.is_member === true);
    if (isMember) return next();
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('📢 Join JV-60FPS Channel', REQUIRED_CHANNEL_URL)],
      [Markup.button.callback('✅ I Joined — Check Again', 'membership:check')],
    ]);
    const message = '🔒 Channel Membership Required\n\nPlease join our channel first to use this bot. After joining, tap “I Joined — Check Again”.';
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Please join the required channel first.', { show_alert: true }).catch(() => {});
      await ctx.reply(message, keyboard).catch(() => {});
    } else {
      await ctx.reply(message, keyboard).catch(() => {});
    }
  } catch (err) {
    console.error('[membership] Could not verify channel membership:', err.message);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('📢 Open JV-60FPS Channel', REQUIRED_CHANNEL_URL)],
      [Markup.button.callback('🔄 Try Again', 'membership:check')],
    ]);
    await ctx.reply(
      '⚠️ I could not verify your channel membership. Please try again in a moment. If this keeps happening, the bot administrator must add this bot as an administrator to @jv_60fps.',
      keyboard
    ).catch(() => {});
  }
});
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
  try { await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, scrub(text)); } catch (_) {}
}
function mediaHeaders(url) {
  try { return /(^|\.)tikwm\.com$/i.test(new URL(url).hostname) ? BROWSER_HEADERS : {}; } catch (_) { return {}; }
}
async function downloadToFile(url, destPath, maxBytes = MAX_VIDEO_MB * 1024 * 1024) {
  const response = await fetch(url, { redirect: 'follow', headers: mediaHeaders(url) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error(`File exceeds ${MAX_VIDEO_MB} MB limit.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('The downloaded file is empty.');
  if (buffer.length > maxBytes) throw new Error(`File exceeds ${MAX_VIDEO_MB} MB limit.`);
  await fs.promises.writeFile(destPath, buffer);
  return buffer.length;
}
async function telegramDownload(ctx, file, userId) {
  const ext = path.extname(file.file_name || '') || '.mp4';
  const inputPath = tempPath(userId, 'input', ext);
  if (!SELF_HOSTED && (file.file_size || 0) > 20 * 1048576) throw new Error('Telegram only lets bots download videos up to 20 MB. Send a smaller video.');
  const info = await ctx.telegram.getFile(file.file_id);
  // A local-mode Bot API server returns an absolute path on its own disk.
  if (info.file_path && path.isAbsolute(info.file_path)) { await fs.promises.copyFile(info.file_path, inputPath); return inputPath; }
  const link = await ctx.telegram.getFileLink(file.file_id);
  await downloadToFile(link.href, inputPath);
  return inputPath;
}
// ---- Telegram delivery -------------------------------------------------------------
// Files go straight to the Bot API with Node's native fetch + FormData instead of Telegraf's
// streaming multipart. That produces an ordinary Content-Length request (the same thing
// `curl -F video=@file.mp4` sends) rather than a chunked stream, which is what Telegram's
// edge was dropping with "socket hang up". Every attempt builds a brand-new request.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const UPLOAD_TIMEOUT_MS = Number(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS || 10 * 60 * 1000);
// Public Bot API: 49 MB uploads / 20 MB downloads. A self-hosted Bot API server (TELEGRAM_API_ROOT) lifts both to MAX_VIDEO_MB.
const SELF_HOSTED = TELEGRAM_API_ROOT !== 'https://api.telegram.org';
const MAX_UPLOAD_BYTES = (SELF_HOSTED ? MAX_VIDEO_MB : Math.min(MAX_VIDEO_MB, 49)) * 1048576;

async function telegramUploadOnce(method, field, filePath, params) {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
  }
  const bytes = await fs.promises.readFile(filePath);
  form.append(field, new Blob([bytes], { type: 'video/mp4' }), safeName(path.basename(filePath)));

  let response;
  try {
    response = await fetch(`${TELEGRAM_API_ROOT}/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err && err.cause ? (err.cause.code || err.cause.message) : (err && err.name);
    const dropped = new Error(`connection to Telegram dropped during ${method}${detail ? ` (${scrub(detail)})` : ''}`);
    dropped.transient = true;
    throw dropped;
  }
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (response.ok && data && data.ok) return data.result;

  const rejected = new Error(`Telegram rejected ${method}: ${scrub((data && data.description) || `HTTP ${response.status}`)}`);
  rejected.status = response.status;
  rejected.retryAfter = data && data.parameters ? Number(data.parameters.retry_after) || 0 : 0;
  rejected.transient = response.status === 429 || response.status >= 500;
  throw rejected;
}

async function telegramUpload(method, field, filePath, params, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await telegramUploadOnce(method, field, filePath, params);
      return { attempts: attempt };
    } catch (err) {
      lastError = err;
      if (!err.transient || attempt === maxAttempts) break;
      const waitMs = err.retryAfter ? err.retryAfter * 1000 + 500 : attempt * 2500;
      console.warn(`[telegram] ${method} attempt ${attempt}/${maxAttempts} failed (${err.message}); retrying in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
  lastError.attempts = maxAttempts;
  throw lastError;
}

async function sendVideoFile(ctx, filePath, caption) {
  const size = fs.statSync(filePath).size;
  if (!size) throw new Error('The processed output file is empty.');
  if (size > MAX_UPLOAD_BYTES) throw new Error(`Processed video is ${(size / 1048576).toFixed(1)} MB, above this bot's ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB upload limit.`);
  const base = { chat_id: ctx.chat.id, caption: String(caption || '').slice(0, 900) };

  let videoError;
  try {
    const sent = await telegramUpload('sendVideo', 'video', filePath, { ...base, supports_streaming: true });
    return { sentAs: 'video', attempts: sent.attempts };
  } catch (err) { videoError = err; }

  // Bad token / blocked bot / file too large cannot be fixed by sending it another way.
  if (!videoError.transient && videoError.status !== 400) throw new Error(videoError.message);

  // Last resort: deliver the unchanged MP4 as a document.
  try {
    const sent = await telegramUpload('sendDocument', 'document', filePath, base);
    return { sentAs: 'document_fallback', attempts: (videoError.attempts || 1) + sent.attempts };
  } catch (docError) {
    throw new Error(`Telegram could not receive the processed video. Video upload: ${videoError.message}. Document upload: ${docError.message}`);
  }
}

// Kuronai upload protocol copied from inject.js:
// POST /uploaden/ for Enhanced; POST /upload/ for HQ; multipart file/tg_id/progress;
// /upload/ additionally receives encode_video=true|false. Response may be NDJSON progress.
async function kuronaiUpload(inputPath, telegramId, route, encodeVideo, onProgress) {
  const form = new FormData();
  // openAsBlob reads from disk lazily, so a 200 MB video does not sit in RAM.
  const blob = typeof fs.openAsBlob === 'function' ? await fs.openAsBlob(inputPath, { type: 'video/mp4' }) : new Blob([await fs.promises.readFile(inputPath)], { type: 'video/mp4' });
  form.append('file', blob, safeName(path.basename(inputPath)));
  form.append('tg_id', String(telegramId));
  form.append('progress', 'true');
  if (route === '/upload/') form.append('encode_video', String(Boolean(encodeVideo)));

  const response = await fetch(KURONAI_API + route, { method: 'POST', body: form });
  if (!response.ok) {
    let detail = '';
    try { const j = await response.json(); detail = j.detail || j.message || ''; } catch (_) {}
    throw new Error(detail || `Kuronai upload failed (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get('content-type') || '';
  let result = null;
  if (contentType.includes('application/x-ndjson') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split('\n'); pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch (_) { continue; }
        if (event.type === 'error') throw new Error(event.message || event.code || 'Kuronai server processing failed.');
        if (event.type === 'progress' && onProgress) onProgress(event);
        if (event.type === 'complete') result = event;
      }
      if (done) break;
    }
    if (pending.trim()) {
      try { const event = JSON.parse(pending); if (event.type === 'progress' && onProgress) onProgress(event); if (event.type === 'complete') result = event; if (event.type === 'error') throw new Error(event.message || event.code); } catch (e) { if (e.message && !e.message.includes('Unexpected')) throw e; }
    }
  } else {
    result = await response.json();
  }
  if (!result || typeof result.file_id !== 'string' || !result.file_id) throw new Error('Kuronai response did not contain a file_id.');
  return result.file_id;
}
async function kuronaiDownload(fileId, outputPath, onProgress) {
  const response = await fetch(`${KURONAI_API}/download/${encodeURIComponent(fileId)}`);
  if (!response.ok || !response.body) throw new Error(`Kuronai result download failed (HTTP ${response.status}).`);
  const total = Number(response.headers.get('content-length') || 0);
  const out = fs.createWriteStream(outputPath);
  let received = 0;
  for await (const chunk of require('stream').Readable.fromWeb(response.body)) {
    received += chunk.length;
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    if (onProgress && total) onProgress(Math.round(received / total * 100));
  }
  await new Promise(r => out.end(r));
  if (!received) throw new Error('Kuronai returned an empty output file.');
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
  let lastPercent = null;
  let lastStage = 'Uploading';
  let processing = true;                 // flips to false the moment the server job is finished
  let inflight = Promise.resolve();      // the last status edit that may still be travelling to Telegram
  const progressText = (pct) => `⚙️ ${title}\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON' : 'OFF')}\nServer encoding: ${pct}\nStage: ${lastStage}\nElapsed: ${fmtTime(Date.now() - started)}`;
  const showProgress = (pct) => { if (processing) inflight = editProgress(ctx, status.message_id, progressText(pct)).catch(() => {}); };
  // Stop live progress for good BEFORE the download / Telegram-upload phases. Previously this timer kept
  // running until the very end and re-wrote "Server encoding … Stage: patching" over the "Sending…" message.
  const stopProgress = async () => { processing = false; clearInterval(timer); await inflight; };
  const timer = setInterval(() => showProgress(lastPercent === null ? 'Waiting for server progress' : `${lastPercent}%`), 3000);
  try {
    fileId = await kuronaiUpload(pending.inputPath, ctx.from.id, route, encodeVideo, (event) => {
      if (Number.isFinite(Number(event.percent))) lastPercent = Math.max(0, Math.min(100, Math.round(Number(event.percent))));
      if (event.stage || event.step) lastStage = String(event.stage || event.step).slice(0, 50);
      showProgress(lastPercent === null ? 'Server working' : `${lastPercent}%`);
    });
    await stopProgress();
    await editProgress(ctx, status.message_id, `⬇️ ${title}\nServer processing complete. Downloading result…\nElapsed: ${fmtTime(Date.now() - started)}`, true);
    const outputPath = tempPath(ctx.from.id, enhanced ? 'enhanced_result' : 'jarvis_result', '.mp4');
    await kuronaiDownload(fileId, outputPath, (percent) => {
      editProgress(ctx, status.message_id, `⬇️ ${title}\nDownloading result: ${percent}%\nElapsed: ${fmtTime(Date.now() - started)}`).catch(() => {});
    });
    await editProgress(ctx, status.message_id, '📤 Sending processed video to Telegram…\nLarge files may take a little while. Automatic retry is enabled.', true);
    const delivery = await sendVideoFile(ctx, outputPath, `✅ ${title} complete\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON — re-encode requested' : 'OFF — re-encode disabled')}`);
    await fs.promises.unlink(outputPath).catch(() => {});
    const deliveryNote = delivery.sentAs === 'document_fallback' ? '\nDelivered as an MP4 document after Telegram video upload retries.' : '';
    await editProgress(ctx, status.message_id, `✅ ${title} completed\nElapsed: ${fmtTime(Date.now() - started)}${deliveryNote}`, true);
    pendingVideos.delete(ctx.from.id);
  } catch (err) {
    await stopProgress();
    await editProgress(ctx, status.message_id, `❌ ${title} delivery failed\n${scrub(err.message || err).slice(0, 1200)}\n\nYour original video is still available. Please try again later.`, true);
    throw err;
  } finally {
    processing = false; clearInterval(timer);
    if (fileId) await kuronaiCleanup(fileId);
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
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Processing failed: ${scrub(err.message)}`).catch(() => {});
    throw err;
  } finally { await fs.promises.unlink(outputPath).catch(() => {}); }
}

// Mini App ("Checker & Downloader") lives on Netlify. It is opened from the chat menu button
// (left of the message box) and from the button the bot shows when a TikTok link is sent.
const MINI_APP_URL = (process.env.MINI_APP_URL || 'https://fastidious-biscochitos-ad7934.netlify.app/').trim();
const WELCOME_IMAGE = path.join(__dirname, 'image1.png');

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

bot.action('membership:check', async (ctx) => {
  await ctx.answerCbQuery('Checking your membership…').catch(() => {});
  try {
    const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, ctx.from.id);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status)
      || (member.status === 'restricted' && member.is_member === true);
    if (!isMember) {
      return ctx.reply('❌ You have not joined @jv_60fps yet. Join the channel, then tap the check button again.', Markup.inlineKeyboard([
        [Markup.button.url('📢 Join JV-60FPS Channel', REQUIRED_CHANNEL_URL)],
        [Markup.button.callback('✅ Check Again', 'membership:check')],
      ]));
    }
    return ctx.reply('✅ Membership verified! You can now use JV Methods Bot.', mainKeyboard());
  } catch (err) {
    console.error('[membership] Recheck failed:', err.message);
    return ctx.reply('⚠️ Could not verify membership. Please try again later. The bot must be an administrator in @jv_60fps.');
  }
});

bot.start(async (ctx) => {
  const text = '👋 Welcome to JV Methods Bot\n\n🎬 Send me a video and choose a processing method.\n🔎 Send a TikTok link (or open the menu button at the left of the chat) for full video details and downloads.';
  if (fs.existsSync(WELCOME_IMAGE)) {
    try { return await ctx.replyWithPhoto({ source: WELCOME_IMAGE }, { caption: text }); } catch (e) { console.warn('[start] image failed:', scrub(e.message)); }
  }
  return ctx.reply(text);
});
bot.help((ctx) => ctx.reply('Send a video, then choose Enhanced, HD (Luna/Jarvis) or FFmpeg. Send a TikTok link, or use the menu button at the left of the chat, for the Checker & Downloader.'));

bot.on(['video', 'document'], async (ctx) => {
  const file = ctx.message.video || ctx.message.document;
  if (!file || (ctx.message.document && !(file.mime_type || '').startsWith('video/'))) return;
  const sizeMB = (file.file_size || 0) / 1048576;
  if (sizeMB > MAX_VIDEO_MB) return ctx.reply(`⚠️ Video is ${sizeMB.toFixed(1)} MB. Maximum is ${MAX_VIDEO_MB} MB.`);
  const status = await ctx.reply('📥 Downloading your video…');
  try {
    const inputPath = await telegramDownload(ctx, file, ctx.from.id);
    pendingVideos.set(ctx.from.id, { inputPath, fileName: safeName(file.file_name || 'video.mp4') });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '✅ Video received. Choose a method:', mainKeyboard());
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Download failed: ${scrub(err.message)}`).catch(() => {});
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
function withBusy(ctx, fn) {
  const id = ctx.from.id;
  if (busyUsers.has(id)) return ctx.reply('⏳ You already have a processing task running.');
  busyUsers.add(id);
  // Run the job in the background and return immediately. Processing takes minutes; if the webhook
  // handler stayed open that long Telegraf would time it out (90 s) and print "Something went wrong"
  // while the job was still working. The job reports its own success or failure to the user.
  (async () => {
    try { await fn(); }
    catch (err) {
      console.error('[task] Operation failed:', scrub(err && err.stack || err));
      await ctx.reply(`❌ ${scrub(err && err.message || 'Operation failed.')}`).catch(() => {});
    } finally { busyUsers.delete(id); }
  })();
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

function validTikTokUrl(value) {
  try { const u = new URL(value); return /(^|\.)tiktok\.com$/i.test(u.hostname); } catch (_) { return false; }
}
async function inspectMedia(filePath) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,bit_rate,avg_frame_rate,r_frame_rate','-show_entries','format=duration,size,bit_rate','-of','json',filePath], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(-1200)));
      try { resolve(JSON.parse(stdout)); } catch (_) { reject(new Error('Could not parse FFprobe media details.')); }
    });
  });
}
bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (!validTikTokUrl(text)) return;
  // The Mini App does the TikWM lookup itself and shows every detail; the bot only hands it the link.
  const url = `${MINI_APP_URL.replace(/\/?$/, '/')}?url=${encodeURIComponent(text)}`;
  return ctx.reply('🔎 TikTok link received.\nTap below to open full details and downloads.', Markup.inlineKeyboard([[Markup.button.webApp('🔎 Open Checker & Downloader', url)]]));
});

bot.catch((err, ctx) => {
  console.error('Bot error:', scrub(err && err.stack || err));
  if (ctx && !ctx.__errorReported) ctx.reply('❌ Something went wrong. Please try again.').catch(() => {});
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'JV Methods Bot' }));
app.use(bot.webhookCallback(WEBHOOK_PATH));
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Listening on ${PORT}`);
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
  // Mini App button at the left of the message box.
  if (/^https:\/\//i.test(MINI_APP_URL)) {
    try { await bot.telegram.callApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Checker', web_app: { url: MINI_APP_URL } } }); }
    catch (err) { console.error('[bot] Menu button failed:', scrub(err.message)); }
  }
});
