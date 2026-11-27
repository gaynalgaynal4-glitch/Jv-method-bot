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
const { Telegraf, Markup, Telegram } = require('telegraf');

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

// Netlify TikTok checker backend. Set both values in the bot host environment.
const TIKTOK_API_URL = (process.env.TIKTOK_API_URL || '').replace(/\/$/, '');
const TIKTOK_API_SECRET = process.env.TIKTOK_API_SECRET || process.env.API_SECRET || '';

const TELEGRAM_API_ROOT =
  (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/$/, '');

const CLEANUP_TOKEN = process.env.CLEANUP_TOKEN || '';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const MAINTENANCE_KEY = 'jv-methods:maintenance:v1';
const METHOD_KEYS = ['enhanced', 'jarvis', 'luna', 'alpha'];
const DEFAULT_MAINTENANCE = { enhanced: false, jarvis: false, luna: false, alpha: false };

async function redisCommand(command) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Upstash Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  }
  const response = await fetch(UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(6000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `Upstash request failed (${response.status})`);
  return data.result;
}

let maintenanceCache = { at: 0, value: { ...DEFAULT_MAINTENANCE } };
let maintenanceWarnedAt = 0;

// strict=true (admin page) throws on Redis problems. Normal bot use fails OPEN: if Upstash is
// missing/down, methods stay available instead of every button showing "Something went wrong".
async function getMaintenance(strict = false) {
  if (!strict && Date.now() - maintenanceCache.at < 5000) return maintenanceCache.value;
  try {
    const raw = await redisCommand(['GET', MAINTENANCE_KEY]);
    let saved = {};
    if (raw) {
      try { saved = JSON.parse(raw); } catch (_) { saved = {}; }
    }
    const value = Object.fromEntries(METHOD_KEYS.map(key => [key, saved[key] === true]));
    maintenanceCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    if (strict) throw err;
    if (Date.now() - maintenanceWarnedAt > 60000) {
      maintenanceWarnedAt = Date.now();
      console.warn('[maintenance] Redis unavailable, using last known settings:', scrub(err.message));
    }
    maintenanceCache.at = Date.now() - 3000;   // retry in ~2 s
    return maintenanceCache.value;
  }
}

async function setMaintenance(method, enabled) {
  if (!METHOD_KEYS.includes(method)) throw new Error('Unknown method.');
  const current = await getMaintenance(true);
  current[method] = enabled === true;
  await redisCommand(['SET', MAINTENANCE_KEY, JSON.stringify(current)]);
  maintenanceCache = { at: Date.now(), value: { ...current } };
  return current;
}

