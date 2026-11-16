// JV Methods Bot — Enhanced / HD (Luna + Jarvis) / FFmpeg / TikTok Checker
// Node.js 20+

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const https = require('https');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const FormDataStream = require('form-data');
const telegramTransfer = require('./telegram-transfer');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
const WEBHOOK_PATH = `/webhook/${process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex')}`;
const METHODS_DIR = path.join(__dirname, 'methods');
const WORK_DIR = path.join(os.tmpdir(), 'jv_bot_work');
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 200);
const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;
if (!Number.isFinite(MAX_VIDEO_MB) || MAX_VIDEO_MB <= 0) throw new Error('MAX_VIDEO_MB must be a positive number.');

const KURONAI_API = 'https://api.kuronaiapp.com';

const PROJECT_YTDLP = path.join(__dirname, '.venv', 'bin', 'yt-dlp');
const PROJECT_PYTHON = path.join(__dirname, '.venv', 'bin', 'python');

const FFMPEG = process.env.FFMPEG_PATH || (require('ffmpeg-static') || 'ffmpeg');
const FFPROBE_PKG = require('ffprobe-static');
const FFPROBE = process.env.FFPROBE_PATH || (FFPROBE_PKG && FFPROBE_PKG.path) || 'ffprobe';

if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN environment variable.');
  process.exit(1);
}

if (typeof fetch !== 'function') {
  console.error('Node.js 18 or newer is required.');
  process.exit(1);
}

fs.mkdirSync(WORK_DIR, { recursive: true });

const bot = new Telegraf(BOT_TOKEN);
const pendingVideos = new Map();
const busyUsers = new Set();

const METHODS = {
  enhanced: { label: '🟢 Enhanced Method', route: '/uploaden/' },
  luna: { label: '🌙 Luna (MP4Patcher)' },
  jarvis: { label: '⚠️ Jarvis (Kuronai HQ)' },
  ffmpeg: { label: '🧰 FFmpeg Method' }
};

async function removePendingVideo(userId) {
  const pending = pendingVideos.get(userId);
  pendingVideos.delete(userId);
  if (pending && pending.inputPath) await fs.promises.unlink(pending.inputPath).catch(() => {});
}

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
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text);
  } catch (_) {}
}

async function assertVideoSize(filePath, label = 'Video') {
  const size = fs.statSync(filePath).size;
  if (size <= 0) throw new Error(`${label} is empty.`);
  if (size > MAX_VIDEO_BYTES) {
    throw new Error(`${label} is ${(size / 1048576).toFixed(1)} MB; configured maximum is ${MAX_VIDEO_MB} MB.`);
  }
  return size;
}

async function downloadToFile(url, destPath, maxBytes = MAX_VIDEO_BYTES) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new Error(`Download is ${(declared / 1048576).toFixed(1)} MB; configured maximum is ${MAX_VIDEO_MB} MB.`);
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new Error(`Downloaded file reached ${(received / 1048576).toFixed(1)} MB; configured maximum is ${MAX_VIDEO_MB} MB.`));
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(destPath, { flags: 'wx' }));
    if (!received) throw new Error('The downloaded file is empty.');
    return received;
  } catch (error) {
    await fs.promises.unlink(destPath).catch(() => {});
    throw error;
  }
}

async function telegramDownload(ctx, file, userId) {
  const ext = path.extname(file.file_name || '') || '.mp4';
  const inputPath = tempPath(userId, 'input', ext);
  try {
    if (file.file_size && file.file_size > MAX_VIDEO_BYTES) {
      throw new Error(`Incoming video is ${(file.file_size / 1048576).toFixed(1)} MB; configured maximum is ${MAX_VIDEO_MB} MB.`);
    }
    await telegramTransfer.downloadMessageMedia(ctx.chat.id, ctx.message.message_id, inputPath);
    await assertVideoSize(inputPath, 'Incoming video');
    return inputPath;
  } catch (error) {
    await fs.promises.unlink(inputPath).catch(() => {});
    throw error;
  }
}

async function sendVideoFile(ctx, filePath, caption) {
  await assertVideoSize(filePath, 'Output video');
  const sourceMessage = ctx.message || (ctx.callbackQuery && ctx.callbackQuery.message);
  const topicId = sourceMessage && sourceMessage.message_thread_id;
  await telegramTransfer.uploadVideo(
    ctx.chat.id,
    filePath,
    String(caption || '').slice(0, 900),
    undefined,
    topicId
  );
}

