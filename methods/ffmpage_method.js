// ffm-page method: timestamp-scale an input without re-encoding.
// The scale factor is source FPS / requested target FPS. For example,
// 120 -> 60 uses 2.0, so timestamps are doubled and playback duration doubles.
// All input streams are timestamp-scaled together to preserve A/V alignment.

const { execFile } = require('child_process');
const ffmpegStatic = process.env.FFMPEG_PATH ? null : require('ffmpeg-static');
const ffprobeStatic = process.env.FFPROBE_PATH ? null : require('ffprobe-static');

const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || (ffprobeStatic && ffprobeStatic.path) || 'ffprobe';

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').trim().slice(-2500);
        reject(new Error(detail || `${command} failed`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseFrameRate(value) {
  if (!value || value === '0/0' || value === 'N/A') return NaN;
  const parts = String(value).split('/');
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return NaN;
  return numerator / denominator;
}

async function getSourceFps(inputPath) {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=avg_frame_rate,r_frame_rate',
    '-of', 'json',
    inputPath,
  ]);

  let data;
  try { data = JSON.parse(stdout); }
  catch (_) { throw new Error('Could not read video frame-rate information.'); }

  const stream = data.streams && data.streams[0];
  if (!stream) throw new Error('No video stream was found in this file.');

  // avg_frame_rate is generally the best estimate of the actual displayed rate.
  const fps = parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('Could not detect a valid source FPS for this video.');
  }
  return fps;
}

async function processVideo(inputPath, outputPath, options = {}) {
  const targetFps = Number(options.targetFps);
  if (![30, 60].includes(targetFps)) {
    throw new Error('Target FPS must be either 30 or 60.');
  }

  const sourceFps = await getSourceFps(inputPath);
  const scaleFactor = sourceFps / targetFps;
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error('Could not calculate a valid timestamp scale factor.');
  }

  // -itsscale changes packet timestamps; -c copy prevents video/audio re-encoding.
  // It is intentionally applied to all streams so their timelines stay aligned.
  await execFileAsync(FFMPEG, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-itsscale', scaleFactor.toFixed(10),
    '-i', inputPath,
    '-map', '0',
    '-c', 'copy',
    '-max_interleave_delta', '0',
    outputPath,
  ]);

  return {
    sourceFps,
    targetFps,
    scaleFactor,
    durationMultiplier: scaleFactor,
  };
}

module.exports = { process: processVideo, getSourceFps };