function isAdminRequest(req) {
  if (!ADMIN_TOKEN) return false;
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.token || '';
  const a = Buffer.from(String(supplied)), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

const INSTANCE_ID = crypto.randomBytes(3).toString('hex');

// One identity per user action. Using update_id alone is not enough: it differs when the same message
// reaches the bot through two paths (cloud + self-hosted Bot API, or two Render instances).
function updateKey(update) {
  if (!update) return '';
  const m = update.message || update.edited_message;
  if (update.message && m.chat) return `m:${m.chat.id}:${m.message_id}`;
  if (update.callback_query && update.callback_query.id) return `c:${update.callback_query.id}`;
  return Number.isInteger(update.update_id) ? `u:${update.update_id}` : '';
}

async function claimUpdate(key) {
  // Cross-instance / cross-restart guard. Needs Upstash; fails open if it is unavailable.
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return true;
  try {
    const result = await Promise.race([
      redisCommand(['SET', `jv-methods:seen:${key}`, INSTANCE_ID, 'NX', 'EX', '600']),
      new Promise((_, reject) => setTimeout(() => reject(new Error('dedupe timeout')), 1500))
    ]);
    return result !== null;
  } catch (_) {
    return true;
  }
}

bot.use(async (ctx, next) => {
  const key = updateKey(ctx.update);

  if (key) {
    const now = Date.now();

    for (const [id, timestamp] of seenUpdates) {
      if (now - timestamp > UPDATE_DEDUPE_TTL_MS) seenUpdates.delete(id);
    }

    if (seenUpdates.has(key)) {
      console.log(`[dedupe] ${INSTANCE_ID} ignored duplicate ${key} (update ${ctx.update.update_id})`);
      return;
    }

    seenUpdates.set(key, now);

    if (seenUpdates.size > UPDATE_DEDUPE_MAX) {
      seenUpdates.delete(seenUpdates.keys().next().value);
    }

    if (!(await claimUpdate(key))) {
      console.log(`[dedupe] ${INSTANCE_ID} ignored ${key}: already handled by another instance/path`);
      return;
    }

    console.log(`[update] ${INSTANCE_ID} ${key}`);
  }

  return next();
});

// A stale button ("query is too old") must never turn into a user-facing error.
bot.use((ctx, next) => {
  if (ctx.callbackQuery) {
    const original = ctx.answerCbQuery.bind(ctx);
    ctx.answerCbQuery = (...args) => original(...args).catch(() => {});
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
    label: '🌙 Luna'
  },
  jarvis: {
    label: '⚠️ Jarvis'
  },
  alpha: {
    label: '⚡ Alpha'
  },
};

const XORA_API = 'https://api.xora.sh/v1';
const XORA_API_KEY = process.env.XORA_API_KEY || '';
const ALPHA_VIDEO_BITRATE = process.env.ALPHA_VIDEO_BITRATE || '25M';
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

// ---------------------------------------------------------------------------
// Chat actions ("typing…", "sending video…" in the chat header) and ghost status
// messages. Instead of posting "processing…" messages into the chat, the bot
// shows Telegram's native chat action in the profile header. Status messages
// are "ghosts": edits to them are dropped, except errors and real content
// (messages with a keyboard/preview), which are sent as normal new messages.
// ---------------------------------------------------------------------------
const GHOST_ID = 'ghost-status';
const chatActionState = new Map();

function holdChatAction(chatId, action = 'typing') {
  let st = chatActionState.get(chatId);
  if (!st) {
    st = { stack: [], timer: null };
    chatActionState.set(chatId, st);
  }

  const token = { action };
  st.stack.push(token);

  const send = () => {
    const cur = st.stack[st.stack.length - 1];
    if (cur) bot.telegram.sendChatAction(chatId, cur.action).catch(() => {});
  };

  send();

  if (!st.timer) {
    st.timer = setInterval(send, 4000);
    st.timer.unref?.();
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(safety);

    const i = st.stack.indexOf(token);
    if (i >= 0) st.stack.splice(i, 1);

    if (!st.stack.length) {
      clearInterval(st.timer);
      if (chatActionState.get(chatId) === st) chatActionState.delete(chatId);
    } else {
      send();
    }
  };

  // Safety net so an indicator can never get stuck forever.
  const safety = setTimeout(release, 30 * 60 * 1000);
  safety.unref?.();

  return release;
}

function holdCtxAction(ctx, action = 'typing') {
  if (!ctx || !ctx.chat) return () => {};
  ctx.__actionReleases = ctx.__actionReleases || [];
  const release = holdChatAction(ctx.chat.id, action);
  ctx.__actionReleases.push(release);
  return release;
}

function releaseCtxActions(ctx) {
  const list = (ctx && ctx.__actionReleases) || [];
  ctx.__actionReleases = [];
  for (const release of list) release();
}

// Replaces `ctx.reply('processing…')`: shows "typing…" instead of a message.
async function statusReply(ctx, _text) {
  holdCtxAction(ctx, 'typing');
  return { message_id: GHOST_ID };
}

const _tgEditMessageText = Telegram.prototype.editMessageText;
Telegram.prototype.editMessageText = function (chatId, messageId, inlineMessageId, text, extra) {
  if (messageId === GHOST_ID) {
    const isError = typeof text === 'string' && text.trim().startsWith('❌');
    const hasExtra = extra && Object.keys(extra).length > 0;
    if (isError || hasExtra) return this.sendMessage(chatId, text, extra);
    return Promise.resolve(true);
  }
  return _tgEditMessageText.call(this, chatId, messageId, inlineMessageId, text, extra);
};

const _tgDeleteMessage = Telegram.prototype.deleteMessage;
Telegram.prototype.deleteMessage = function (chatId, messageId) {
  if (messageId === GHOST_ID) return Promise.resolve(true);
  return _tgDeleteMessage.call(this, chatId, messageId);
};

async function removeStatus(ctx, status) {
  if (!status || !status.message_id) return;
  await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
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

async function sendVideoFileImpl(ctx, filePath, caption) {
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

async function sendDocumentFileImpl(ctx, filePath, caption) {
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

// Show "sending video…" / "sending file…" in the chat header while uploading.
async function sendVideoFile(ctx, filePath, caption) {
  const release = holdChatAction(ctx.chat.id, 'upload_video');
  try {
    return await sendVideoFileImpl(ctx, filePath, caption);
  } finally {
    release();
  }
}

async function sendDocumentFile(ctx, filePath, caption) {
  const release = holdChatAction(ctx.chat.id, 'upload_document');
  try {
    return await sendDocumentFileImpl(ctx, filePath, caption);
  } finally {
    release();
  }
}


// ---- Kuronai error handling: every failure becomes one consistent message ----
class KuronaiError extends Error {
  constructor(stage, message, { code = '', http = 0 } = {}) {
    super(message);
    this.name = 'KuronaiError';
    this.stage = stage;
    this.code = code ? String(code).slice(0, 60) : '';
    this.http = http || 0;
  }
}

// Kuronai (FastAPI) may answer with a string, {msg}, [{loc,msg}], {message|error|detail}, HTML or plain text.
function kuronaiDetail(value, depth = 0) {
  if (value == null || depth > 3) return '';
  if (typeof value === 'string') {
    const text = value.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 300);
  }
  if (Array.isArray(value)) return value.map(v => kuronaiDetail(v, depth + 1)).filter(Boolean).slice(0, 3).join('; ');
  if (typeof value === 'object') {
    for (const key of ['message', 'msg', 'detail', 'error', 'reason', 'description']) {
      const found = kuronaiDetail(value[key], depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function kuronaiFriendly(http, text) {
  const t = String(text || '').toLowerCase();
  if (http === 413 || /too large|file size|exceeds/.test(t)) return 'The video is too large for this method.';
  if (http === 429 || /rate limit|too many|busy|queue/.test(t)) return 'The server is busy right now. Please wait a minute and try again.';
  if (http === 401 || http === 403) return 'The server refused the request (access denied).';
  if (http === 400 || http === 415 || http === 422 || /unsupported|invalid|corrupt|codec|format/.test(t)) return 'The server could not read this video. Try another file or export it again.';
  if (http >= 500 || /timed? ?out|unavailable|bad gateway|overload/.test(t)) return 'The processing server is temporarily unavailable.';
  return '';
}

async function kuronaiHttpError(stage, response) {
  let body = '';
  try { body = await response.text(); } catch (_) {}
  let detail = '';
  try { detail = kuronaiDetail(JSON.parse(body)); } catch (_) { detail = kuronaiDetail(body); }
  const friendly = kuronaiFriendly(response.status, detail);
  const message = friendly || detail || 'The server returned an unexpected response.';
  return new KuronaiError(stage, friendly && detail ? `${friendly}\nServer said: ${detail}` : message, { http: response.status });
}

function kuronaiNetworkError(stage, err) {
  const cause = err && err.cause && (err.cause.code || err.cause.message) || '';
  const timeout = /timeout|aborted/i.test(String(err && err.name) + String(err && err.message) + cause);
  return new KuronaiError(stage, timeout ? 'The server took too long to respond.' : 'Could not reach the processing server.', { code: cause || (err && err.name) });
}

// Final text shown to the user (always the same layout).
function formatKuronaiFailure(title, err, fallbackStage) {
  const stage = (err && err.stage) || fallbackStage;
  const reason = scrub(err && err.message || 'Unknown error').slice(0, 700);
  const code = err && (err.http ? `HTTP ${err.http}` : err.code) || '';
  return `❌ ${title} failed\n\nStage: ${stage}\nReason: ${reason}${code ? `\nCode: ${code}` : ''}\n\nYour original video is still available. Choose a method to try again.`;
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

  let response;

  try {
    response = await fetch(KURONAI_API + route, { method: 'POST', body: form });
  } catch (err) {
    throw kuronaiNetworkError('Upload', err);
  }

  if (!response.ok) throw await kuronaiHttpError('Upload', response);

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
          throw new KuronaiError(
            'Server processing',
            kuronaiFriendly(0, kuronaiDetail(event)) || kuronaiDetail(event) || 'The server could not process this video.',
            { code: typeof event.code === 'string' || typeof event.code === 'number' ? event.code : '' }
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
          throw new KuronaiError('Server processing', kuronaiDetail(event) || 'The server could not process this video.', { code: event.code });
        }

      } catch (e) {
        if (e instanceof KuronaiError) throw e;
      }
    }

  } else {
    result = await response.json().catch(() => null);
  }

  if (!result || typeof result.file_id !== 'string' || !result.file_id) {
    throw new KuronaiError('Server processing', 'The server finished but did not return a result file.');
  }

  return result.file_id;
}

async function kuronaiDownload(fileId, outputPath, onProgress) {
  let response;

  try {
    response = await fetch(`${KURONAI_API}/download/${encodeURIComponent(fileId)}`);
  } catch (err) {
    throw kuronaiNetworkError('Result download', err);
  }

  if (!response.ok) throw await kuronaiHttpError('Result download', response);
  if (!response.body) throw new KuronaiError('Result download', 'The server sent an empty response.');

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
    throw new KuronaiError('Result download', 'The server returned an empty output file.');
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
  const maintenance = await getMaintenance();
  if (maintenance[mode]) throw new Error(`${mode === 'enhanced' ? 'Enhanced Method' : 'Jarvis'} is currently under maintenance.`);
  const enhanced = mode === 'enhanced';
  const route = enhanced ? '/uploaden/' : '/upload/';
  const title = enhanced ? 'Enhanced Method' : 'Jarvis';
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
  let stage = 'Upload';

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
    stage = 'Result download';

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

    stage = 'Telegram delivery';

    const delivery = await sendVideoFile(
      ctx,
      outputPath,
      `✅ ${title} complete\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON — re-encode requested' : 'OFF — re-encode disabled')}`
    );

    // Video is released: the progress message disappears (Telegram delete animation).
    await removeStatus(ctx, status);

    await removePendingVideo(ctx.from.id, pending);

  } catch (err) {
    await stopProgress();

    await editProgress(
      ctx,
      status.message_id,
      formatKuronaiFailure(title, err, stage),
      true
    );

    err.__reported = true;
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
  const maintenance = await getMaintenance();
  if (maintenance[methodKey]) throw new Error('Luna is currently under maintenance.');
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

    await removeStatus(ctx, status);

    await removePendingVideo(userId, pending);

  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `❌ Processing failed: ${scrub(err.message)}`
    ).catch(() => {});

    err.__reported = true;
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
      .replace(/m$/i, '000000')) || 25000000;

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
    '-vf', 'scale=-2:1080:flags=lanczos',
    '-c:v', 'wmv2', '-b:v', ALPHA_VIDEO_BITRATE,
    '-maxrate', '28M', '-bufsize', '50M',
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
  const maintenance = await getMaintenance();
  if (maintenance.alpha) throw new Error('Alpha is currently under maintenance.');
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
      `✅ Alpha completed\nOutput: 1080p WMV2\n${targetFps ? `FPS patch: ${targetFps} FPS\nTimestamp scale: ${estimate.scaleFactor.toFixed(4)}x\n` : 'FPS patch: Off\n'}Estimated duration: ${fmtTime(estimate.outputDuration)}\nEstimated size: ${estimate.estimatedMB.toFixed(1)} MB`;

    await sendDocumentFile(
      ctx,
      outputPath,
      caption
    );

    await removeStatus(ctx, status);

    await removePendingVideo(ctx.from.id, pending);

  } catch (err) {
    await editProgress(
      ctx,
      status.message_id,
      `❌ Alpha failed\n${scrub(err.message || err).slice(0, 1000)}\n\nYour original video is still available.`,
      true
    );

    err.__reported = true;
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
    [Markup.button.callback('🟢 Enhanced', 'method:enhanced:info')],
    [Markup.button.callback('⚠️ HD Method', 'menu:hd')],
    [Markup.button.callback('⚡ Alpha', 'menu:alpha')],
  ]);
}

function hdKeyboard(maintenance = DEFAULT_MAINTENANCE) {
  const label = (key, title) => `${maintenance[key] ? '🛠 ' : ''}${title}${maintenance[key] ? ' (Maintenance)' : ''}`;
  return Markup.inlineKeyboard([
    [Markup.button.callback(label('jarvis', '⚠️ Jarvis'), 'menu:jarvis')],
    [Markup.button.callback(label('luna', '🌙 Luna'), 'method:luna:info')],
    [Markup.button.callback('⬅️ Back', 'menu:main')],
  ]);
}

function optimizerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Optimizer ON', 'jarvis:optimizer:on')],
    [Markup.button.callback('⚪ Optimizer OFF', 'jarvis:optimizer:off')],
    [Markup.button.callback('⬅️ Back', 'menu:hd')],
  ]);
}

