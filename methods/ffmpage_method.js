// ffm-page method — example implementation.
// Replace the body of process() with your real "ffm-page" logic.

const fs = require('fs');

async function process(inputPath, outputPath) {
  // Placeholder: just copies the file unchanged.
  await fs.promises.copyFile(inputPath, outputPath);
}

module.exports = { process };
