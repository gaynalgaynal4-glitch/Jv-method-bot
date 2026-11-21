// Node.js adapter for the video patcher supplied in the WTM browser extension.
// Exports the common bot method interface: process(inputPath, outputPath).

const fs = require('fs').promises;

require('./mp4-patcher.js');
const patcher = globalThis.WtmMp4Patcher;

if (!patcher || typeof patcher.patch !== 'function') {
  throw new Error('Video patcher failed to initialize: WtmMp4Patcher.patch is unavailable.');
}

async function process(inputPath, outputPath) {
  const input = await fs.readFile(inputPath);
  const result = patcher.patch(input);
  if (!result || !(result.output instanceof Uint8Array)) {
    throw new Error('Video patcher did not return a valid output buffer.');
  }
  await fs.writeFile(outputPath, result.output);
  return result.info || null;
}

module.exports = { process };