function methodInfoKeyboard(method) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(method === 'luna' ? '🚀 Run Process' : '🚀 Continue', `method:${method}:run`)],
    [Markup.button.callback('⬅️ Back', method === 'luna' ? 'menu:hd' : 'menu:main')],
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

  const status = await statusReply(ctx, '📥 Downloading your video…');
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
  } finally {
    releaseCtxActions(ctx);
  }
});

// Menus
bot.action('menu:main', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText('Choose a method:', mainKeyboard());
});

bot.action('menu:hd', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const maintenance = await getMaintenance();
    return ctx.editMessageText(
      'HD Method gives you up to 1080p 60fps with Jarvis.',
      hdKeyboard(maintenance)
    );
  } catch (err) {
    console.error('[maintenance] Read failed:', scrub(err.message));
    return ctx.editMessageText('Methods are temporarily unavailable. Please try again later.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu:main')]]));
  }
});

bot.action('menu:jarvis', async (ctx) => {
  await ctx.answerCbQuery();

  const maintenance = await getMaintenance();
  if (maintenance.jarvis) return ctx.editMessageText('🛠 Jarvis is currently under maintenance.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu:hd')]]));
  return ctx.editMessageText(
    'Optimizer\nUse this if you have not exported from HandBrake or compressed the file yet.',
    optimizerKeyboard()
  );
});

