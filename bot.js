// JV Methods Bot — Enhanced / HD (Luna + Jarvis) / FFmpeg / TikTok Checker
// Requires Node.js 20+.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
const WEBHOOK_PATH = `/webhook/${process.env.WEBHOOK_SECRET || 'jv-bot'}`;
const METHODS_DIR = path.join(__dirname, 'methods');
const WORK_DIR = path.join(os.tmpdir(), 'jv_bot_work');
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 200);
const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;

const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || '@jv_60fps';
const REQUIRED_CHANNEL_URL = process.env.REQUIRED_CHANNEL_URL || 'https://t.me/jv_60fps';

const KURONAI_API = 'https://api.kuronaiapp.com';

const TELEGRAM_API_ROOT =
  (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/$/, '');

const CLEANUP_TOKEN = process.env.CLEANUP_TOKEN || '';

const TIKWM_HOSTS = (process.env.TIKWM_API_BASE || 'https://www.tikwm.com,https://tikwm.com')
  .split(',')
  .map(h => h.trim().replace(/\/$/, ''))
  .filter(Boolean);

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.tikwm.com',
  Referer: 'https://www.tikwm.com/',
};

const FFPROBE_PKG = require('ffprobe-static');
const FFPROBE =
  process.env.FFPROBE_PATH || (FFPROBE_PKG && FFPROBE_PKG.path) || 'ffprobe';

if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN environment variable.');
  process.exit(1);
}

if (
  typeof fetch !== 'function' ||
  typeof FormData !== 'function' ||
  typeof Blob !== 'function'
) {
  console.error('Node.js 20 or newer is required.');
  process.exit(1);
}

fs.mkdirSync(WORK_DIR, { recursive: true });

function scrub(value) {
  return String(value == null ? '' : value)
    .split(BOT_TOKEN).join('[bot-token]')
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot[token]');
}

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 30 * 60 * 1000,
  telegram: {
    agent: new https.Agent({ keepAlive: false }),
    apiRoot: TELEGRAM_API_ROOT
  },
});

const pendingVideos = new Map();
const busyUsers = new Set();

// Prevent Telegram webhook retries from processing the same update twice.
// This protects one running bot instance. Keep Render instance count at 1.
const seenUpdates = new Map();
const UPDATE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const UPDATE_DEDUPE_MAX = 10000;

bot.use(async (ctx, next) => {
  const updateId = ctx.update && ctx.update.update_id;

  if (Number.isInteger(updateId)) {
    const now = Date.now();

    for (const [id, timestamp] of seenUpdates) {
      if (now - timestamp > UPDATE_DEDUPE_TTL_MS) {
        seenUpdates.delete(id);
      }
    }

    if (seenUpdates.has(updateId)) {
      console.log(`[dedupe] Ignored duplicate Telegram update ${updateId}`);
      return;
    }

    seenUpdates.set(updateId, now);

    if (seenUpdates.size > UPDATE_DEDUPE_MAX) {
      const oldest = seenUpdates.keys().next().value;
      seenUpdates.delete(oldest);
    }
  }

  return next();
});

async function removePendingVideo(userId, pending) {
  if (pending && pending.inputPath) {
    await fs.promises.unlink(pending.inputPath).catch(() => {});
  }

  if (pendingVideos.get(userId) === pending) {
    pendingVideos.delete(userId);
  }
}

// Membership verification
bot.use(async (ctx, next) => {
  if (!ctx.from || (ctx.callbackQuery && ctx.callbackQuery.data === 'membership:check')) {
    return next();
  }

  try {
    const member = await ctx.telegram.getChatMember(
      REQUIRED_CHANNEL,
      ctx.from.id
    );

    const isMember =
      ['creator', 'administrator', 'member'].includes(member.status) ||
      (member.status === 'restricted' && member.is_member === true);

    if (isMember) return next();

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('📢 Join JV-60FPS Channel', REQUIRED_CHANNEL_URL)],
      [Markup.button.callback('✅ I Joined — Check Again', 'membership:check')],
    ]);

    const message =
      '🔒 Channel Membership Required\n\nPlease join our channel first to use this bot. After joining, tap “I Joined — Check Again”.';

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(
        'Please join the required channel first.',
        { show_alert: true }
      ).catch(() => {});

      await ctx.reply(message, keyboard).catch(() => {});
    } else {
      await ctx.reply(message, keyboard).catch(() => {});
    }

  } catch (err) {
    console.error(
      '[membership] Could not verify channel membership:',
      err.message
    );

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
  enhanced: {
    label: '🟢 Enhanced Method',
    route: '/uploaden/'
  },
  luna: {
    label: '🌙 Luna (MP4Patcher)'
  },
  jarvis: {
    label: '⚠️ Jarvis (Kuronai HQ)'
  },
  alpha: {
    label: '⚡ Alpha'
  },
};

const XORA_API = 'https://api.xora.sh/v1';
const XORA_API_KEY = process.env.XORA_API_KEY || '';
const ALPHA_VIDEO_BITRATE = process.env.ALPHA_VIDEO_BITRATE || '18M';
const ALPHA_AUDIO_BITRATE = process.env.ALPHA_AUDIO_BITRATE || '128k';
const ALPHA_JOB_TIMEOUT_MS =
  Number(process.env.ALPHA_JOB_TIMEOUT_MS || 15 * 60 * 1000);

const alphaInputTokens = new Map();

