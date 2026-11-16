// JV Methods Bot — Enhanced / HD (Luna + Jarvis) / FFmpeg / TikTok Checker
// Requires Node.js 18+. Kuronai routes and payloads are taken from the supplied extension.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
const TIKWM_API = 'https://www.tikwm.com/api/';
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
    const message = '🔒 Channel Membership Required\\n\\nPlease join our channel first to use this bot. After joining, tap “I Joined — Check Again”.';
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
  try { await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text); } catch (_) {}
}
async function downloadToFile(url, destPath, maxBytes = MAX_VIDEO_MB * 1024 * 1024) {
  const response = await fetch(url, { redirect: 'follow' });
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
  const link = await ctx.telegram.getFileLink(file.file_id);
  const ext = path.extname(file.file_name || '') || '.mp4';
  const inputPath = tempPath(userId, 'input', ext);
  await downloadToFile(link.href, inputPath);
  return inputPath;
}
function isTransientTelegramUploadError(err) {
  const message = String(err && (err.message || err) || '').toLowerCase();
  return /socket hang up|econnreset|etimedout|econnrefused|ehostunreach|enotfound|network error|fetch failed|request timeout|timed out|aborted/.test(message);
}

function makeUploadSource(filePath) {
  // Always create a fresh stream for every attempt. A consumed/destroyed stream
  // cannot be safely reused after a network interruption.
  return { source: fs.createReadStream(filePath), filename: safeName(path.basename(filePath)) };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendVideoFile(ctx, filePath, caption) {
  const size = fs.statSync(filePath).size;
  if (!size) throw new Error('The processed output file is empty.');
  if (size > 49 * 1024 * 1024) {
    throw new Error(`Processed video is ${(size / 1048576).toFixed(1)} MB, above this bot's 49 MB upload safety limit.`);
  }

  const options = { caption: String(caption || '').slice(0, 900), supports_streaming: true };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const source = makeUploadSource(filePath);
    try {
      await ctx.telegram.sendVideo(ctx.chat.id, source, options);
      return { sentAs: 'video', attempts: attempt };
    } catch (err) {
      lastError = err;
      if (source.source && !source.source.destroyed) source.source.destroy();
      if (!isTransientTelegramUploadError(err) || attempt === 3) break;
      console.warn(`[telegram] sendVideo attempt ${attempt}/3 failed; retrying:`, err.message);
      await sleep(attempt * 2000);
    }
  }

  // If Telegram's video endpoint repeatedly drops the connection, try one
  // document upload as a delivery fallback. The MP4 remains unchanged.
  if (lastError && isTransientTelegramUploadError(lastError)) {
    const source = makeUploadSource(filePath);
    try {
      await ctx.telegram.sendDocument(ctx.chat.id, source, { caption: options.caption });
      return { sentAs: 'document_fallback', attempts: 4 };
    } catch (fallbackError) {
      if (source.source && !source.source.destroyed) source.source.destroy();
      throw new Error(`Telegram could not receive the processed video after 3 video attempts and a document fallback. Last video error: ${lastError.message}. Document fallback error: ${fallbackError.message}`);
    }
  }
  throw new Error(`Telegram video upload failed: ${lastError ? lastError.message : 'unknown upload error'}`);
}

// Kuronai upload protocol copied from inject.js:
// POST /uploaden/ for Enhanced; POST /upload/ for HQ; multipart file/tg_id/progress;
// /upload/ additionally receives encode_video=true|false. Response may be NDJSON progress.
async function kuronaiUpload(inputPath, telegramId, route, encodeVideo, onProgress) {
  const buffer = await fs.promises.readFile(inputPath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'video/mp4' }), safeName(path.basename(inputPath)));
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
  if (!response.ok) throw new Error(`Kuronai result download failed (HTTP ${response.status}).`);
  const total = Number(response.headers.get('content-length') || 0);
  const reader = response.body.getReader();
  const chunks = []; let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); received += value.length;
    if (onProgress && total) onProgress(Math.round(received / total * 100));
  }
  await fs.promises.writeFile(outputPath, Buffer.concat(chunks));
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
    await editProgress(ctx, status.message_id, `❌ ${title} delivery failed\n${String(err.message || err).slice(0, 1200)}\n\nYour original video is still available. Please try again later.`, true);
    throw err;
  } finally {
    clearInterval(timer);
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
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Processing failed: ${err.message}`).catch(() => {});
    throw err;
  } finally { await fs.promises.unlink(outputPath).catch(() => {}); }
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Enhanced Method', 'method:enhanced')],
    [Markup.button.callback('⚠️ HD Method', 'menu:hd')],
    [Markup.button.callback('🧰 FFmpeg Method', 'menu:ffmpeg')],
    [Markup.button.callback('🔎 Checker & Downloader', 'menu:checker')],
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

bot.start((ctx) => ctx.reply('👋 JV Methods Bot\n\nSend a video to process it, or use Checker & Downloader to inspect a public TikTok URL.', mainKeyboard()));
bot.help((ctx) => ctx.reply('Send a video, then choose Enhanced, HD (Luna/Jarvis), or FFmpeg. For TikTok links choose Checker & Downloader.'));

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
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Download failed: ${err.message}`).catch(() => {});
  }
});