bot.action('menu:alpha', async (ctx) => {
  await ctx.answerCbQuery();

  const maintenance = await getMaintenance();
  if (maintenance.alpha) return ctx.editMessageText('🛠 Alpha is currently under maintenance.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu:main')]]));
  return ctx.editMessageText(
    'Alpha can give you up to 1080p 60fps or 30fps, depending on your choice. TikTok can still compress your video later, so HD Method is recommended.',
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

const busyInfo = new Map();

function withBusy(ctx, fn) {
  const id = ctx.from.id;
  const action = (ctx.callbackQuery && ctx.callbackQuery.data) || '';

  if (busyUsers.has(id)) {
    const info = busyInfo.get(id);

    // Same button again within seconds = double tap or a duplicate delivery of the same tap.
    // Ignore it silently instead of printing "already running" next to the task that just started.
    if (info && action && info.action === action && Date.now() - info.at < 20000) {
      console.log(`[busy] Ignored repeated "${action}" from ${id}`);
      return;
    }

    return ctx.reply('⏳ You already have a processing task running. Please wait until it finishes.');
  }

  busyUsers.add(id);
  busyInfo.set(id, { action, at: Date.now() });

  // The menu message the user just tapped disappears at once (Telegram's own
  // delete animation); progress is shown as a chat action in the header.
  if (ctx.callbackQuery) ctx.deleteMessage().catch(() => {});
  holdCtxAction(ctx, 'typing');

  (async () => {
    try {
      await fn();

    } catch (err) {
      console.error(
        '[task] Operation failed:',
        scrub(err && err.stack || err)
      );

      if (!(err && err.__reported)) {
        await ctx.reply(
          `❌ ${scrub(err && err.message || 'Operation failed.')}`
        ).catch(() => {});
      }

    } finally {
      releaseCtxActions(ctx);
      busyUsers.delete(id);
      busyInfo.delete(id);
    }
  })();
}

// Method information and confirmation screens
bot.action('method:enhanced:info', async (ctx) => {
  await ctx.answerCbQuery();
  const maintenance = await getMaintenance();
  if (maintenance.enhanced) return ctx.editMessageText('🛠 Enhanced Method is currently under maintenance.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu:main')]]));
  return ctx.editMessageText(
    'Enhanced Method can give you up to 1080p 60fps or 30fps. TikTok decides the final quality and may compress the video.',
    methodInfoKeyboard('enhanced')
  );
});

bot.action('method:enhanced:run', async (ctx) => {
  await ctx.answerCbQuery();
  return withBusy(ctx, async () => {
    const maintenance = await getMaintenance();
    if (maintenance.enhanced) return ctx.reply('🛠 Enhanced Method is currently under maintenance.');
    const p = await getPending(ctx);
    if (p) await runKuronai(ctx, p, 'enhanced', false);
  });
});

bot.action('method:luna:info', async (ctx) => {
  await ctx.answerCbQuery();
  const maintenance = await getMaintenance();
  if (maintenance.luna) return ctx.editMessageText('🛠 Luna is currently under maintenance.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu:hd')]]));
  return ctx.editMessageText('Luna', methodInfoKeyboard('luna'));
});

bot.action('method:luna:run', async (ctx) => {
  await ctx.answerCbQuery();
  return withBusy(ctx, async () => {
    const maintenance = await getMaintenance();
    if (maintenance.luna) return ctx.reply('🛠 Luna is currently under maintenance.');
    const p = await getPending(ctx);
    if (p) await runLocalMethod(ctx, p, 'luna');
  });
});