function userDir(userId) {
  const dir = path.join(WORK_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  return path.basename(name || 'video.mp4')
    .replace(/[^\w.() -]/g, '_')
    .slice(0, 100) || 'video.mp4';
}

function tempPath(userId, prefix, ext = '.mp4') {
  return path.join(
    userDir(userId),
    `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`
  );
}

function loadMethod(file) {
  const p = path.join(METHODS_DIR, file);

  if (!fs.existsSync(p)) {
    throw new Error(`Missing methods/${file}`);
  }

  delete require.cache[require.resolve(p)];

  const mod = require(p);

  if (!mod || typeof mod.process !== 'function') {
    throw new Error(`${file} must export process(inputPath, outputPath)`);
  }

  return mod;
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));

  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function editProgress(ctx, messageId, text, force = false) {
  const now = Date.now();

  if (!force && ctx.__lastProgressEdit && now - ctx.__lastProgressEdit < 1100) {
    return;
  }

  ctx.__lastProgressEdit = now;

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      messageId,
      undefined,
      scrub(text)
    );
  } catch (_) {}
}

function mediaHeaders(url) {
  try {
    return /(^|\.)tikwm\.com$/i.test(new URL(url).hostname)
      ? BROWSER_HEADERS
      : {};
  } catch (_) {
    return {};
  }
}

// Stream a download to disk with a hard size limit.
async function downloadToFile(
  url,
  destPath,
  maxBytes = MAX_VIDEO_BYTES,
  extraHeaders = {}
) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      ...mediaHeaders(url),
      ...extraHeaders
    },
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const declared = Number(response.headers.get('content-length') || 0);

  if (declared && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error(`File exceeds ${Math.floor(maxBytes / 1048576)} MB limit.`);
  }

  let received = 0;

  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;

      if (received > maxBytes) {
        callback(new Error(`File exceeds ${Math.floor(maxBytes / 1048576)} MB limit.`));
      } else {
        callback(null, chunk);
      }
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      fs.createWriteStream(destPath)
    );

    if (!received) {
      throw new Error('The downloaded file is empty.');
    }

    return received;

  } catch (err) {
    await fs.promises.unlink(destPath).catch(() => {});
    throw err;
  }
}

// Secure cleanup route on the separate Telegram API gateway.
async function cleanupTelegramApiFiles(paths) {
  if (
    !SELF_HOSTED ||
    !CLEANUP_TOKEN ||
    !Array.isArray(paths) ||
    !paths.length
  ) {
    return;
  }

  try {
    const response = await fetch(`${TELEGRAM_API_ROOT}/cleanup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cleanup-token': CLEANUP_TOKEN,
      },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');

      console.warn(
        `[telegram-cleanup] API cleanup failed: HTTP ${response.status} ${detail.slice(0, 300)}`
      );
    }

  } catch (err) {
    console.warn(
      '[telegram-cleanup] Could not reach cleanup endpoint:',
      scrub(err.message)
    );
  }
}

// Download from Telegram.
// Local Bot API mode returns a filesystem path belonging to the API service.
// The bot service cannot access that separate Render disk, so it uses /download.
async function telegramDownload(ctx, file, userId) {
  const ext = path.extname(file.file_name || '') || '.mp4';
  const inputPath = tempPath(userId, 'input', ext);
  const fileSize = Number(file.file_size || 0);

  if (fileSize && fileSize > MAX_VIDEO_BYTES) {
    throw new Error(`Video exceeds this bot's ${MAX_VIDEO_MB} MB limit.`);
  }

  let apiFilePath = null;

  try {
    const info = await ctx.telegram.getFile(file.file_id);

    if (SELF_HOSTED && info.file_path && path.isAbsolute(info.file_path)) {
      apiFilePath = info.file_path;
    } else if (!SELF_HOSTED && fileSize > 20 * 1048576) {
      throw new Error(
        'The public Telegram Bot API only allows bot downloads up to 20 MB. Configure the local API server for larger files.'
      );
    }

    if (SELF_HOSTED && apiFilePath) {
      if (!CLEANUP_TOKEN) {
        throw new Error('CLEANUP_TOKEN is missing from the bot service.');
      }

      const downloadUrl =
        `${TELEGRAM_API_ROOT}/download?path=${encodeURIComponent(apiFilePath)}`;

      await downloadToFile(
        downloadUrl,
        inputPath,
        MAX_VIDEO_BYTES,
        {
          'x-cleanup-token': CLEANUP_TOKEN,
        }
      );

    } else {
      const link = await ctx.telegram.getFileLink(file.file_id);

      await downloadToFile(
        link.href || String(link),
        inputPath,
        MAX_VIDEO_BYTES
      );
    }

    return inputPath;

  } catch (err) {
    await fs.promises.unlink(inputPath).catch(() => {});
    throw err;

  } finally {
    if (apiFilePath) {
      await cleanupTelegramApiFiles([apiFilePath]);
    }
  }
}

// Telegram delivery
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const UPLOAD_TIMEOUT_MS =
  Number(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS || 10 * 60 * 1000);

const SELF_HOSTED = TELEGRAM_API_ROOT !== 'https://api.telegram.org';

const MAX_UPLOAD_BYTES =
  (SELF_HOSTED ? MAX_VIDEO_MB : Math.min(MAX_VIDEO_MB, 49)) * 1048576;

async function telegramUploadOnce(method, field, filePath, params) {
  const form = new FormData();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      form.append(key, String(value));
    }
  }

  const mimeType =
    field === 'video' ? 'video/mp4' : 'application/octet-stream';

  const uploadBlob = typeof fs.openAsBlob === 'function'
    ? await fs.openAsBlob(filePath, { type: mimeType })
    : new Blob(
        [await fs.promises.readFile(filePath)],
        { type: mimeType }
      );

  form.append(
    field,
    uploadBlob,
    safeName(path.basename(filePath))
  );

  let response;

  try {
    response = await fetch(
      `${TELEGRAM_API_ROOT}/bot${BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      }
    );

  } catch (err) {
    const detail = err && err.cause
      ? (err.cause.code || err.cause.message)
      : (err && err.name);

    const dropped = new Error(
      `connection to Telegram dropped during ${method}${detail ? ` (${scrub(detail)})` : ''}`
    );

    dropped.transient = true;
    throw dropped;
  }

  let data = null;

  try {
    data = await response.json();
  } catch (_) {}

  if (response.ok && data && data.ok) {
    return data.result;
  }

  const rejected = new Error(
    `Telegram rejected ${method}: ${scrub((data && data.description) || `HTTP ${response.status}`)}`
  );

  rejected.status = response.status;
  rejected.retryAfter = data && data.parameters
    ? Number(data.parameters.retry_after) || 0
    : 0;

  rejected.transient =
    response.status === 429 || response.status >= 500;

  throw rejected;
}

async function telegramUpload(
  method,
  field,
  filePath,
  params,
  maxAttempts = 4
) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await telegramUploadOnce(method, field, filePath, params);
      return { attempts: attempt };

    } catch (err) {
      lastError = err;

      if (!err.transient || attempt === maxAttempts) {
        break;
      }

      const waitMs = err.retryAfter
        ? err.retryAfter * 1000 + 500
        : attempt * 2500;

      console.warn(
        `[telegram] ${method} attempt ${attempt}/${maxAttempts} failed (${err.message}); retrying in ${Math.round(waitMs / 1000)}s`
      );

      await sleep(waitMs);
    }
  }

  lastError.attempts = maxAttempts;
  throw lastError;
}

async function sendVideoFile(ctx, filePath, caption) {
  const size = fs.statSync(filePath).size;

  if (!size) {
    throw new Error('The processed output file is empty.');
  }

  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Processed video is ${(size / 1048576).toFixed(1)} MB, above this bot's ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB upload limit.`
    );
  }

  const base = {
    chat_id: ctx.chat.id,
    caption: String(caption || '').slice(0, 900)
  };

  let videoError;

  try {
    const sent = await telegramUpload(
      'sendVideo',
      'video',
      filePath,
      {
        ...base,
        supports_streaming: true
      }
    );

    return {
      sentAs: 'video',
      attempts: sent.attempts
    };

  } catch (err) {
    videoError = err;
  }

  if (!videoError.transient && videoError.status !== 400) {
    throw new Error(videoError.message);
  }

  try {
    const sent = await telegramUpload(
      'sendDocument',
      'document',
      filePath,
      base
    );

    return {
      sentAs: 'document_fallback',
      attempts: (videoError.attempts || 1) + sent.attempts
    };

  } catch (docError) {
    throw new Error(
      `Telegram could not receive the processed video. Video upload: ${videoError.message}. Document upload: ${docError.message}`
    );
  }
}