bot.action('menu:main', async (ctx) => { await ctx.answerCbQuery(); return ctx.editMessageText('Choose a method:', mainKeyboard()); });
bot.action('menu:hd', async (ctx) => { await ctx.answerCbQuery(); return ctx.editMessageText('⚠️ HD METHOD\nChoose a processing engine:', hdKeyboard()); });
bot.action('menu:jarvis', async (ctx) => { await ctx.answerCbQuery(); return ctx.editMessageText('⚠️ JARVIS — HQ METHOD\n\nVideo Optimization\nChoose whether Kuronai should re-encode the video:', optimizerKeyboard()); });
bot.action('menu:ffmpeg', async (ctx) => { await ctx.answerCbQuery(); return ctx.editMessageText('🎞 FFmpeg Method\nChoose target FPS:', ffmpegKeyboard()); });
bot.action('menu:checker', async (ctx) => {
  await ctx.answerCbQuery();
  pendingVideos.set(ctx.from.id, { ...(pendingVideos.get(ctx.from.id) || {}), awaitingTikTokUrl: true });
  return ctx.reply('🔎 Checker & Downloader\nSend a public TikTok video URL. I will retrieve available region, creator, video metadata, standard download and original/highest-quality download links.');
});

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
  try { await fn(); } catch (err) {
    ctx.__errorReported = true;
    console.error('[task] Operation failed:', err);
    await ctx.reply(`❌ ${err.message || 'Operation failed.'}`).catch(() => {});
  }
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