// KURONAI SERVER UPLOAD

async function kuronaiUpload(inputPath, telegramId, route, encodeVideo, onProgress) {
  await assertVideoSize(inputPath, 'Kuronai input');
  const form = new FormDataStream();
  form.append('file', fs.createReadStream(inputPath), {
    filename: safeName(path.basename(inputPath)),
    contentType: 'video/mp4'
  });
  form.append('tg_id', String(telegramId));
  form.append('progress', 'true');
  if (route === '/upload/') form.append('encode_video', String(Boolean(encodeVideo)));

  const response = await new Promise((resolve, reject) => {
    const req = https.request(KURONAI_API + route, {
      method: 'POST',
      headers: form.getHeaders(),
      timeout: 30 * 60 * 1000
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Kuronai upload timed out.')));
    form.on('error', reject);
    form.pipe(req);
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    let detail = '';
    try { const chunks = []; for await (const chunk of response) chunks.push(chunk); const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); detail = j.detail || j.message || ''; } catch (_) {}
    throw new Error(detail || `Kuronai upload failed (HTTP ${response.statusCode}).`);
  }

  const contentType = response.headers['content-type'] || '';
  let result = null;

  if (contentType.includes('application/x-ndjson')) {
    let pending = '';
    for await (const chunk of response) {
      pending += chunk.toString('utf8');

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
          throw new Error(event.message || event.code || 'Kuronai server processing failed.');
        }

        if (event.type === 'progress' && onProgress) {
          onProgress(event);
        }

        if (event.type === 'complete') {
          result = event;
        }
      }

    }

    if (pending.trim()) {
      try {
        const event = JSON.parse(pending);

        if (event.type === 'progress' && onProgress) onProgress(event);
        if (event.type === 'complete') result = event;
        if (event.type === 'error') throw new Error(event.message || event.code);
      } catch (e) {
        if (e.message && !e.message.includes('Unexpected')) throw e;
      }
    }
  } else {
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  if (!result || typeof result.file_id !== 'string' || !result.file_id) {
    throw new Error('Kuronai response did not contain a file_id.');
  }

  return result.file_id;
}

async function kuronaiDownload(fileId, outputPath, onProgress) {
  const response = await fetch(`${KURONAI_API}/download/${encodeURIComponent(fileId)}`);
  if (!response.ok) throw new Error(`Kuronai result download failed (HTTP ${response.status}).`);
  const total = Number(response.headers.get('content-length') || 0);
  if (total && total > MAX_VIDEO_BYTES) {
    throw new Error(`Kuronai output is ${(total / 1048576).toFixed(1)} MB; configured maximum is ${MAX_VIDEO_MB} MB.`);
  }
  let received = 0;
  let lastPercent = -1;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_VIDEO_BYTES) return callback(new Error(`Kuronai output reached ${(received / 1048576).toFixed(1)} MB; configured maximum is ${MAX_VIDEO_MB} MB.`));
      if (onProgress && total) {
        const percent = Math.round(received / total * 100);
        if (percent !== lastPercent) { lastPercent = percent; onProgress(percent); }
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(outputPath, { flags: 'wx' }));
    if (!received) throw new Error('Kuronai returned an empty output file.');
    await assertVideoSize(outputPath, 'Kuronai output');
  } catch (error) {
    await fs.promises.unlink(outputPath).catch(() => {});
    throw error;
  }
}

async function kuronaiCleanup(fileId) {
  try {
    await fetch(`${KURONAI_API}/cleanup/${encodeURIComponent(fileId)}`, {
      method: 'DELETE'
    });
  } catch (_) {}
}