async function sendDocumentFile(ctx, filePath, caption) {
  const size = fs.statSync(filePath).size;

  if (!size) {
    throw new Error('The processed output file is empty.');
  }

  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Processed video is ${(size / 1048576).toFixed(1)} MB, above this bot's ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB upload limit.`
    );
  }

  await telegramUpload(
    'sendDocument',
    'document',
    filePath,
    {
      chat_id: ctx.chat.id,
      caption: String(caption || '').slice(0, 900),
    }
  );
}

// Kuronai upload protocol
async function kuronaiUpload(
  inputPath,
  telegramId,
  route,
  encodeVideo,
  onProgress
) {
  const form = new FormData();

  const blob = typeof fs.openAsBlob === 'function'
    ? await fs.openAsBlob(inputPath, { type: 'video/mp4' })
    : new Blob(
        [await fs.promises.readFile(inputPath)],
        { type: 'video/mp4' }
      );

  form.append('file', blob, safeName(path.basename(inputPath)));
  form.append('tg_id', String(telegramId));
  form.append('progress', 'true');

  if (route === '/upload/') {
    form.append('encode_video', String(Boolean(encodeVideo)));
  }

  const response = await fetch(
    KURONAI_API + route,
    {
      method: 'POST',
      body: form
    }
  );

  if (!response.ok) {
    let detail = '';

    try {
      const j = await response.json();
      detail = j.detail || j.message || '';
    } catch (_) {}

    throw new Error(
      detail || `Kuronai upload failed (HTTP ${response.status}).`
    );
  }

  const contentType = response.headers.get('content-type') || '';
  let result = null;

  if (contentType.includes('application/x-ndjson') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    while (true) {
      const { value, done } = await reader.read();

      pending += decoder.decode(
        value || new Uint8Array(),
        { stream: !done }
      );

      const lines = pending.split('\n');
      pending = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        let event;

        try {
          event = JSON.parse(line);
        } catch (_) {
          continue;
        }

        if (event.type === 'error') {
          throw new Error(
            event.message || event.code || 'Kuronai server processing failed.'
          );
        }

        if (event.type === 'progress' && onProgress) {
          onProgress(event);
        }

        if (event.type === 'complete') {
          result = event;
        }
      }

      if (done) break;
    }

    if (pending.trim()) {
      try {
        const event = JSON.parse(pending);

        if (event.type === 'progress' && onProgress) {
          onProgress(event);
        }

        if (event.type === 'complete') {
          result = event;
        }

        if (event.type === 'error') {
          throw new Error(event.message || event.code);
        }

      } catch (e) {
        if (e.message && !e.message.includes('Unexpected')) {
          throw e;
        }
      }
    }

  } else {
    result = await response.json();
  }

  if (!result || typeof result.file_id !== 'string' || !result.file_id) {
    throw new Error('Kuronai response did not contain a file_id.');
  }

  return result.file_id;
}