bot.action(/^jarvis:optimizer:(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const maintenance = await getMaintenance();
  if (maintenance.jarvis) return ctx.editMessageText('🛠 Jarvis is currently under maintenance.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu:hd')]]));
  const enabled = ctx.match[1] === 'on';
  return ctx.editMessageText(
    `Jarvis selected\nOptimizer: ${enabled ? 'ON (re-encode)' : 'OFF (no re-encode)'}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Run Jarvis', `jarvis:run:${enabled ? 'on' : 'off'}`)],
      [Markup.button.callback('⬅️ Back', 'menu:jarvis')]
    ])
  );
});

bot.action(/^jarvis:run:(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return withBusy(ctx, async () => {
    const maintenance = await getMaintenance();
    if (maintenance.jarvis) return ctx.reply('🛠 Jarvis is currently under maintenance.');
    const p = await getPending(ctx);
    if (p) await runKuronai(ctx, p, 'jarvis', ctx.match[1] === 'on');
  });
});

bot.action('alpha:confirm', async (ctx) => {
  await ctx.answerCbQuery();
  if ((await getMaintenance()).alpha) return ctx.reply('🛠 Alpha is currently under maintenance.');

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
  if ((await getMaintenance()).alpha) { await ctx.answerCbQuery('Alpha is under maintenance.', { show_alert: true }); return; }

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

// TikTok links are processed by the external Netlify backend and returned in Telegram.
// The bot no longer opens the HTML Mini App for incoming TikTok URLs.
function formatCount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return String(value || 0);
  return n.toLocaleString('en-US');
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(Number(value || 0)));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

async function requestTikTokBackend(action, url, extra = {}) {
  if (!TIKTOK_API_URL) {
    throw new Error('TikTok backend is not configured. Set TIKTOK_API_URL in the bot environment.');
  }

  const headers = { 'content-type': 'application/json' };
  if (TIKTOK_API_SECRET) headers.authorization = `Bearer ${TIKTOK_API_SECRET}`;

  const response = await fetch(TIKTOK_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, url, ...extra }),
    signal: AbortSignal.timeout(55000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error || `TikTok backend returned HTTP ${response.status}.`);
  }
  return payload;
}

function flagEmoji(code) {
  const c = String(code || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map(ch => 127397 + ch.charCodeAt(0))) : '';
}

function postedDateTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000)
    .toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' })
    .replace(' at ', ', ');
}

// "Check" message: video analytics (HTML). Bold titles/values, italic labels, quotes for each block.
function formatTikTokResult(payload) {
  const d = payload.data || {};
  const a = d.author || {}, v = d.video || {}, st = d.stats || {}, sound = d.sound || {}, m = payload.media || {};
  const esc = escHtml;
  const row = (icon, label, value) => `${icon} <b>${label}</b> | ${value}`;
  const stat = (icon, value, label) => `${icon} <b>${formatCount(value)}</b> <i>${label}</i>`;
  const quote = (lines, expandable = false) => `<blockquote${expandable ? ' expandable' : ''}>${lines.join('\n')}</blockquote>`;
  const out = [];

  out.push('🎬 <b>VIDEO • ANALYTICS</b>', '');

  const date = postedDateTime(v.posted_at);
  out.push(`👤 <b>${esc(a.nickname || a.username || 'Unknown')}</b>${date ? `  📅 <i>${date}</i>` : ''}`);

  let desc = String(d.title || '').trim();
  if (!desc && Array.isArray(d.tags) && d.tags.length) desc = d.tags.map(t => '#' + String(t).replace(/^#/, '')).join(' ');
  if (desc.length > 700) desc = desc.slice(0, 697) + '…';
  if (desc) out.push(quote([`<i>${esc(desc)}</i>`], true));

  if (sound.title || sound.artist) {
    const dur = sound.duration || v.duration;
    out.push(`🎵 <b><i>${esc(sound.title || sound.artist)}</i></b>${dur ? ` • <b>${formatDuration(dur)}</b>` : ''}`);
  }

  out.push('', '📊 <b>Statistics</b>', quote([
    stat('👁', st.views, 'Views'), stat('❤️', st.likes, 'Likes'), stat('💬', st.comments, 'Comments'),
    stat('🔖', st.favorites, 'Favorites'), stat('↗️', st.shares, 'Shares'), stat('⬇️', st.downloads, 'Downloads')
  ]));

  const info = [];
  if (v.id) info.push(row('🆔', 'ID', `<code>${esc(v.id)}</code>`));
  if (v.region) info.push(row('📍', 'Region', `${flagEmoji(v.region)} <i>${esc(regionName(v.region))}</i>`.trim()));
  if (v.vq_score != null) info.push(row('✨', 'VQ Score', `<b>${esc(v.vq_score)}</b>`));
  if (info.length) out.push('', 'ℹ️ <b>Information</b>', quote(info));

  const details = [];
  if (m.resolution) details.push(row('📐', 'Resolution', `<code>${esc(m.resolution)}</code>`));
  if (m.fps != null) details.push(row('🎞', 'FPS', `<code>${esc(m.fps)}</code>`));
  if (m.video_codec || m.codec) details.push(row('🎥', 'Video codec', `<i>${esc(m.video_codec || m.codec)}</i>`));
  if (m.audio_codec) details.push(row('🔊', 'Audio codec', `<i>${esc(m.audio_codec)}</i>`));
  if (m.pixel_format) details.push(row('🎨', 'Pixel format', `<i>${esc(m.pixel_format)}</i>`));
  if (m.bitrate) details.push(row('📊', 'Bitrate', `<b>${(m.bitrate / 1e6).toFixed(1)} Mbps</b>`));
  if (m.duration) details.push(row('⏱', 'Duration', `<b>${formatDuration(m.duration)}</b>`));
  if (m.file_size) details.push(row('📁', 'File size', `<b>${(m.file_size / 1048576).toFixed(1)} MB</b>`));
  if (details.length) out.push('', '🎞 <b>Video details</b>', quote(details, true));

  out.push('', '⚡ <b><i>JV Methods</i></b>');
  return out.join('\n').slice(0, 4000);
}

// ---- TikTok card (stateless: nothing is stored, every button carries the video id) -------
const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function regionName(code) {
  if (!code) return '';
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(String(code).toUpperCase()) || String(code); }
  catch (_) { return String(code); }
}

function postedDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function mbText(bytes) {
  const n = Number(bytes);
  return Number.isFinite(n) && n > 0 ? `${(n / 1048576).toFixed(1)}MB` : '';
}

function qualityLabel({ width, height, fps, size }) {
  const parts = [];
  const side = Math.min(Number(width) || 0, Number(height) || 0);
  if (side) parts.push(`${side}p`);
  if (Number.isFinite(fps) && fps > 0) parts.push(`${Math.round(fps)}fps`);
  const mb = mbText(size);
  if (mb) parts.push(mb);
  return parts.length ? `⬇️ ${parts.join(' • ')}` : null;
}

// Reads resolution + fps straight from the remote file with FFprobe (only the header is fetched, ~1-3 s)
// and the size from Content-Length, so the button can say "576p • 30fps • 6.1MB" right away.
async function probeStandardQuality(url, timeoutMs = 10000) {
  if (!url) return null;
  const args = ['-v', 'error', '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'];
  try { if (/(^|\.)tikwm\.com$/i.test(new URL(url).hostname)) args.push('-headers', 'Referer: https://www.tikwm.com/\r\n'); } catch (_) {}
  args.push('-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate', '-show_entries', 'format=size', '-of', 'json', url);

  const probe = await new Promise((resolve, reject) => {
    execFile(FFPROBE, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });

  const st = (probe.streams || [])[0] || {};
  let size = Number(probe.format && probe.format.size) || 0;
  if (!size) {
    try {
      const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
      size = Number(head.headers.get('content-length')) || 0;
    } catch (_) {}
  }
  let fps = parseFps(st.avg_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) fps = parseFps(st.r_frame_rate);
  return qualityLabel({ width: st.width, height: st.height, fps, size });
}

const hasResolution = (label) => /\d+p\b/.test(String(label || ''));

// Fallback that does not depend on FFprobe's own network/TLS support: download the first
// ~3 MB of the file with fetch (MP4 headers sit at the start), then probe the local copy.
async function probeByRangeDownload(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.tikwm.com/',
    'Range': 'bytes=0-3145727'
  };
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok && res.status !== 206) throw new Error(`Video download HTTP ${res.status}`);

  let total = 0;
  const range = res.headers.get('content-range');
  if (range && /\/(\d+)$/.test(range)) total = Number(RegExp.$1);
  else total = Number(res.headers.get('content-length')) || 0;

  const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 3145728);
  const file = path.join(os.tmpdir(), `ttprobe_${crypto.randomBytes(6).toString('hex')}.mp4`);
  await fs.promises.writeFile(file, buf);

  try {
    const probe = await new Promise((resolve, reject) => {
      execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate', '-of', 'json', file],
        { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(err);
          try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
        });
    });
    const st = (probe.streams || [])[0] || {};
    let fps = parseFps(st.avg_frame_rate);
    if (!Number.isFinite(fps) || fps <= 0) fps = parseFps(st.r_frame_rate);
    return qualityLabel({ width: st.width, height: st.height, fps, size: total });
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

async function resolveStandardLabel(d, link) {
  const dl = d.downloads || {};
  const v = d.video || {};
  const abs = (u) => (u && u.startsWith('/') ? 'https://www.tikwm.com' + u : u);
  const urls = [dl.video, dl.hd].map(abs).filter((u, i, a) => u && a.indexOf(u) === i);

  for (const url of urls) {
    // 1) FFprobe straight on the URL.
    try {
      const label = await probeStandardQuality(url, 15000);
      if (hasResolution(label)) return label;
      console.warn('[tiktok] FFprobe on URL returned no resolution:', label);
    } catch (err) {
      console.warn('[tiktok] FFprobe on URL failed:', scrub(err && err.message || err));
    }
    // 2) Download the file head ourselves, then FFprobe the local copy.
    try {
      const label = await probeByRangeDownload(url);
      if (hasResolution(label)) return label;
      console.warn('[tiktok] Range probe returned no resolution:', label);
    } catch (err) {
      console.warn('[tiktok] Range probe failed:', scrub(err && err.message || err));
    }
  }

  // 3) Ask the backend to probe the exact Standard file.
  if (link) {
    try {
      const r = await requestTikTokBackend('analyze', link, { quality: 'standard' });
      const m = r.media || {};
      const label = qualityLabel({
        width: m.width,
        height: m.height,
        fps: Number(m.fps),
        size: m.file_size || v.size
      });
      if (hasResolution(label)) return label;
      console.warn('[tiktok] Backend analyze returned no resolution:', JSON.stringify(m).slice(0, 200));
    } catch (err) {
      console.warn('[tiktok] Backend quality probe failed:', scrub(err && err.message || err));
    }
  }

  // Last resort: whatever the backend reported about the standard video (size only).
  return qualityLabel({
    width: v.width || v.w,
    height: v.height || v.h,
    fps: Number(v.fps || v.frame_rate || v.framerate),
    size: v.size
  });
}

function tiktokCaption(d) {
  const a = d.author || {}, v = d.video || {};
  const head = [
    `👤 <b>${escHtml(a.nickname || a.username || 'Unknown')}</b>`,
    postedDate(v.posted_at) && `📅 <i>${postedDate(v.posted_at)}</i>`
  ].filter(Boolean).join('  ·  ');
  const region = regionName(v.region);
  const flag = flagEmoji(v.region);
  let desc = String(d.title || '').trim();
  if (desc.length > 600) desc = desc.slice(0, 597) + '…';
  const quote = [head, region && `📍 <b>${flag ? flag + ' ' : ''}${escHtml(region)}</b>`, desc && `<i>${escHtml(desc)}</i>`].filter(Boolean).join('\n');
  return `<blockquote expandable>${quote}</blockquote>\n<b>↓ Choose an action</b>`;
}

// callback_data = "tt:<action>:<videoId>[:<username>]" (max 64 bytes) - the bot keeps no state at all.
const TT_CALLBACK = /^tt:(std|mp3|original|check):(\d{5,25})(?::([\w.]{1,24}))?$/;
function ttData(action, d) {
  const id = String(d.video && d.video.id || '');
  const user = String(d.author && d.author.username || '');
  return `tt:${action}:${id}${/^[\w.]{1,24}$/.test(user) ? ':' + user : ''}`;
}
function ttUrl(id, user) {
  return `https://www.tiktok.com/@${user || '_'}/video/${id}`;
}