// KURONAI PROCESSING

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

  const timer = setInterval(() => {
    const pct = lastPercent === null ? 'Waiting for server progress' : `${lastPercent}%`;

    editProgress(
      ctx,
      status.message_id,
      `⚙️ ${title}\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON' : 'OFF')}\nServer encoding: ${pct}\nStage: ${lastStage}\nElapsed: ${fmtTime(Date.now() - started)}`
    ).catch(() => {});
  }, 3000);

  try {
    fileId = await kuronaiUpload(
      pending.inputPath,
      ctx.from.id,
      route,
      encodeVideo,
      (event) => {
        if (Number.isFinite(Number(event.percent))) {
          lastPercent = Math.max(0, Math.min(100, Math.round(Number(event.percent))));
        }

        if (event.stage || event.step) {
          lastStage = String(event.stage || event.step).slice(0, 50);
        }

        const pct = lastPercent === null ? 'Server working' : `${lastPercent}%`;

        editProgress(
          ctx,
          status.message_id,
          `⚙️ ${title}\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON' : 'OFF')}\nServer encoding: ${pct}\nStage: ${lastStage}\nElapsed: ${fmtTime(Date.now() - started)}`
        ).catch(() => {});
      }
    );

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

    await kuronaiDownload(fileId, outputPath, (percent) => {
      editProgress(
        ctx,
        status.message_id,
        `⬇️ ${title}\nDownloading result: ${percent}%\nElapsed: ${fmtTime(Date.now() - started)}`
      ).catch(() => {});
    });

    await editProgress(ctx, status.message_id, '📤 Sending processed video to Telegram…', true);

    await sendVideoFile(
      ctx,
      outputPath,
      `✅ ${title} complete\nOptimizer: ${enhanced ? 'N/A' : (encodeVideo ? 'ON — re-encode requested' : 'OFF — re-encode disabled')}`
    );

    await fs.promises.unlink(outputPath).catch(() => {});

    await editProgress(
      ctx,
      status.message_id,
      `✅ ${title} completed\nElapsed: ${fmtTime(Date.now() - started)}`,
      true
    );

    await removePendingVideo(ctx.from.id);
  } finally {
    clearInterval(timer);

    if (fileId) await kuronaiCleanup(fileId);
    if (outputPath) await fs.promises.unlink(outputPath).catch(() => {});
  }
}

// LOCAL PROCESSING

async function runLocalMethod(ctx, pending, methodKey, options = {}) {
  const userId = ctx.from.id;

  const outputPath = tempPath(
    userId,
    `out_${methodKey}`,
    path.extname(pending.inputPath) || '.mp4'
  );

  await assertVideoSize(pending.inputPath, 'Input video');
  const status = await ctx.reply(
    `⚙️ Processing with ${methodKey === 'luna' ? 'Luna (MP4Patcher)' : 'FFmpeg'}…`
  );

  try {
    const moduleFile = methodKey === 'luna' ? 'c_method.js' : 'ffmpage_method.js';

    const mod = loadMethod(moduleFile);

    let result;

    if (methodKey === 'ffmpeg') {
      result = await mod.process(pending.inputPath, outputPath, options);
    } else {
      await mod.process(pending.inputPath, outputPath);
    }

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('The method did not produce a valid output file.');
    }

    await assertVideoSize(outputPath, 'Processed output');
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      '📤 Uploading processed video…'
    );

    const caption = methodKey === 'ffmpeg'
      ? `✅ FFmpeg method completed\nSource FPS: ${result.sourceFps.toFixed(3)}\nSelected FPS: ${result.targetFps}\nTimestamp scale: ${result.scaleFactor.toFixed(4)}x\nMode: stream copy (no re-encoding)`
      : '✅ Luna MP4Patcher completed';

    await sendVideoFile(ctx, outputPath, caption);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      '✅ Processing complete.'
    );

    await removePendingVideo(userId);
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `❌ Processing failed: ${err.message}`
    ).catch(() => {});

    throw err;
  } finally {
    await fs.promises.unlink(outputPath).catch(() => {});
  }
}

// KEYBOARDS

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Enhanced Method', 'method:enhanced')],
    [Markup.button.callback('⚠️ HD Method', 'menu:hd')],
    [Markup.button.callback('🧰 FFmpeg Method', 'menu:ffmpeg')],
    [Markup.button.callback('🔎 Checker & Downloader', 'menu:checker')]
  ]);
}

function hdKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🌙 Luna — MP4Patcher', 'method:luna')],
    [Markup.button.callback('⚠️ Jarvis — Kuronai HQ', 'menu:jarvis')],
    [Markup.button.callback('⬅️ Back', 'menu:main')]
  ]);
}

function optimizerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Optimizer ON (re-encode)', 'jarvis:optimizer:on')],
    [Markup.button.callback('⚪ Optimizer OFF (no re-encode)', 'jarvis:optimizer:off')],
    [Markup.button.callback('⬅️ Back', 'menu:hd')]
  ]);
}

function ffmpegKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('30 FPS', 'ffmpeg:fps:30'), Markup.button.callback('60 FPS', 'ffmpeg:fps:60')],
    [Markup.button.callback('⬅️ Back', 'menu:main')]
  ]);
}

// TELEGRAM HANDLERS

bot.start(async (ctx) => {
  await removePendingVideo(ctx.from.id);
  return ctx.reply(
  '👋 Welcome to JV-60FPS\n\n📖 How to use:\n• Send a video to see processing methods.\n• Send a TikTok URL to automatically check its details and download options.\n\nNo method menu is shown until you send media.');
});

bot.help((ctx) => ctx.reply(
  'Send a video, then choose Enhanced, HD (Luna/Jarvis), or FFmpeg. For TikTok links choose Checker & Downloader.'
));

bot.on(['video', 'document'], async (ctx) => {
  const file = ctx.message.video || ctx.message.document;

  if (!file || (ctx.message.document && !(file.mime_type || '').startsWith('video/'))) {
    return;
  }

  const sizeMB = (file.file_size || 0) / 1048576;

  if (file.file_size && sizeMB > MAX_VIDEO_MB) {
    return ctx.reply(
      `⚠️ Video is ${sizeMB.toFixed(1)} MB. Current configured limit is ${MAX_VIDEO_MB} MB.`
    );
  }

  const status = await ctx.reply('📥 Downloading your video…');

  try {
    const inputPath = await telegramDownload(ctx, file, ctx.from.id);
    const previous = pendingVideos.get(ctx.from.id);
    if (previous && previous.inputPath && previous.inputPath !== inputPath) await fs.promises.unlink(previous.inputPath).catch(() => {});

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
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `❌ Download failed: ${err.message}`
    ).catch(() => {});
  }
});

bot.action('menu:main', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText('Choose a method:', mainKeyboard());
});

bot.action('menu:hd', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText('⚠️ HD METHOD\nChoose a processing engine:', hdKeyboard());
});

bot.action('menu:jarvis', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    '⚠️ JARVIS — HQ METHOD\n\nVideo Optimization\nChoose whether Kuronai should re-encode the video:',
    optimizerKeyboard()
  );
});

bot.action('menu:ffmpeg', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText('🎞 FFmpeg Method\nChoose target FPS:', ffmpegKeyboard());
});

bot.action('menu:checker', async (ctx) => {
  await ctx.answerCbQuery();

  pendingVideos.set(ctx.from.id, {
    ...(pendingVideos.get(ctx.from.id) || {}),
    awaitingTikTokUrl: true
  });

  return ctx.reply(
    '🔎 Checker & Downloader\nSend a public TikTok video URL. The JV server will extract available creator, region, video metadata and quality options using yt-dlp.'
  );
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

  if (busyUsers.has(id)) {
    await ctx.reply('⏳ You already have a processing task running.');
    return;
  }

  busyUsers.add(id);

  try {
    await fn();
  } catch (err) {
    console.error('[operation] ', err && err.message ? err.message : 'Operation failed');
    await ctx.reply(`❌ ${err.message || 'Operation failed.'}`).catch(() => {});
  } finally {
    busyUsers.delete(id);
  }
}

bot.action('method:enhanced', async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);
    if (p) await runKuronai(ctx, p, 'enhanced', false);
  });
});

bot.action('method:luna', async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);
    if (p) await runLocalMethod(ctx, p, 'luna');
  });
});

bot.action(/^jarvis:optimizer:(on|off)$/, async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);
    if (p) await runKuronai(ctx, p, 'jarvis', ctx.match[1] === 'on');
  });
});

bot.action(/^ffmpeg:fps:(30|60)$/, async (ctx) => {
  const fps = Number(ctx.match[1]);

  await ctx.answerCbQuery();

  return withBusy(ctx, async () => {
    const p = await getPending(ctx);
    if (p) await runLocalMethod(ctx, p, 'ffmpeg', { targetFps: fps });
  });
});

// TIKTOK EXTRACTION — YT-DLP ONLY
// TikWM is not used.

function validTikTokUrl(value) {
  try {
    const u = new URL(value);
    return /(^|\.)tiktok\.com$/i.test(u.hostname);
  } catch (_) {
    return false;
  }
}

function pick(...values) {
  return values.find(v => v !== undefined && v !== null && v !== '');
}

