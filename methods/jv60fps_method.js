// JV-60fps method — example implementation.
//
// Every method file must export:
//   async function process(inputPath, outputPath)
//
// - inputPath  : the video the user sent (already downloaded)
// - outputPath : where you must write the finished video
//
// The bot calls this and uploads whatever file ends up at outputPath.
// Throw an Error on failure — the bot catches it and shows the message
// to the user.

const { execFile } = require('child_process');

function process(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Example: re-encode to 60fps using ffmpeg.
    // Replace this with your actual JV-60fps logic.
    const args = [
      '-y',
      '-i', inputPath,
      '-filter:v', 'fps=60',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-c:a', 'copy',
      outputPath,
    ];

    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed:\n${(stderr || '').slice(-1500)}`));
        return;
      }
      resolve();
    });
  });
}

module.exports = { process };