async function kuronaiDownload(fileId, outputPath, onProgress) {
  const response = await fetch(
    `${KURONAI_API}/download/${encodeURIComponent(fileId)}`
  );

  if (!response.ok || !response.body) {
    throw new Error(
      `Kuronai result download failed (HTTP ${response.status}).`
    );
  }

  const total = Number(response.headers.get('content-length') || 0);
  const out = fs.createWriteStream(outputPath);
  let received = 0;

  for await (const chunk of require('stream').Readable.fromWeb(response.body)) {
    received += chunk.length;

    if (!out.write(chunk)) {
      await new Promise(r => out.once('drain', r));
    }

    if (onProgress && total) {
      onProgress(Math.round(received / total * 100));
    }
  }

  await new Promise(r => out.end(r));

  if (!received) {
    throw new Error('Kuronai returned an empty output file.');
  }
}

async function kuronaiCleanup(fileId) {
  try {
    await fetch(
      `${KURONAI_API}/cleanup/${encodeURIComponent(fileId)}`,
      { method: 'DELETE' }
    );
  } catch (_) {}
}

async function runKuronai(ctx, pending, mode, encodeVideo) {
  const enhanced = mode === 'enhanced';
  const route = enhanced ? '/uploaden/' : '/upload/';
  const title = enhanced ? 'Enhanced Method' : 'Jarvis HQ Method';
  const started = Date.now();

  const status = await ctx.reply(
    `⚙️ ${title}\nPreparing upload…\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON' : 'OFF')}\nServer encoding: waiting for server…\nElapsed: 00:00:00`
  );

  let fileId;
  let outputPath;
  let lastPercent = null;
  let lastStage = 'Uploading';
  let processing = true;
  let inflight = Promise.resolve();

  const progressText = (pct) =>
    `⚙️ ${title}\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON' : 'OFF')}\nServer encoding: ${pct}\nStage: ${lastStage}\nElapsed: ${fmtTime(Date.now() - started)}`;

  const showProgress = (pct) => {
    if (processing) {
      inflight = editProgress(
        ctx,
        status.message_id,
        progressText(pct)
      ).catch(() => {});
    }
  };

  const stopProgress = async () => {
    processing = false;
    clearInterval(timer);
    await inflight;
  };

  const timer = setInterval(() => {
    showProgress(
      lastPercent === null
        ? 'Waiting for server progress'
        : `${lastPercent}%`
    );
  }, 3000);

  try {
    fileId = await kuronaiUpload(
      pending.inputPath,
      ctx.from.id,
      route,
      encodeVideo,
      (event) => {
        if (Number.isFinite(Number(event.percent))) {
          lastPercent = Math.max(
            0,
            Math.min(100, Math.round(Number(event.percent)))
          );
        }

        if (event.stage || event.step) {
          lastStage = String(event.stage || event.step).slice(0, 50);
        }

        showProgress(
          lastPercent === null ? 'Server working' : `${lastPercent}%`
        );
      }
    );

    await stopProgress();

    await editProgress(
      ctx,
      status.message_id,
      `⬇️ ${title}\nServer processing complete. Downloading result…\nElapsed: ${fmtTime(Date.now() - started)}`,
      true
    );

    outputPath = tempPath(
      ctx.from.id,
      enhanced ? 'enhanced_result' : 'jarvis_result',
      '.mp4'
    );

    await kuronaiDownload(
      fileId,
      outputPath,
      (percent) => {
        editProgress(
          ctx,
          status.message_id,
          `⬇️ ${title}\nDownloading result: ${percent}%\nElapsed: ${fmtTime(Date.now() - started)}`
        ).catch(() => {});
      }
    );

    await editProgress(
      ctx,
      status.message_id,
      '📤 Sending processed video to Telegram…\nLarge files may take a little while. Automatic retry is enabled.',
      true
    );

    const delivery = await sendVideoFile(
      ctx,
      outputPath,
      `✅ ${title} complete\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON — re-encode requested' : 'OFF — re-encode disabled')}`
    );

    const deliveryNote =
      delivery.sentAs === 'document_fallback'
        ? '\nDelivered as an MP4 document after Telegram video upload retries.'
        : '';

    await editProgress(
      ctx,
      status.message_id,
      `✅ ${title} completed\nElapsed: ${fmtTime(Date.now() - started)}${deliveryNote}`,
      true
    );

    await removePendingVideo(ctx.from.id, pending);

  } catch (err) {
    await stopProgress();

    await editProgress(
      ctx,
      status.message_id,
      `❌ ${title} delivery failed\n${scrub(err.message || err).slice(0, 1200)}\n\nYour original video is still available. Please try again later.`,
      true
    );

    throw err;

  } finally {
    processing = false;
    clearInterval(timer);

    if (outputPath) {
      await fs.promises.unlink(outputPath).catch(() => {});
    }

    if (fileId) {
      await kuronaiCleanup(fileId);
    }
  }
}