function prettyNum(v) {
  return v == null ? 'Unavailable' : Number(v).toLocaleString('en-US');
}

function execYtDlp(command, commandArgs, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, {
      timeout,
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
      env: process.env
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(Object.assign(err, {
          ytDlpDetail: String(stderr || err.message || 'yt-dlp failed')
            .trim()
            .split('\n')
            .slice(-5)
            .join('\n')
            .slice(-1600)
        }));
      }

      resolve({
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      });
    });
  });
}

// MATCH THE PYTHON INTERPRETER WITH THE INSTALLED YT-DLP MODULE.

async function runYtDlp(args, timeout = 20 * 60 * 1000) {
  const executableCandidates = [
    process.env.YTDLP_PATH,
    fs.existsSync(PROJECT_YTDLP) ? PROJECT_YTDLP : null,
    process.env.YTDLP_PATH ? null : 'yt-dlp'
  ].filter(Boolean);

  let lastExecutableError = null;

  for (const executable of [...new Set(executableCandidates)]) {
    try {
      return await execYtDlp(executable, args, timeout);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(err.ytDlpDetail || err.message || 'yt-dlp failed');
      }

      lastExecutableError = err;
    }
  }

  const pythonCandidates = [
    process.env.PYTHON_PATH,
    fs.existsSync(PROJECT_PYTHON) ? PROJECT_PYTHON : null,
    'python3'
  ].filter(Boolean);

  let lastPythonError = null;

  for (const python of [...new Set(pythonCandidates)]) {
    try {
      return await execYtDlp(
        python,
        ['-m', 'yt_dlp', ...args],
        timeout
      );
    } catch (err) {
      lastPythonError = err;

      if (err.code === 'ENOENT') {
        continue;
      }

      const detail = err.ytDlpDetail || err.message || 'Python yt-dlp module could not be started.';

      if (/No module named yt_dlp|No module named ['"]yt_dlp['"]/.test(detail)) {
        continue;
      }

      throw new Error(detail);
    }
  }

  const pythonDetail = lastPythonError &&
    (lastPythonError.ytDlpDetail || lastPythonError.message);

  throw new Error(
    `yt-dlp is unavailable. Check the Docker image installation and YTDLP_PATH environment variable. ` +
    `Then redeploy. Executable error: ${lastExecutableError ? lastExecutableError.message : 'not found'}. ` +
    `Python error: ${pythonDetail || 'No usable Python interpreter found.'}`
  );
}

// TIKTOK METADATA EXTRACTION

async function ytDlpInfo(url) {
  const { stdout } = await runYtDlp([
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--retries',
    '3',
    '--extractor-retries',
    '3',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    '--referer',
    'https://www.tiktok.com/',
    url
  ], 180000);

  let data;

  try {
    data = JSON.parse(stdout);
  } catch (_) {
    throw new Error('yt-dlp returned invalid metadata JSON.');
  }

  if (!data || !data.id) {
    throw new Error('yt-dlp could not identify this TikTok video.');
  }

  return data;
}

function formatSummary(info) {
  const formats = (info.formats || []).filter(
    f => f && f.vcodec && f.vcodec !== 'none'
  );

  const heights = [
    ...new Set(
      formats
        .map(f => Number(f.height))
        .filter(n => Number.isFinite(n) && n > 0)
    )
  ].sort((a, b) => b - a);

  return heights.length
    ? heights.slice(0, 8).map(h => `${h}p`).join(', ')
    : 'Not reported by extractor';
}

async function ytDlpDownload(url, quality, userId) {
  const base = tempPath(
    userId,
    quality === 'best' ? 'tiktok_best' : 'tiktok_standard',
    ''
  );

  const outputTemplate = `${base}.%(ext)s`;

  const selector = quality === 'best'
    ? 'bestvideo*+bestaudio/best'
    : 'best[height<=720]/best';

  let stdout;
  try {
    ({ stdout } = await runYtDlp([
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    '--max-filesize', `${MAX_VIDEO_MB}M`,
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    '--referer',
    'https://www.tiktok.com/',
    '-f',
    selector,
    '--merge-output-format',
    'mp4',
    '-o',
    outputTemplate,
    '--print',
    'after_move:filepath',
    url
    ], 30 * 60 * 1000));
  } catch (error) {
    const prefix = path.basename(base);
    const dir = userDir(userId);
    const leftovers = await fs.promises.readdir(dir).catch(() => []);
    await Promise.all(leftovers.filter(name => name.startsWith(prefix)).map(name => fs.promises.unlink(path.join(dir, name)).catch(() => {})));
    throw error;
  }

  const outputPath = stdout
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .pop();

  if (!outputPath || !fs.existsSync(outputPath)) {
    throw new Error('yt-dlp finished but did not produce an output file.');
  }

  return outputPath;
}

