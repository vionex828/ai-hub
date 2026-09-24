const { config } = require('./config');

// Optional owner alerts. Does nothing unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
async function notify(text) {
  if (!config.TELEGRAM.token || !config.TELEGRAM.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.TELEGRAM.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.TELEGRAM.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error('[telegram]', e.message);
  }
}

module.exports = { notify };