async function runLocalMethod(ctx, pending, methodKey) {
  const userId = ctx.from.id;

  const outputPath = tempPath(
    userId,
    `out_${methodKey}`,
    path.extname(pending.inputPath) || '.mp4'
  );

  const status = await ctx.reply('⚙️ Processing with Luna…');

  try {
    const mod = loadMethod('c_method.js');

    await mod.process(pending.inputPath, outputPath);

    if (
      !fs.existsSync(outputPath) ||
      fs.statSync(outputPath).size === 0
    ) {
      throw new Error('The method did not produce a valid output file.');
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      '📤 Uploading processed video…'
    );

    await sendVideoFile(
      ctx,
      outputPath,
      '✅ Luna MP4Patcher completed'
    );

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      '✅ Processing complete.'
    );

    await removePendingVideo(userId, pending);

  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `❌ Processing failed: ${scrub(err.message)}`
    ).catch(() => {});

    throw err;

  } finally {
    await fs.promises.unlink(outputPath).catch(() => {});
  }
}

function parseFps(value) {
  if (!value || value === '0/0' || value === 'N/A') {
    return NaN;
  }

  const parts = String(value).split('/');
  const n = Number(parts[0]);
  const d = parts.length > 1 ? Number(parts[1]) : 1;

  return Number.isFinite(n) && Number.isFinite(d) && d > 0
    ? n / d
    : NaN;
}

function alphaEstimate(meta, targetFps) {
  const stream = (meta.streams || [])[0];

  if (!stream) {
    throw new Error('No video stream was found in this file.');
  }

  const sourceFps =
    parseFps(stream.avg_frame_rate) ||
    parseFps(stream.r_frame_rate);

  const duration = Number(meta.format && meta.format.duration);

  if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
    throw new Error('Could not detect the source FPS.');
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not detect the video duration.');
  }

  const scaleFactor = targetFps ? sourceFps / targetFps : 1;
  const outputDuration = duration * scaleFactor;

  const videoBps =
    Number(String(ALPHA_VIDEO_BITRATE)
      .replace(/k$/i, '000')
      .replace(/m$/i, '000000')) || 18000000;

  const audioBps =
    Number(String(ALPHA_AUDIO_BITRATE)
      .replace(/k$/i, '000')
      .replace(/m$/i, '000000')) || 128000;

  const estimatedMB =
    ((videoBps + audioBps) * outputDuration / 8) / 1048576;

  return {
    sourceFps,
    duration,
    scaleFactor,
    outputDuration,
    estimatedMB
  };
}

async function xoraRequest(route, options = {}) {
  if (!XORA_API_KEY) {
    throw new Error('Alpha is not configured yet. Please contact the bot administrator.');
  }

  const response = await fetch(
    `${XORA_API}${route}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${XORA_API_KEY}`,
        ...(options.headers || {})
      },
      signal: options.signal || AbortSignal.timeout(120000),
    }
  );

  const raw = await response.text();
  let data = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = { message: raw.slice(0, 500) };
  }

  if (!response.ok) {
    const detail =
      data.error && (data.error.message || data.error.code) ||
      data.message ||
      data.detail ||
      `HTTP ${response.status}`;

    throw new Error(`Alpha request failed: ${detail}`);
  }

  return data;
}

async function createAlphaJob(
  inputPath,
  targetFps,
  estimate,
  onProgress
) {
  if (!PUBLIC_URL || !/^https:\/\//i.test(PUBLIC_URL)) {
    throw new Error(
      'Alpha needs RENDER_EXTERNAL_URL or PUBLIC_URL set to this bot’s public HTTPS address.'
    );
  }

  const token = crypto.randomBytes(24).toString('hex');

  alphaInputTokens.set(token, {
    path: inputPath,
    expiresAt: Date.now() + 60 * 60 * 1000
  });

  const inputUrl =
    `${PUBLIC_URL.replace(/\/$/, '')}/alpha-input/${token}`;

  const outputName = `alpha_${Date.now()}.wmv`;
  const args = [];

  if (targetFps) {
    args.push('-itsscale', estimate.scaleFactor.toFixed(10));
  }

  args.push(
    '-i', '{{input}}',
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', 'scale=-2:720:flags=lanczos',
    '-c:v', 'wmv2', '-b:v', ALPHA_VIDEO_BITRATE,
    '-maxrate', '20M', '-bufsize', '36M',
    '-c:a', 'wmav2', '-b:a', ALPHA_AUDIO_BITRATE,
    '-f', 'asf', '{{output}}'
  );

  const created = await xoraRequest(
    '/jobs',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mode: 'ffmpeg',
        input_files: {
          in_1: inputUrl
        },
        output_files: {
          out_1: outputName
        },
        ffmpeg: {
          args: args.map((arg) =>
            arg === '{{input}}'
              ? '{{in_1}}'
              : arg === '{{output}}'
                ? '{{out_1}}'
                : arg
          )
        },
        idempotencyKey: `alpha-${crypto.randomUUID()}`,
      }),
    }
  );

  const jobId = created.id || created.jobId;

  if (!jobId) {
    throw new Error('Alpha did not return a job ID.');
  }

  const started = Date.now();
  const terminal = new Set([
    'completed',
    'failed',
    'rejected',
    'cancelled'
  ]);

  let job;

  while (Date.now() - started < ALPHA_JOB_TIMEOUT_MS) {
    await sleep(2500);

    job = await xoraRequest(
      `/jobs/${encodeURIComponent(jobId)}`,
      { method: 'GET' }
    );

    const pct = Number(job.progress);
    const state = String(job.state || 'processing');

    onProgress(
      state,
      Number.isFinite(pct)
        ? Math.max(0, Math.min(100, Math.round(pct)))
        : null
    );

    if (terminal.has(state)) {
      break;
    }
  }

  if (!job || !terminal.has(job.state)) {
    throw new Error(
      'Alpha processing timed out. Your original video is still available; try again later.'
    );
  }

  alphaInputTokens.delete(token);

  if (job.state !== 'completed') {
    const detail =
      job.error && (job.error.message || job.error.code) ||
      job.message ||
      job.state;

    throw new Error(`Alpha processing ${job.state}: ${detail}`);
  }

  const firstOutput = Array.isArray(job.outputs)
    ? job.outputs[0]
    : (
        job.outputs &&
        (job.outputs.out_1 || Object.values(job.outputs)[0])
      );

  const namedOutput = job.output_files &&
    (job.output_files.out_1 || Object.values(job.output_files)[0]);

  const outputUrl =
    (job.output && (job.output.signedUrl || job.output.url)) ||
    (firstOutput && (
      firstOutput.signedUrl ||
      firstOutput.url ||
      firstOutput.downloadUrl
    )) ||
    (typeof firstOutput === 'string' ? firstOutput : null) ||
    (namedOutput && (
      namedOutput.signedUrl ||
      namedOutput.url ||
      namedOutput.storage_url
    )) ||
    (typeof namedOutput === 'string' ? namedOutput : null);

  if (!outputUrl) {
    throw new Error('Alpha completed but did not return an output download URL.');
  }

  return {
    outputUrl,
    jobId
  };
}

