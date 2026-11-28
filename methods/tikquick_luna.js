// TikQuick Luna adapter.
// Implements the documented chunked patch workflow, with optional VAPI/VAPI2
// optimization before the Luna patch. API key remains server-side.
'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API_KEY = process.env.TIKQUICK_API_KEY || '';
const PASSPORT = (process.env.TIKQUICK_PASSPORT_URL || 'https://api.tikqcapi.site').replace(/\/$/, '');
const PS = (process.env.TIKQUICK_PS_URL || 'https://byte.tikqcapi.site').replace(/\/$/, '');
const MAX_BYTES = Number(process.env.TIKQUICK_MAX_BYTES || 1500 * 1024 * 1024);
const PS_CHUNK = 20 * 1024 * 1024;
const ENC_CHUNK = 5 * 1024 * 1024;

function failHttp(label, response, body) {
  const detail = String(body || '').slice(0, 500);
  const error = new Error(`${label}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
  error.status = response.status;
  return error;
}

async function request(url, options = {}, timeout = 120000) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeout)
  });
  return response;
}

async function jsonRequest(url, options, label) {
  const response = await request(url, options);
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { message: raw.slice(0, 500) }; }
  if (!response.ok) throw failHttp(label, response, data.error || data.message || raw);
  return data;
}

async function retryUpload(url, bytes, label, headers = {}) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body: bytes
      }, 180000);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = failHttp(label, response, body);
        if (response.status < 500 && response.status !== 429) throw error;
        last = error;
      } else {
        await response.arrayBuffer(); // consume response before next request
        return;
      }
    } catch (error) {
      last = error;
      if (error.status && error.status < 500 && error.status !== 429) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 700 * (2 ** attempt)));
  }
  throw last || new Error(`${label} failed after retries.`);
}

async function mint(pathname) {
  if (!API_KEY) throw new Error('TikQuick is not configured. Add TIKQUICK_API_KEY to your bot hosting environment.');
  const url = `${PASSPORT}/passport/api/thirdparty/${pathname}?key=${encodeURIComponent(API_KEY)}`;
  const data = await jsonRequest(url, {}, `TikQuick ${pathname} token`);
  if (!data.token) throw new Error(`TikQuick ${pathname} endpoint did not return a token.`);
  return data;
}

async function checkLunaFps(inputPath) {
  // Luna requires a 30 or 60 FPS source according to TikQuick's API documentation.
  const ffprobe = process.env.FFPROBE_PATH || require('ffprobe-static').path || 'ffprobe';
  const { execFile } = require('child_process');
  const stdout = await new Promise((resolve, reject) => {
    execFile(ffprobe, [
      '-v','error','-select_streams','v:0',
      '-show_entries','stream=avg_frame_rate,r_frame_rate',
      '-of','json', inputPath
    ], { maxBuffer: 1024 * 1024 }, (error, out, stderr) => {
      if (error) return reject(new Error(`Could not inspect source FPS: ${(stderr || error.message).slice(-500)}`));
      resolve(out);
    });
  });
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream) throw new Error('No video stream was found.');
  const parse = value => {
    const [a,b='1'] = String(value || '').split('/');
    const n = Number(a), d = Number(b);
    return Number.isFinite(n) && Number.isFinite(d) && d ? n/d : NaN;
  };
  const fps = parse(stream.avg_frame_rate) || parse(stream.r_frame_rate);
  if (Math.abs(fps - 30) > 0.05 && Math.abs(fps - 60) > 0.05) {
    throw new Error(`TikQuick Luna requires a 30 or 60 FPS source. This video is ${Number.isFinite(fps) ? fps.toFixed(3) : 'unknown'} FPS.`);
  }
}

async function encoderLoads() {
  const urls = [
    'https://vapi.tikqcapi.site',
    'https://vapi2.tikqcapi.site'
  ];
  const checks = await Promise.all(urls.map(async (base, index) => {
    try {
      const response = await request(`${base}/loadz`, {}, 3500);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const load = Number(data.load);
      if (!Number.isFinite(load)) throw new Error('Invalid load response');
      return { base, name: index === 0 ? 'vapi' : 'vapi2', load };
    } catch (_) { return null; }
  }));
  const available = checks.filter(Boolean);
  if (!available.length) throw new Error('TikQuick VAPI and VAPI2 encoders are unavailable. Try Optimizer OFF.');
  const preferred = available.filter(x => x.load < 91).sort((a,b) => a.load-b.load);
  return (preferred[0] || available.sort((a,b) => a.load-b.load)[0]);
}

async function readSse(response, onProgress) {
  if (!response.ok || !response.body) throw failHttp('TikQuick encoder progress', response, await response.text().catch(() => ''));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', outputUrl = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let event;
      try { event = JSON.parse(raw); } catch (_) { continue; }
      if (event.event === 'failed') throw new Error(`TikQuick encoder failed: ${event.error || 'Unknown encoder error'}`);
      if (event.event === 'queued') onProgress?.('Encoder queued', null);
      if (['setting_up_env','rendering','processing'].includes(event.event)) {
        onProgress?.(event.message || event.event, Number.isFinite(Number(event.percent)) ? Number(event.percent) : null);
      }
      if (event.event === 'done') {
        if (!event.output_url_base64) throw new Error('TikQuick encoder completed without an output URL.');
        outputUrl = Buffer.from(event.output_url_base64, 'base64').toString('utf8');
      }
    }
    if (done) break;
  }
  if (!outputUrl) throw new Error('TikQuick encoder stream ended before a completed result was returned.');
  let encId = '';
  try {
    const url = new URL(outputUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const candidate = parts[parts.length - 1] || '';
    encId = candidate.replace(/\.[a-z0-9]+$/i, '');
  } catch (_) {}
  if (!encId) throw new Error('Could not extract the encoder file ID from TikQuick output URL.');
  return encId;
}

async function optimize(inputPath, onProgress) {
  const selected = await encoderLoads();
  onProgress?.(`Selected ${selected.name.toUpperCase()} (${selected.load}% load)`, 0);
  const tokenUrl = `${PASSPORT}/passport/api/thirdparty/genenc?key=${encodeURIComponent(API_KEY)}${selected.name === 'vapi2' ? '&encoderserver=vapi2' : ''}`;
  const tokenData = await jsonRequest(tokenUrl, {}, 'TikQuick encoder token');
  const encoder = String(tokenData.encoder_server || selected.base).replace(/\/$/, '');
  const encToken = tokenData.token;
  const created = await jsonRequest(`${encoder}/api/make?token=${encodeURIComponent(encToken)}`, { method: 'POST' }, 'TikQuick encoder job creation');
  if (!created.jobid || !created.jobtoken) throw new Error('TikQuick encoder did not return job credentials.');

  const size = fs.statSync(inputPath).size;
  const fd = await fs.promises.open(inputPath, 'r');
  try {
    const total = Math.ceil(size / ENC_CHUNK);
    for (let index = 1; index <= total; index++) {
      const length = Math.min(ENC_CHUNK, size - (index - 1) * ENC_CHUNK);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await fd.read(buffer, 0, length, (index - 1) * ENC_CHUNK);
      if (bytesRead !== length) throw new Error('Could not read the complete source video for TikQuick encoding.');
      await retryUpload(
        `${encoder}/api/upload/${index}?jobid=${encodeURIComponent(created.jobid)}&jobtoken=${encodeURIComponent(created.jobtoken)}`,
        buffer,
        `TikQuick encoder chunk ${index}`
      );
      onProgress?.(`Uploading to ${selected.name.toUpperCase()}`, Math.round(index / total * 100));
    }
  } finally { await fd.close(); }

  const finished = await jsonRequest(`${encoder}/api/upload/finish?jobid=${encodeURIComponent(created.jobid)}&jobtoken=${encodeURIComponent(created.jobtoken)}`, { method: 'POST' }, 'TikQuick encoder finish');
  if (!finished.sse) throw new Error('TikQuick encoder did not return a progress stream.');
  const progressUrl = new URL(finished.sse, encoder).toString();
  const encId = await readSse(await request(progressUrl, {}, 30 * 60 * 1000), onProgress);
  return { encId, encoderName: selected.name };
}

async function downloadResponse(response, outputPath, onProgress) {
  if (!response.ok || !response.body) throw failHttp('TikQuick patched video download', response, await response.text().catch(() => ''));
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) throw new Error(`TikQuick output exceeds ${Math.round(MAX_BYTES/1048576)} MB.`);
  let received = 0;
  const out = fs.createWriteStream(outputPath);
  for await (const chunk of Readable.fromWeb(response.body)) {
    received += chunk.length;
    if (received > MAX_BYTES) {
      out.destroy();
      throw new Error(`TikQuick output exceeds ${Math.round(MAX_BYTES/1048576)} MB.`);
    }
    if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
    if (declared) onProgress?.('Downloading patched video', Math.round(received / declared * 100));
  }
  await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
  if (!received) throw new Error('TikQuick returned an empty patched video.');
}

async function patchDirect(inputPath, outputPath, onProgress) {
  const size = fs.statSync(inputPath).size;
  const auth = await mint('genotu');
  const total = Math.ceil(size / PS_CHUNK);
  const initUrl = `${PS}/api/upload/init?auth_userid=${encodeURIComponent(auth.user_id)}&auth_token=${encodeURIComponent(auth.token)}&selectmethod=luna`;
  const init = await jsonRequest(initUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: path.basename(inputPath), total_size: size, total_chunks: total })
  }, 'TikQuick Luna upload initialization');
  if (!init.job_id || !init.job_otu) throw new Error('TikQuick patch server did not return upload credentials.');

  const fd = await fs.promises.open(inputPath, 'r');
  try {
    for (let index = 0; index < total; index++) {
      const length = Math.min(PS_CHUNK, size - index * PS_CHUNK);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await fd.read(buffer, 0, length, index * PS_CHUNK);
      if (bytesRead !== length) throw new Error('Could not read the complete source video.');
      await retryUpload(
        `${PS}/api/upload/chunk?job_id=${encodeURIComponent(init.job_id)}&job_otu=${encodeURIComponent(init.job_otu)}&chunk_index=${index}`,
        buffer,
        `TikQuick Luna chunk ${index + 1}`
      );
      onProgress?.('Uploading original video to patch server', Math.round((index + 1) / total * 100));
    }
  } finally { await fd.close(); }

  const complete = await request(`${PS}/api/upload/complete?job_id=${encodeURIComponent(init.job_id)}&job_otu=${encodeURIComponent(init.job_otu)}`, { method: 'POST' }, 15 * 60 * 1000);
  await downloadResponse(complete, outputPath, onProgress);
}

async function patchEncoded(inputPath, outputPath, onProgress) {
  const encoded = await optimize(inputPath, onProgress);
  const auth = await mint('genotu');
  const initUrl = `${PS}/api/upload/init?auth_userid=${encodeURIComponent(auth.user_id)}&auth_token=${encodeURIComponent(auth.token)}&selectmethod=luna`;
  const init = await jsonRequest(initUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: `${encoded.encId}.mp4`, total_size: 1, total_chunks: 1 })
  }, 'TikQuick Luna encoded-patch initialization');
  if (!init.job_id || !init.job_otu) throw new Error('TikQuick patch server did not return encoded-job credentials.');

  const query = `job_id=${encodeURIComponent(init.job_id)}&job_otu=${encodeURIComponent(init.job_otu)}&enc_id=${encodeURIComponent(encoded.encId)}${encoded.encoderName === 'vapi2' ? '&enc_serve=vapi2' : ''}`;
  const response = await request(`${PS}/api/upload/complete?${query}`, { method: 'GET' }, 15 * 60 * 1000);
  await downloadResponse(response, outputPath, onProgress);
}

async function processVideo(inputPath, outputPath, optimizer = false, onProgress) {
  if (!API_KEY) throw new Error('TikQuick API key is missing. Add TIKQUICK_API_KEY to your hosting environment.');
  await checkLunaFps(inputPath);
  const size = fs.statSync(inputPath).size;
  if (!size || size > MAX_BYTES) throw new Error(`Video must be between 1 byte and ${Math.round(MAX_BYTES/1048576)} MB.`);
  if (optimizer) await patchEncoded(inputPath, outputPath, onProgress);
  else await patchDirect(inputPath, outputPath, onProgress);
  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).size) throw new Error('TikQuick did not produce a valid patched video.');
  return { optimizer: Boolean(optimizer), size: fs.statSync(outputPath).size };
}

module.exports = { process: processVideo };
