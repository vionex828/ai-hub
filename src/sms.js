const { config } = require('./config');

// BulkSMSBD. Success is response_code 202.
async function sendSms(phone10, message) {
  const body = new URLSearchParams({
    api_key: config.SMS.apiKey,
    type: 'text',
    number: '880' + phone10,
    senderid: config.SMS.senderId,
    message,
  });
  const res = await fetch(config.SMS.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!data || Number(data.response_code) !== 202) {
    throw new Error('SMS failed: ' + text.slice(0, 200));
  }
  return data;
}

module.exports = { sendSms };