async function runAlpha(ctx, pending, targetFps) {
  const meta = await inspectMedia(pending.inputPath);
  const estimate = alphaEstimate(meta, targetFps);

  const status = await ctx.reply(
    '⚡ Alpha\nPreparing your video…'
  );

  let outputPath;

  try {
    await editProgress(
      ctx,
      status.message_id,
      '⚡ Alpha\nUploading video…',
      true
    );

    const result = await createAlphaJob(
      pending.inputPath,
      targetFps,
      estimate,
      (stage, percent) => {
        editProgress(
          ctx,
          status.message_id,
          `⚡ Alpha\nStage: ${stage}${percent === null ? '' : `\nProgress: ${percent}%`}\nEstimated output: ${fmtTime(estimate.outputDuration)}`
        ).catch(() => {});
      }
    );

    outputPath = tempPath(
      ctx.from.id,
      'alpha_result',
      '.wmv'
    );

    await editProgress(
      ctx,
      status.message_id,
      '⚡ Alpha\nDownloading finished video…',
      true
    );

    await downloadToFile(
      result.outputUrl,
      outputPath,
      MAX_UPLOAD_BYTES
    );

    await editProgress(
      ctx,
      status.message_id,
      '📤 Sending your video…',
      true
    );

    const caption =
      `✅ Alpha completed\nOutput: 720p WMV\n${targetFps ? `FPS patch: ${targetFps} FPS\nTimestamp scale: ${estimate.scaleFactor.toFixed(4)}x\n` : 'FPS patch: Off\n'}Estimated duration: ${fmtTime(estimate.outputDuration)}\nEstimated size: ${estimate.estimatedMB.toFixed(1)} MB`;

    await sendDocumentFile(
      ctx,
      outputPath,
      caption
    );

    await editProgress(
      ctx,
      status.message_id,
      '✅ Alpha completed.',
      true
    );

    await removePendingVideo(ctx.from.id, pending);

  } catch (err) {
    await editProgress(
      ctx,
      status.message_id,
      `❌ Alpha failed\n${scrub(err.message || err).slice(0, 1000)}\n\nYour original video is still available.`,
      true
    );

    throw err;

  } finally {
    if (outputPath) {
      await fs.promises.unlink(outputPath).catch(() => {});
    }
  }
}

// Mini App
const MINI_APP_URL =
  (process.env.MINI_APP_URL || 'https://fastidious-biscochitos-ad7934.netlify.app/').trim();

const WELCOME_IMAGE = path.join(__dirname, 'image1.png');

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Enhanced Method', 'method:enhanced')],
    [Markup.button.callback('⚠️ HD Method', 'menu:hd')],
    [Markup.button.callback('⚡ Alpha', 'menu:alpha')],
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

function alphaConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Yes', 'alpha:confirm'),
      Markup.button.callback('❌ No', 'menu:main')
    ],
  ]);
}

function alphaPatchKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Yes', 'alpha:patch:yes'),
      Markup.button.callback('❌ No', 'menu:main')
    ],
    [Markup.button.callback('⬅️ Back', 'menu:main')],
  ]);
}

function alphaFpsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('60 FPS', 'alpha:fps:60'),
      Markup.button.callback('30 FPS', 'alpha:fps:30')
    ],
    [Markup.button.callback('⬅️ Back', 'alpha:confirm')],
  ]);
}

function alphaStartKeyboard(fps) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Start Alpha', `alpha:start:${fps}`)],
    [Markup.button.callback('⬅️ Back', 'alpha:patch:yes')],
  ]);
}

