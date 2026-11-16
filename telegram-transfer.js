'use strict';

const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

let client;
let startPromise;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function start() {
  if (client && client.connected) return client;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const apiId = Number(requiredEnv('API_ID'));
    const apiHash = requiredEnv('API_HASH');
    const botToken = requiredEnv('BOT_TOKEN');
    if (!Number.isInteger(apiId) || apiId <= 0) throw new Error('API_ID must be a positive integer.');
    // A fresh in-memory StringSession is intentionally used. GramJS authenticates
    // the bot again with BOT_TOKEN after a cold start; no session file is needed.
    client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      requestRetries: 5,
      useWSS: false
    });
    await client.start({ botAuthToken: botToken });
    // Telegraf owns all bot text/command UI; MTProto captions are sent as plain text.
    client.setParseMode(undefined);
    return client;
  })();
  try { return await startPromise; }
  catch (error) { client = undefined; throw error; }
  finally { startPromise = undefined; }
}

async function downloadMessageMedia(chatId, messageId, destination, onProgress) {
  const tg = await start();
  const messages = await tg.getMessages(chatId, { ids: [Number(messageId)] });
  const message = messages && messages[0];
  if (!message || !message.media) throw new Error('Telegram could not find the original video message.');
  await tg.downloadMedia(message, {
    outputFile: destination,
    progressCallback: (received, total) => {
      if (onProgress) onProgress(Number(received) || 0, Number(total) || 0);
    }
  });
  if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
    throw new Error('Telegram returned an empty media file.');
  }
  return destination;
}

async function uploadVideo(chatId, filePath, caption, onProgress, topMsgId) {
  const tg = await start();
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('The output video is empty or missing.');
  return tg.sendFile(chatId, {
    file: path.resolve(filePath),
    caption: String(caption || '').slice(0, 900),
    forceDocument: false,
    supportsStreaming: path.extname(filePath).toLowerCase() === '.mp4',
    workers: 1,
    topMsgId: Number.isInteger(Number(topMsgId)) && Number(topMsgId) > 0 ? Number(topMsgId) : undefined,
    progressCallback: onProgress
      ? (fraction) => onProgress(Math.max(0, Math.min(1, Number(fraction) || 0)), 1)
      : undefined
  });
}

async function shutdown() {
  if (!client) return;
  const current = client;
  client = undefined;
  try { await current.disconnect(); } catch (_) {}
}

module.exports = { start, downloadMessageMedia, uploadVideo, shutdown };
