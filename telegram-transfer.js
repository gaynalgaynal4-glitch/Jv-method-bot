const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

let client;
let connecting;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

async function startTelegramTransfer() {
  if (client && client.connected) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const apiId = Number(required('API_ID'));
    const apiHash = required('API_HASH');
    const botToken = required('BOT_TOKEN');
    if (!Number.isInteger(apiId) || apiId <= 0) throw new Error('API_ID must be a valid numeric Telegram API ID.');
    client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
      requestRetries: 5,
      autoReconnect: true,
    });
    await client.start({ botAuthToken: botToken });
    console.log('[mtproto] Telegram media transfer connected.');
    return client;
  })();
  try { return await connecting; }
  finally { connecting = null; }
}

async function downloadTelegramMessage(chatId, messageId, destination) {
  const tg = await startTelegramTransfer();
  const messages = await tg.getMessages(chatId, { ids: [Number(messageId)] });
  const message = messages && messages[0];
  if (!message || !message.media) throw new Error('Telegram could not find media in the original message.');
  await tg.downloadMedia(message, { outputFile: destination });
  const fs = require('fs');
  const stat = await fs.promises.stat(destination).catch(() => null);
  if (!stat || !stat.size) throw new Error('Telegram media download produced an empty file.');
  return stat.size;
}

async function uploadTelegramVideo(chatId, filePath, caption, replyToMessageId) {
  const tg = await startTelegramTransfer();
  const params = {
    file: filePath,
    caption: String(caption || '').slice(0, 900),
    forceDocument: false,
    workers: 1,
  };
  if (replyToMessageId) params.replyTo = Number(replyToMessageId);
  return tg.sendFile(chatId, params);
}

async function stopTelegramTransfer() {
  if (client) {
    try { await client.disconnect(); } catch (_) {}
    client = null;
  }
}

module.exports = { startTelegramTransfer, downloadTelegramMessage, uploadTelegramVideo, stopTelegramTransfer };