// Membership re-check button
bot.action('membership:check', async (ctx) => {
  await ctx.answerCbQuery('Checking your membership…').catch(() => {});

  try {
    const member = await ctx.telegram.getChatMember(
      REQUIRED_CHANNEL,
      ctx.from.id
    );

    const isMember =
      ['creator', 'administrator', 'member'].includes(member.status) ||
      (member.status === 'restricted' && member.is_member === true);

    if (!isMember) {
      return ctx.reply(
        '❌ You have not joined @jv_60fps yet. Join the channel, then tap the check button again.',
        Markup.inlineKeyboard([
          [Markup.button.url('📢 Join JV-60FPS Channel', REQUIRED_CHANNEL_URL)],
          [Markup.button.callback('✅ Check Again', 'membership:check')],
        ])
      );
    }

    return ctx.reply(
      '✅ Membership verified! You can now use JV Methods Bot.',
      mainKeyboard()
    );

  } catch (err) {
    console.error('[membership] Recheck failed:', err.message);

    return ctx.reply(
      '⚠️ Could not verify membership. Please try again later. The bot must be an administrator in @jv_60fps.'
    );
  }
});

// Start and help commands
bot.start(async (ctx) => {
  const text =
    '👋 Welcome to JV Methods Bot\n\n🎬 Send me a video and choose a processing method.\n🔎 Send a TikTok link (or open the menu button at the left of the chat) for full video details and downloads.';

  if (fs.existsSync(WELCOME_IMAGE)) {
    try {
      return await ctx.replyWithPhoto(
        { source: WELCOME_IMAGE },
        { caption: text }
      );
    } catch (e) {
      console.warn('[start] image failed:', scrub(e.message));
    }
  }

  return ctx.reply(text);
});

bot.help((ctx) =>
  ctx.reply(
    'Send a video, then choose Enhanced, HD (Luna/Jarvis) or Alpha. Send a TikTok link, or use the menu button at the left of the chat, for the Checker & Downloader.'
  )
);

// Receive videos
bot.on(['video', 'document'], async (ctx) => {
  const file = ctx.message.video || ctx.message.document;

  if (!file || (
    ctx.message.document &&
    !(file.mime_type || '').startsWith('video/')
  )) {
    return;
  }

  const sizeMB = (file.file_size || 0) / 1048576;

  if (sizeMB > MAX_VIDEO_MB) {
    return ctx.reply(
      `⚠️ Video is ${sizeMB.toFixed(1)} MB. Maximum is ${MAX_VIDEO_MB} MB.`
    );
  }

  if (busyUsers.has(ctx.from.id)) {
    return ctx.reply(
      '⏳ You already have a processing task running. Please wait until it finishes before sending another video.'
    );
  }

  const status = await ctx.reply('📥 Downloading your video…');
  let inputPath;

  try {
    inputPath = await telegramDownload(
      ctx,
      file,
      ctx.from.id
    );

    const previous = pendingVideos.get(ctx.from.id);

    if (previous) {
      await removePendingVideo(ctx.from.id, previous);
    }

    pendingVideos.set(ctx.from.id, {
      inputPath,
      fileName: safeName(file.file_name || 'video.mp4')
    });

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      '✅ Video received. Choose a method:',
      mainKeyboard()
    );

  } catch (err) {
    if (inputPath) {
      await fs.promises.unlink(inputPath).catch(() => {});
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `❌ Download failed: ${scrub(err.message)}`
    ).catch(() => {});
  }
});

// Menus
bot.action('menu:main', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText('Choose a method:', mainKeyboard());
});

bot.action('menu:hd', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    '⚠️ HD METHOD\nChoose a processing engine:',
    hdKeyboard()
  );
});

bot.action('menu:jarvis', async (ctx) => {
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    '⚠️ JARVIS — HQ METHOD\n\nVideo Optimization\nChoose whether Kuronai should re-encode the video:',
    optimizerKeyboard()
  );
});

bot.action('menu:alpha', async (ctx) => {
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    '⚡ Alpha\n\n720p output with optional 30 FPS or 60 FPS patching.\n\nDo you still want to use Alpha?',
    alphaConfirmKeyboard()
  );
});

async function getPending(ctx) {
  const p = pendingVideos.get(ctx.from.id);

  if (!p || !p.inputPath || !fs.existsSync(p.inputPath)) {
    await ctx.reply(
      '⚠️ Please send a video first, then choose the method.'
    );

    return null;
  }

  return p;
}

function withBusy(ctx, fn) {
  const id = ctx.from.id;

  if (busyUsers.has(id)) {
    return ctx.reply('⏳ You already have a processing task running.');
  }

  busyUsers.add(id);

  (async () => {
    try {
      await fn();

    } catch (err) {
      console.error(
        '[task] Operation failed:',
        scrub(err && err.stack || err)
      );

      await ctx.reply(
        `❌ ${scrub(err && err.message || 'Operation failed.')}`
      ).catch(() => {});

    } finally {
      busyUsers.delete(id);
    }
  })();
}

// Method actions
bot.action('method:enhanced', async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);

    if (p) {
      await runKuronai(ctx, p, 'enhanced', false);
    }
  });
});

bot.action('method:luna', async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);

    if (p) {
      await runLocalMethod(ctx, p, 'luna');
    }
  });
});

bot.action(/^jarvis:optimizer:(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);

    if (p) {
      await runKuronai(
        ctx,
        p,
        'jarvis',
        ctx.match[1] === 'on'
      );
    }
  });
});