function tiktokKeyboard(d, label) {
  const size = mbText(d.video && d.video.size);
  const rows = [
    [Markup.button.callback(label || `⬇️ ${size || 'Video'}`, ttData('std', d))],
    [
      Markup.button.callback('⚡ Original', ttData('original', d)),
      Markup.button.callback('🎵 MP3', ttData('mp3', d)),
      Markup.button.callback('📊 Check', ttData('check', d))
    ]
  ];
  const user = d.author && d.author.username;
  if (user) rows.push([Markup.button.url(`🎵 ${d.author.nickname || user}`, `https://www.tiktok.com/@${encodeURIComponent(user)}`)]);
  return Markup.inlineKeyboard(rows);
}

async function sendTikTokPreview(ctx, d, label) {
  const caption = tiktokCaption(d);
  const keyboard = tiktokKeyboard(d, label);
  const photoExtra = { caption, parse_mode: 'HTML', has_spoiler: true, ...keyboard };
  const cover = d.cover;

  if (cover) {
    try {
      return await ctx.telegram.sendPhoto(ctx.chat.id, cover, photoExtra);
    } catch (_) {
      // Telegram could not fetch the cover URL itself: download it here and upload the bytes.
      try {
        const r = await fetch(cover, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('cover');
        return await ctx.telegram.sendPhoto(ctx.chat.id, { source: Buffer.from(await r.arrayBuffer()) }, photoExtra);
      } catch (_) {}
    }
  }

  return ctx.telegram.sendMessage(ctx.chat.id, caption, { parse_mode: 'HTML', ...keyboard });
}

async function tiktokDeliver(ctx, d, { title, kind, caption, getUrl }) {
  const status = await statusReply(ctx, `⏳ ${title}…`);
  const setStatus = (text) => ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, text).catch(() => {});
  let outputPath;

  try {
    const fileUrl = await getUrl(setStatus);
    if (!fileUrl) throw new Error('No download link is available for this video.');
    outputPath = tempPath(ctx.from.id, 'tiktok', kind === 'audio' ? '.mp3' : '.mp4');
    await setStatus('⬇️ Downloading…');
    await downloadToFile(fileUrl, outputPath, MAX_UPLOAD_BYTES);
    await setStatus('📤 Sending…');

    if (kind === 'audio') {
      const sound = d.sound || {};
      const releaseAudio = holdChatAction(ctx.chat.id, 'upload_voice');
      try {
        await ctx.replyWithAudio({ source: outputPath }, { title: sound.title || 'TikTok sound', performer: sound.artist || undefined, caption });
      } finally {
        releaseAudio();
      }
    } else {
      await sendVideoFile(ctx, outputPath, caption);
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (err) {
    await setStatus(`❌ ${title} failed\n${scrub(err && err.message || err).slice(0, 900)}\n\nSend the link again to retry.`);
  } finally {
    if (outputPath) await fs.promises.unlink(outputPath).catch(() => {});
  }
}

// Every card button: the card disappears at once (Telegram's own delete animation), then the action runs.
function ttAction(action, work) {
  bot.action(new RegExp(`^tt:${action}:\\d{5,25}(?::[\\w.]{1,24})?$`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const [, , id, user] = TT_CALLBACK.exec(ctx.callbackQuery.data) || [];
    if (!id) return;

    withBusy(ctx, async () => {
      await ctx.deleteMessage().catch(() => {});
      const url = ttUrl(id, user);
      let d;
      try {
        d = (await requestTikTokBackend('check', url)).data || {};
      } catch (err) {
        return ctx.reply(`❌ Could not load the video.\n${scrub(err && err.message || err).slice(0, 700)}\n\nSend the link again to retry.`);
      }
      return work(ctx, d, url);
    });
  });
}

ttAction('std', (ctx, d) => tiktokDeliver(ctx, d, {
  title: 'Standard video', kind: 'video', caption: '✅ Standard quality',
  getUrl: async () => d.downloads && (d.downloads.video || d.downloads.hd)
}));

ttAction('mp3', (ctx, d) => tiktokDeliver(ctx, d, {
  title: 'MP3 download', kind: 'audio', caption: '🎵 TikTok audio',
  getUrl: async () => (d.downloads && d.downloads.audio) || (d.sound && d.sound.url)
}));

ttAction('original', (ctx, d, url) => tiktokDeliver(ctx, d, {
  title: 'Original download', kind: 'video', caption: '✅ Original / best available TikTok quality',
  getUrl: async (setStatus) => {
    const submitted = await requestTikTokBackend('original_submit', url);
    if (!submitted.task_id) throw new Error('Original download task was not created.');
    await setStatus('⏳ Preparing the original-quality video…');
    let lastStatus = 'processing';
    for (let attempt = 0; attempt < 25; attempt++) {
      await sleep(2000);
      const result = await requestTikTokBackend('original_status', url, { task_id: submitted.task_id });
      lastStatus = result.status || lastStatus;
      if (result.original_download) return result.original_download;
      if (/failed|error/i.test(String(lastStatus))) throw new Error(`Original download provider status: ${lastStatus}`);
    }
    throw new Error('TikTok provider did not return the original video link in time. Please try again.');
  }
}));

ttAction('check', async (ctx, d, url) => {
  const status = await statusReply(ctx, '🔎 Checking video details…');
  try {
    const result = await requestTikTokBackend('analyze', url, { quality: 'standard' });
    // The standard video is attached as a link preview above the text (like a video card).
    const previewUrl = d.downloads && (d.downloads.video || d.downloads.hd);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, formatTikTokResult(result), {
      parse_mode: 'HTML',
      link_preview_options: previewUrl ? { url: previewUrl, show_above_text: true, prefer_large_media: true } : { is_disabled: true }
    });
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Check failed\n${scrub(err && err.message || err).slice(0, 900)}`).catch(() => {});
  } finally {
    releaseCtxActions(ctx);
  }
});

bot.on('text', async (ctx) => {
  const found = (ctx.message.text || '').match(/https?:\/\/[^\s]+/);
  const link = found && found[0];
  if (!link || !validTikTokUrl(link)) return;

  const status = await statusReply(ctx, '🔎 Fetching video…');
  try {
    const d = (await requestTikTokBackend('check', link)).data || {};
    if (!d.video || !d.video.id) throw new Error('Could not read the video ID from this link.');
    const label = await resolveStandardLabel(d, link);
    await sendTikTokPreview(ctx, d, label);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (err) {
    console.error('[tiktok-backend]', scrub(err && err.stack || err));
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `❌ TikTok check failed.\n\n${scrub(err && err.message || 'Backend request failed.').slice(0, 1200)}`).catch(() => {});
  } finally {
    releaseCtxActions(ctx);
  }
});

// Error handling
bot.catch((err, ctx) => {
  const benign = String(err && err.message || err);
  if (/message is not modified|query is too old|query ID is invalid/i.test(benign)) return;
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

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', scrub(reason && reason.stack || reason)));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', scrub(err && err.stack || err)));

// Express server and webhook
const app = express();

app.use(express.json({ limit: '1mb' }));

const maintenanceHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JV Methods Maintenance</title>
<style>body{font:16px system-ui;background:#101522;color:#eef2ff;margin:0;padding:24px}.wrap{max-width:620px;margin:auto}h1{font-size:23px}.sub{color:#aab5cc}.item{display:flex;align-items:center;justify-content:space-between;background:#1b2538;padding:16px;border-radius:12px;margin:12px 0}.name{font-weight:650}.state{font-size:13px;color:#aab5cc;margin-top:4px}button{border:0;border-radius:22px;padding:10px 16px;font-weight:700;background:#334155;color:white}button.on{background:#b45309}#status{color:#9ca3af;margin-top:18px}</style></head>
<body><div class="wrap"><h1>JV Methods — Maintenance</h1><p class="sub">Changes are saved to Upstash Redis and survive Render restarts and deployments.</p><div id="items"></div><div id="status">Loading settings…</div></div>
<script>
const token=new URLSearchParams(location.search).get('token')||'';
const names={enhanced:'Enhanced Method',jarvis:'Jarvis',luna:'Luna',alpha:'Alpha'};
async function api(method,body){const r=await fetch('/api/maintenance',{method,headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const d=await r.json().catch(function(){return {};});if(!r.ok)throw new Error(d.error||'Request failed');return d;}
function draw(data){document.getElementById('items').innerHTML=Object.entries(names).map(function(e){var key=e[0],name=e[1],on=data[key]===true;return '<div class="item"><div><div class="name">'+name+'</div><div class="state">'+(on?'Under maintenance':'Available')+'</div></div><button data-key="'+key+'" data-enabled="'+(!on)+'" class="'+(on?'on':'')+'">'+(on?'Turn OFF':'Turn ON')+'</button></div>';}).join('');}
document.getElementById('items').addEventListener('click',function(ev){var b=ev.target.closest('button[data-key]');if(b)toggle(b.dataset.key,b.dataset.enabled==='true');});
async function load(){try{const d=await api('GET');draw(d.settings);document.getElementById('status').textContent='Connected · Settings saved';}catch(e){document.getElementById('status').textContent=e.message;}}
async function toggle(key,enabled){document.getElementById('status').textContent='Saving…';try{const d=await api('POST',{method:key,enabled});draw(d.settings);document.getElementById('status').textContent='Saved successfully';}catch(e){document.getElementById('status').textContent=e.message;}}
load();
</script></body></html>`;

app.get('/maintenance', (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).type('text').send('Unauthorized. Open this page with your ADMIN_TOKEN as ?token=…');
  res.setHeader('Cache-Control', 'no-store');
  return res.type('html').send(maintenanceHtml);
});

app.get('/api/maintenance', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { return res.json({ settings: await getMaintenance(true) }); }
  catch (err) { return res.status(503).json({ error: scrub(err.message) }); }
});

app.post('/api/maintenance', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { method, enabled } = req.body || {};
  if (!METHOD_KEYS.includes(method) || typeof enabled !== 'boolean') return res.status(400).json({ error: 'Invalid method or enabled value' });
  try { return res.json({ settings: await setMaintenance(method, enabled) }); }
  catch (err) { return res.status(503).json({ error: scrub(err.message) }); }
});

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
  ]).catch(err => console.error('[bot] setMyCommands failed:', scrub(err.message)));

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
