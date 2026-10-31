// Node.js adapter for the MP4 patcher.
// The bot requires every method to export async process(inputPath, outputPath).

const fs = require('fs').promises;

// mp4-patcher.js is the browser-port file supplied with this bot.
// Requiring it registers globalThis.WtmMp4Patcher.
require('./mp4-patcher.js');

const patcher = globalThis.WtmMp4Patcher;

if (!patcher || typeof patcher.patch !== 'function') {
  throw new Error('MP4 patcher failed to initialize: WtmMp4Patcher.patch is unavailable.');
}

async function process(inputPath, outputPath) {
  const input = await fs.readFile(inputPath);
  const result = patcher.patch(input);

  if (!result || !(result.output instanceof Uint8Array)) {
    throw new Error('MP4 patcher did not return a valid output buffer.');
  }

  await fs.writeFile(outputPath, result.output);
}

module.exports = { process };