bot.action('alpha:confirm', async (ctx) => {
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    '⚡ Alpha\n\nDo you want to patch FPS?',
    alphaPatchKeyboard()
  );
});

bot.action('alpha:patch:yes', async (ctx) => {
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    'Choose the target FPS:',
    alphaFpsKeyboard()
  );
});

bot.action('alpha:patch:no', async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);

    if (p) {
      await runAlpha(ctx, p, null);
    }
  });
});

bot.action(/^alpha:fps:(30|60)$/, async (ctx) => {
  const fps = Number(ctx.match[1]);

  await ctx.answerCbQuery('Calculating estimate…');

  const p = await getPending(ctx);

  if (!p) return;

  try {
    const meta = await inspectMedia(p.inputPath);
    const estimate = alphaEstimate(meta, fps);

    const preview =
      `⚡ Alpha\n\nSource FPS: ${estimate.sourceFps.toFixed(3)}\nTarget FPS: ${fps}\nTimestamp scale: ${estimate.scaleFactor.toFixed(4)}x\nEstimated output duration: ${fmtTime(estimate.outputDuration)}\nEstimated output size: ${estimate.estimatedMB.toFixed(1)} MB\nVideo bitrate: ${ALPHA_VIDEO_BITRATE}\n\nStart processing?`;

    return ctx.editMessageText(
      preview,
      alphaStartKeyboard(fps)
    );

  } catch (err) {
    return ctx.reply(
      `❌ Could not estimate Alpha output: ${scrub(err.message)}`
    );
  }
});

bot.action(/^alpha:start:(30|60)$/, async (ctx) => {
  const fps = Number(ctx.match[1]);

  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);

    if (p) {
      await runAlpha(ctx, p, fps);
    }
  });
});

function validTikTokUrl(value) {
  try {
    const u = new URL(value);
    return /(^|\.)tiktok\.com$/i.test(u.hostname);
  } catch (_) {
    return false;
  }
}

async function inspectMedia(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,bit_rate,avg_frame_rate,r_frame_rate',
        '-show_entries', 'format=duration,size,bit_rate',
        '-of', 'json',
        filePath
      ],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(
            new Error((stderr || err.message).slice(-1200))
          );
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (_) {
          reject(new Error('Could not parse FFprobe media details.'));
        }
      }
    );
  });
}

// TikTok link handoff to the Mini App
bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();

  if (!validTikTokUrl(text)) return;

  const url =
    `${MINI_APP_URL.replace(/\/?$/, '/')}?url=${encodeURIComponent(text)}`;

  return ctx.reply(
    '🔎 TikTok link received.\nTap below to open full details and downloads.',
    Markup.inlineKeyboard([
      [
        Markup.button.webApp(
          '🔎 Open Checker & Downloader',
          url
        )
      ]
    ])
  );
});

// Error handling
bot.catch((err, ctx) => {
  console.error(
    'Bot error:',
    scrub(err && err.stack || err)
  );

  if (ctx && !ctx.__errorReported) {
    ctx.reply(
      '❌ Something went wrong. Please try again.'
    ).catch(() => {});
  }
});

// Express server and webhook
const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'JV Methods Bot'
  });
});

// Expire old Alpha input URLs
setInterval(() => {
  for (const [token, entry] of alphaInputTokens) {
    if (entry.expiresAt < Date.now()) {
      alphaInputTokens.delete(token);
    }
  }
}, 10 * 60 * 1000).unref();

// Alpha input download route
app.get('/alpha-input/:token', (req, res) => {
  const entry = alphaInputTokens.get(req.params.token);

  if (
    !entry ||
    entry.expiresAt < Date.now() ||
    !fs.existsSync(entry.path)
  ) {
    alphaInputTokens.delete(req.params.token);
    return res.status(404).end('Not found');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/octet-stream');

  return res.sendFile(
    entry.path,
    (err) => {
      if (err && !res.headersSent) {
        res.status(500).end('File unavailable');
      }
    }
  );
});

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Listening on ${PORT}`);

  console.log(
    `[telegram] API root: ${TELEGRAM_API_ROOT}; self-hosted: ${SELF_HOSTED}; max video: ${MAX_VIDEO_MB} MB; max upload: ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB; cleanup token: ${CLEANUP_TOKEN ? 'configured' : 'missing'}`
  );

  if (PUBLIC_URL) {
    try {
      await bot.telegram.setWebhook(
        `${PUBLIC_URL}${WEBHOOK_PATH}`
      );

      console.log('[bot] Webhook registered.');

    } catch (err) {
      console.error(
        '[bot] Webhook registration failed:',
        err.message
      );
    }

  } else {
    console.warn(
      '[bot] PUBLIC_URL / RENDER_EXTERNAL_URL missing. Set it for webhook deployment.'
    );
  }

  await bot.telegram.setMyCommands([
    {
      command: 'start',
      description: 'Start the bot'
    },
    {
      command: 'help',
      description: 'How to use the bot'
    }
  ]);

  // Mini App button at the left of the message box.
  if (/^https:\/\//i.test(MINI_APP_URL)) {
    try {
      await bot.telegram.callApi(
        'setChatMenuButton',
        {
          menu_button: {
            type: 'web_app',
            text: 'Checker',
            web_app: {
              url: MINI_APP_URL
            }
          }
        }
      );

    } catch (err) {
      console.error(
        '[bot] Menu button failed:',
        scrub(err.message)
      );
    }
  }
});