// MEDIA INSPECTION

async function inspectMedia(filePath) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries',
      'stream=codec_name,width,height,bit_rate,avg_frame_rate,r_frame_rate',
      '-show_entries',
      'format=duration,size,bit_rate',
      '-of', 'json',
      filePath
    ], {
      maxBuffer: 4 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error((stderr || err.message).slice(-1200)));
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (_) {
        reject(new Error('Could not parse FFprobe media details.'));
      }
    });
  });
}

function fpsValue(value) {
  if (!value || value === '0/0') {
    return 'Unavailable';
  }

  const [a, b = '1'] = String(value).split('/');
  const n = Number(a) / Number(b);

  return Number.isFinite(n) ? n.toFixed(3) : 'Unavailable';
}

// TIKTOK METADATA

async function processTikTokUrl(ctx, url) {
  const status = await ctx.reply(
    '🔎 Extracting TikTok details from the server with yt-dlp…'
  );

  try {
    const d = await ytDlpInfo(url);

    const formats = formatSummary(d);
    const region = pick(
      d.region,
      d.country,
      d.location,
      'Not provided by TikTok extractor'
    );

    const info = [
      '✅ TIKTOK VIDEO FOUND',
      `Title: ${pick(d.title, 'TikTok video')}`,
      `Creator: @${pick(d.uploader_id, d.channel_id, d.uploader, 'unknown')}`,
      `Uploader: ${pick(d.uploader, d.channel, 'Unavailable')}`,
      `Region/Country: ${region}`,
      `Video ID: ${pick(d.id, 'Unavailable')}`,
      '',
      '📊 STATISTICS',
      `Views: ${prettyNum(d.view_count)}`,
      `Likes: ${prettyNum(d.like_count)}`,
      `Comments: ${prettyNum(d.comment_count)}`,
      `Shares: ${prettyNum(d.repost_count)}`,
      '',
      '🎞 SERVER-EXTRACTED VIDEO DETAILS',
      `Duration: ${d.duration == null ? 'Unavailable' : `${Number(d.duration).toFixed(2)} sec`}`,
      `Extracted resolution: ${d.width && d.height ? `${d.width} × ${d.height}` : 'See available formats below'}`,
      `Available resolutions: ${formats}`,
      `FPS: ${d.fps || 'Not provided'}`,
      `Codec: ${pick(d.vcodec, 'Not provided in top-level metadata')}`,
      `File size: ${d.filesize || d.filesize_approx ? `${(Number(d.filesize || d.filesize_approx) / 1048576).toFixed(2)} MB${d.filesize_approx ? ' (approx.)' : ''}` : 'Not provided'}`,
      `Description: ${pick(d.description, 'Unavailable')}`.slice(0, 1000),
      '',
      'Details are extracted by yt-dlp on the JV server. Fields not supplied by TikTok are shown as unavailable.'
    ].join('\n');

    pendingVideos.set(ctx.from.id, {
      ...(pendingVideos.get(ctx.from.id) || {}),
      tiktokUrl: url,
      tiktokData: d
    });

    const buttons = [
      [Markup.button.callback('⬇️ Download Standard (up to 720p)', 'tiktok:download:standard')],
      [Markup.button.callback('⭐ Download Highest Available', 'tiktok:download:best')],
      [Markup.button.callback('🔍 Download & Inspect with FFprobe', 'tiktok:inspect')],
      [Markup.button.callback('⬅️ Main Menu', 'menu:main')]
    ];

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      info.slice(0, 3900),
      Markup.inlineKeyboard(buttons)
    );
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `❌ TikTok extraction failed: ${err.message}\n\nThis is the yt-dlp server response; TikWM is no longer used.`
    ).catch(() => {});
  }
}

// TIKTOK DOWNLOAD

