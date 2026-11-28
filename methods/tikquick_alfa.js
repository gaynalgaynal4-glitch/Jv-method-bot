// Direct TikQuick Alfa adapter (alfa-v1).
// The bot obtains a short-lived OTU token from TikQuick's passport API,
// then sends the video directly to TikQuick's processing server.
// No Netlify proxy, Xora job server, or public bot input URL is involved.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const API_KEY = process.env.TIKQUICK_API_KEY || '';
const PASSPORT = (process.env.TIKQUICK_PASSPORT_URL || 'https://api.tikqcapi.site').replace(/\/$/, '');
const PRIMARY_PS = (process.env.TIKQUICK_ALFA_PS_URL || 'https://ps.tikquick.online').replace(/\/$/, '');
const FALLBACK_PS = 'https://tqps.mikeden.site';
const METHOD_ID = 'alfa-v1';
const CHUNK_SIZE = 20 * 1024 * 1024;
const CHUNK_THRESHOLD = 20 * 1024 * 1024;
const MAX_BYTES = Number(process.env.TIKQUICK_MAX_BYTES || 1500 * 1024 * 1024);

async function request(url, options = {}, timeout = 15 * 60 * 1000) {
  return fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeout)
  });
}

async function errorResponse(response, label) {
  const detail = (await response.text().catch(() => '')).slice(0, 1200);
  throw new Error(`${label} failed (HTTP ${response.status}): ${detail || response.statusText}`);
}

async function jsonRequest(url, options, label) {
  const response = await request(url, options);
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch (_) { data = { message: raw.slice(0, 800) }; }
  if (!response.ok) {
    throw new Error(`${label} failed (HTTP ${response.status}): ${String(data.error || data.message || raw).slice(0, 1000)}`);
  }
  return data;
}

async function mintOtu() {
  if (!API_KEY) {
    throw new Error('TikQuick is not configured. Add TIKQUICK_API_KEY to the bot hosting environment.');
  }
  const url = `${PASSPORT}/passport/api/thirdparty/genotu?key=${encodeURIComponent(API_KEY)}`;
  const data = await jsonRequest(url, {}, 'TikQuick Alfa authentication');
  if (!data.user_id || !data.token) {
    throw new Error('TikQuick authentication did not return user_id and token.');
  }
  return { userId: String(data.user_id), token: String(data.token) };
}

function makeUrl(base, endpoint, params = {}) {
  const url = new URL(endpoint, base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set('selectmethod', METHOD_ID);
  return url;
}

async function writeResponse(response, outputPath, label, onProgress) {
  if (!response.ok || !response.body) return errorResponse(response, label);
  const type = response.headers.get('content-type') || '';

  if (type.includes('application/json')) {
    const data = await response.json();
    const downloadUrl = data.url || data.download_url || data.output_url;
    if (!downloadUrl) {
      throw new Error(`${label} returned JSON without a download URL: ${JSON.stringify(data).slice(0, 900)}`);
    }
    const download = await request(downloadUrl);
    return writeResponse(download, outputPath, 'TikQuick Alfa result download', onProgress);
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new Error(`TikQuick Alfa output exceeds ${Math.round(MAX_BYTES / 1048576)} MB.`);
  }

  let received = 0;
  const limiter = new (require('node:stream').Transform)({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_BYTES) callback(new Error(`TikQuick Alfa output exceeds ${Math.round(MAX_BYTES / 1048576)} MB.`));
      else {
        if (declared) onProgress?.('Downloading result', Math.round(received / declared * 100));
        callback(null, chunk);
      }
    }
  });

  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(outputPath));
  if (!received) throw new Error('TikQuick Alfa returned an empty video.');
}

async function processSmall(inputPath, outputPath, base, auth, onProgress) {
  const buffer = await fs.promises.readFile(inputPath);
  const form = new FormData();
  form.append('video', new Blob([buffer], { type: 'video/mp4' }), path.basename(inputPath));

  const url = makeUrl(base, '/api/process', {
    auth_userid: auth.userId,
    auth_token: auth.token
  });
  onProgress?.('Sending video to TikQuick Alfa', 0);
  const response = await request(url, { method: 'POST', body: form });
  await writeResponse(response, outputPath, 'TikQuick Alfa processing', onProgress);
}

async function processChunked(inputPath, outputPath, base, auth, onProgress) {
  const size = fs.statSync(inputPath).size;
  const total = Math.ceil(size / CHUNK_SIZE);
  const initUrl = makeUrl(base, '/api/upload/init', {
    auth_userid: auth.userId,
    auth_token: auth.token
  });

  const init = await jsonRequest(initUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: path.basename(inputPath),
      total_size: size,
      total_chunks: total
    })
  }, 'TikQuick Alfa upload initialization');

  if (!init.job_id || !init.job_otu) {
    throw new Error('TikQuick Alfa upload initialization did not return job_id and job_otu.');
  }

  const fd = await fs.promises.open(inputPath, 'r');
  try {
    for (let index = 0; index < total; index++) {
      const length = Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await fd.read(chunk, 0, length, index * CHUNK_SIZE);
      if (bytesRead !== length) throw new Error('Could not read the complete source video.');

      const chunkUrl = new URL('/api/upload/chunk', base);
      chunkUrl.searchParams.set('job_id', String(init.job_id));
      chunkUrl.searchParams.set('job_otu', String(init.job_otu));
      chunkUrl.searchParams.set('chunk_index', String(index));

      const response = await request(chunkUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: chunk
      });
      if (!response.ok) return errorResponse(response, `TikQuick Alfa chunk ${index + 1}/${total}`);
      await response.arrayBuffer();
      onProgress?.(`Uploading chunk ${index + 1}/${total}`, Math.round((index + 1) / total * 100));
    }
  } finally {
    await fd.close();
  }

  const completeUrl = new URL('/api/upload/complete', base);
  completeUrl.searchParams.set('job_id', String(init.job_id));
  completeUrl.searchParams.set('job_otu', String(init.job_otu));
  completeUrl.searchParams.set('selectmethod', METHOD_ID);

  onProgress?.('TikQuick Alfa is processing', null);
  const complete = await request(completeUrl, { method: 'POST' });
  await writeResponse(complete, outputPath, 'TikQuick Alfa processing', onProgress);
}

async function processAlfa(inputPath, outputPath, onProgress = () => {}) {
  const size = fs.statSync(inputPath).size;
  if (!size) throw new Error('Input video is empty.');
  if (size > MAX_BYTES) throw new Error(`Video exceeds ${Math.round(MAX_BYTES / 1048576)} MB.`);

  const auth = await mintOtu();
  const bases = [...new Set([PRIMARY_PS, FALLBACK_PS])];
  let lastError;

  for (const base of bases) {
    try {
      if (size > CHUNK_THRESHOLD) {
        await processChunked(inputPath, outputPath, base, auth, onProgress);
      } else {
        await processSmall(inputPath, outputPath, base, auth, onProgress);
      }
      if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).size) {
        throw new Error('TikQuick Alfa did not produce a valid output file.');
      }
      return { size: fs.statSync(outputPath).size, method: METHOD_ID };
    } catch (error) {
      lastError = error;
      await fs.promises.unlink(outputPath).catch(() => {});
    }
  }
  throw new Error(`TikQuick Alfa failed: ${lastError?.message || 'Unknown error'}`);
}

module.exports = { process: processAlfa, METHOD_ID };