// TikWM checker flow adapted from the supplied HTML. The HTML exposes region,
// metadata and download URLs; it does not expose browser/phone playback probing or a country-ban reason.
function validTikTokUrl(value) {
  try { const u = new URL(value); return /(^|\.)tiktok\.com$/i.test(u.hostname); } catch (_) { return false; }
}
function pick(...values) { return values.find(v => v !== undefined && v !== null && v !== ''); }
function prettyNum(v) { return v == null ? 'Unavailable' : Number(v).toLocaleString('en-US'); }
async function tikwmCheck(url) {
  const response = await fetch(TIKWM_API + '?url=' + encodeURIComponent(url), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`TikWM returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || 'TikTok video could not be retrieved.');
  return payload.data;
}
async function tikwmOriginal(url) {
  const submit = await fetch('https://www.tikwm.com/api/video/task/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.tikwm.com/originalDownloader.html' },
    body: 'url=' + encodeURIComponent(url) + '&web=1'
  });
  if (!submit.ok) throw new Error(`Original downloader returned HTTP ${submit.status}`);
  const payload = await submit.json();
  const taskId = payload && payload.data && payload.data.task_id;
  if (payload.code !== 0 || !taskId) throw new Error(payload.msg || 'Could not start original-quality task.');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const response = await fetch('https://www.tikwm.com/api/video/task/result?task_id=' + encodeURIComponent(taskId));
    if (!response.ok) continue;
    const result = await response.json();
    if (result.code === 0 && result.data) {
      const d = result.data.detail || result.data;
      const link = d.play_url || d.download_url || d.play;
      if (link) return link;
      if (['failed', 'error'].includes(result.data.status)) throw new Error('Provider could not create the original file.');
    }
  }
  throw new Error('Original-quality link was not returned in time.');
}
async function inspectMedia(filePath) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,bit_rate,avg_frame_rate,r_frame_rate','-show_entries','format=duration,size,bit_rate','-of','json',filePath], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(-1200)));
      try { resolve(JSON.parse(stdout)); } catch (_) { reject(new Error('Could not parse FFprobe media details.')); }
    });
  });
}
function fpsValue(value) {
  if (!value || value === '0/0') return 'Unavailable';
  const [a,b='1'] = String(value).split('/'); const n = Number(a) / Number(b);
  return Number.isFinite(n) ? n.toFixed(3) : 'Unavailable';
}
async function processTikTokUrl(ctx, url) {
  const status = await ctx.reply('🔎 Checking TikTok URL…');
  try {
    const d = await tikwmCheck(url);
    const video = d.video || {};
    const author = d.author || {};
    const stats = d.statistics || d.stats || {};
    const region = pick(d.region, d.region_code, d.created_region, 'Not provided by TikWM');
    const standard = d.play || d.wmplay || d.hdplay || null;
    const hd = d.hdplay || null;
    const info = [
      '✅ TIKTOK VIDEO FOUND',
      `Title: ${pick(d.title, 'TikTok video')}`,
      `Creator: @${pick(author.unique_id, author.username, 'unknown')}`,
      `Region/Country code: ${region}`,
      `Video ID: ${pick(d.id, d.aweme_id, d.video_id, 'Unavailable')}`,
      '', '📊 STATISTICS',
      `Views: ${prettyNum(pick(d.play_count, stats.play_count, stats.view_count))}`,
      `Likes: ${prettyNum(pick(d.digg_count, d.like_count, stats.digg_count))}`,
      `Comments: ${prettyNum(pick(d.comment_count, stats.comment_count))}`,
      `Shares: ${prettyNum(pick(d.share_count, stats.share_count))}`,
      '', '🎞 VIDEO METADATA (provider data)',
      `Resolution: ${video.width && video.height ? `${video.width} × ${video.height}` : 'Unavailable'}`,
      `Original resolution: ${video.origin_width && video.origin_height ? `${video.origin_width} × ${video.origin_height}` : 'Unavailable'}`,
      `Codec: ${pick(video.codec, video.format, 'Not provided')}`,
      `Bitrate: ${video.bitrate || video.bit_rate ? `${(Number(video.bitrate || video.bit_rate) / 1e6).toFixed(2)} Mbps` : 'Not provided'}`,
      `File size: ${video.size ? `${(Number(video.size) / 1048576).toFixed(2)} MB` : 'Not provided'}`,
      `Duration: ${pick(d.duration, video.duration, 'Not provided')} sec`,
      'Browser/phone playback: Not exposed by TikWM API',
      'Country restriction reason: Not exposed by TikWM API'
    ].join('\n');
    const buttons = [];
    if (standard) buttons.push([Markup.button.url('⬇️ Standard Download', standard)]);
    if (hd) buttons.push([Markup.button.url('🎯 HD Download', hd)]);
    buttons.push([Markup.button.callback('⭐ Original / Highest Available', 'tiktok:original')]);
    buttons.push([Markup.button.callback('🔍 Inspect downloaded media with FFmpeg', 'tiktok:inspect')]);
    buttons.push([Markup.button.callback('⬅️ Main Menu', 'menu:main')]);
    pendingVideos.set(ctx.from.id, { ...(pendingVideos.get(ctx.from.id) || {}), tiktokUrl: url, tiktokData: d });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, info, Markup.inlineKeyboard(buttons));
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ TikTok check failed: ${err.message}`).catch(() => {});
  }
}
bot.action('tiktok:original', async (ctx) => {
  await ctx.answerCbQuery();
  return withBusy(ctx, async () => {
    const p = pendingVideos.get(ctx.from.id); if (!p || !p.tiktokUrl) return ctx.reply('Send a TikTok URL using Checker & Downloader first.');
    const msg = await ctx.reply('⭐ Requesting original/highest available quality…');
    try { const url = await tikwmOriginal(p.tiktokUrl); await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, '✅ Original/highest-quality download link is ready:', Markup.inlineKeyboard([[Markup.button.url('⬇️ Download Original', url)]])); }
    catch (err) { await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Original download failed: ${err.message}`).catch(() => {}); }
  });
});
bot.action('tiktok:inspect', async (ctx) => {
  await ctx.answerCbQuery();
  return withBusy(ctx, async () => {
    const p = pendingVideos.get(ctx.from.id); const d = p && p.tiktokData;
    if (!d) return ctx.reply('Check a TikTok URL first.');
    const direct = d.play || d.wmplay || d.hdplay;
    if (!direct) return ctx.reply('TikWM did not return a standard downloadable video URL.');
    const msg = await ctx.reply('⬇️ Downloading standard video for native FFmpeg/FFprobe inspection…');
    const filePath = tempPath(ctx.from.id, 'tiktok_inspect', '.mp4');
    try {
      await downloadToFile(direct, filePath);
      const meta = await inspectMedia(filePath);
      const stream = (meta.streams || [])[0] || {}; const format = meta.format || {};
      const size = Number(format.size || fs.statSync(filePath).size);
      const lines = [
        '🧰 NATIVE FFMPEG INSPECTION',
        `Codec: ${pick(stream.codec_name, 'Unavailable')}`,
        `Resolution: ${stream.width && stream.height ? `${stream.width} × ${stream.height}` : 'Unavailable'}`,
        `FPS: ${fpsValue(stream.avg_frame_rate || stream.r_frame_rate)}`,
        `Video bitrate: ${stream.bit_rate ? `${(Number(stream.bit_rate)/1e6).toFixed(2)} Mbps` : 'Not provided by stream'}`,
        `Container bitrate: ${format.bit_rate ? `${(Number(format.bit_rate)/1e6).toFixed(2)} Mbps` : 'Not provided'}`,
        `File size: ${(size/1048576).toFixed(2)} MB`,
        `Duration: ${format.duration ? `${Number(format.duration).toFixed(2)} sec` : 'Unavailable'}`,
        '', 'Note: These are details of the downloaded stream, not a guaranteed inventory of every server-side TikTok rendition.'
      ].join('\n');
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, lines);
    } catch (err) { await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ FFmpeg inspection failed: ${err.message}`).catch(() => {}); }
    finally { await fs.promises.unlink(filePath).catch(() => {}); }
  });
});

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  const pending = pendingVideos.get(ctx.from.id);
  if (pending && pending.awaitingTikTokUrl) {
    if (!validTikTokUrl(text)) return ctx.reply('That does not look like a valid TikTok URL. Please send a public tiktok.com link.');
    pending.awaitingTikTokUrl = false;
    pendingVideos.set(ctx.from.id, pending);
    return processTikTokUrl(ctx, text);
  }
  if (validTikTokUrl(text)) return processTikTokUrl(ctx, text);
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
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
});