async function downloadTikTokAndSend(ctx, quality, inspectOnly = false) {
  const p = pendingVideos.get(ctx.from.id);

  if (!p || !p.tiktokUrl) {
    return ctx.reply('Send a TikTok URL first.');
  }

  const msg = await ctx.reply(
    quality === 'best'
      ? '⭐ Downloading highest available quality on the server…'
      : '⬇️ Downloading standard quality on the server…'
  );

  let filePath;

  try {
    filePath = await ytDlpDownload(p.tiktokUrl, quality, ctx.from.id);
    await assertVideoSize(filePath, 'TikTok download');

    if (inspectOnly) {
      const meta = await inspectMedia(filePath);

      const stream = (meta.streams || [])[0] || {};
      const format = meta.format || {};

      const size = Number(format.size || fs.statSync(filePath).size);

      const lines = [
        '🧰 SERVER FFPROBE INSPECTION',
        `Codec: ${pick(stream.codec_name, 'Unavailable')}`,
        `Resolution: ${stream.width && stream.height ? `${stream.width} × ${stream.height}` : 'Unavailable'}`,
        `FPS: ${fpsValue(stream.avg_frame_rate || stream.r_frame_rate)}`,
        `Video bitrate: ${stream.bit_rate ? `${(Number(stream.bit_rate) / 1e6).toFixed(2)} Mbps` : 'Not provided'}`,
        `Container bitrate: ${format.bit_rate ? `${(Number(format.bit_rate) / 1e6).toFixed(2)} Mbps` : 'Not provided'}`,
        `File size: ${(size / 1048576).toFixed(2)} MB`,
        `Duration: ${format.duration ? `${Number(format.duration).toFixed(2)} sec` : 'Unavailable'}`
      ].join('\n');

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        lines
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        '📤 Sending downloaded video…'
      );

      await sendVideoFile(
        ctx,
        filePath,
        `✅ TikTok ${quality === 'best' ? 'highest available' : 'standard'} quality downloaded by JV server`
      );

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        '✅ Download completed and sent.'
      );
    }
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      `❌ TikTok ${inspectOnly ? 'inspection' : 'download'} failed: ${err.message}`
    ).catch(() => {});
  } finally {
    if (filePath) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  }
}

// TIKTOK BUTTONS

bot.action(/^tiktok:download:(standard|best)$/, async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, () =>
    downloadTikTokAndSend(
      ctx,
      ctx.match[1] === 'best' ? 'best' : 'standard'
    )
  );
});

bot.action('tiktok:inspect', async (ctx) => {
  await ctx.answerCbQuery();

  return withBusy(ctx, () =>
    downloadTikTokAndSend(ctx, 'best', true)
  );
});

// TEXT HANDLER

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  const pending = pendingVideos.get(ctx.from.id);

  if (pending && pending.awaitingTikTokUrl) {
    if (!validTikTokUrl(text)) {
      return ctx.reply(
        'That does not look like a valid TikTok URL. Please send a public tiktok.com link.'
      );
    }

    pending.awaitingTikTokUrl = false;
    pendingVideos.set(ctx.from.id, pending);

    return processTikTokUrl(ctx, text);
  }

  if (validTikTokUrl(text)) {
    return processTikTokUrl(ctx, text);
  }
});

// ERROR HANDLER

bot.catch((err, ctx) => {
  console.error('[bot] Error:', err && err.message ? err.message : 'Unknown bot error');

  if (ctx) {
    ctx.reply('❌ Something went wrong. Please try again.').catch(() => {});
  }
});

// RENDER WEB SERVER

const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'JV Methods Bot'
  });
});

app.use(bot.webhookCallback(WEBHOOK_PATH));

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Listening on ${PORT}`);

  try {
    await telegramTransfer.start();
    console.log('[mtproto] Telegram media transfer connected.');
  } catch (err) {
    console.error('[mtproto] Startup failed:', err.message);
    process.exit(1);
  }

  if (PUBLIC_URL) {
    try {
      await bot.telegram.setWebhook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
      console.log('[bot] Webhook registered.');
    } catch (err) {
      console.error('[bot] Webhook registration failed:', err.message);
    }
  } else {
    console.warn(
      '[bot] PUBLIC_URL / RENDER_EXTERNAL_URL missing. Set it for webhook deployment.'
    );
  }

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'How to use the bot' }
  ]);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Received ${signal}; shutting down.`);
  server.close();
  await telegramTransfer.shutdown();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
