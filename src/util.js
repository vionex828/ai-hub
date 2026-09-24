const crypto = require('crypto');

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(x, y);
}

// Rough token estimate before the real count comes back from OpenRouter.
// Bangla uses about 1 token per 2 characters, English about 1 per 4.
function estTokens(text) {
  const s = String(text || '');
  const bangla = (s.match(/[ঀ-৿]/g) || []).length;
  return Math.max(1, Math.ceil(bangla / 2 + (s.length - bangla) / 4));
}
const estMessages = msgs => msgs.reduce((n, m) => n + estTokens(m.content) + 4, 3);

// Accepts 01712345678, 1712345678, +8801712345678, 8801712345678, and Bangla digits.
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[০-৯]/g, c => '০১২৩৪৫৬৭৮৯'.indexOf(c)).replace(/\D/g, '');
  if (d.startsWith('880')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^1[3-9]\d{8}$/.test(d) ? d : null;
}

// Simple in-memory rate limiter (one Railway instance is enough for this app).
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) if (!arr.length || now - arr[arr.length - 1] > 3600e3 * 2) buckets.delete(k);
}, 600e3).unref();

const clientIp = req => (req.ip || req.socket.remoteAddress || '').replace('::ffff:', '');

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { sha256, randomToken, safeEqual, estTokens, estMessages, normalizePhone, hit, clientIp, asyncH };
