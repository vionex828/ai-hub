const crypto = require('crypto');
const express = require('express');
const { config } = require('./config');
const db = require('./db');
const { sha256, randomToken, safeEqual, normalizePhone, hit, clientIp, asyncH } = require('./util');
const { sendSms } = require('./sms');

const router = express.Router();
const OTP_TTL_MIN = 5;
const otpHash = (phone, code) => sha256(`${phone}:${code}:${config.ADMIN_PASSWORD}`);

function setCookie(res, name, token, days) {
  res.cookie(name, token, {
    httpOnly: true,
    secure: config.SECURE_COOKIES,
    sameSite: 'lax',
    maxAge: days * 864e5,
    path: '/',
  });
}

async function createSession(res, { userId = null, isAdmin = false, days }) {
  const token = randomToken();
  await db.q('INSERT INTO sessions (token_hash, user_id, is_admin, expires_at) VALUES ($1, $2, $3, now() + ($4 || \' days\')::interval)', [sha256(token), userId, isAdmin, String(days)]);
  setCookie(res, isAdmin ? 'aid' : 'sid', token, days);
}

// Attaches req.user when the customer cookie is valid.
const loadUser = asyncH(async (req, res, next) => {
  const token = req.cookies?.sid;
  if (token) {
    const r = await db.q(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND s.is_admin = FALSE`,
      [sha256(token)]
    );
    if (r.rows[0]) req.user = r.rows[0];
  }
  next();
});

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'login_required', message: 'Please log in again.' });
  if (req.user.blocked) return res.status(403).json({ error: 'blocked', message: 'This account is blocked. Contact support.' });
  next();
}

const requireAdmin = asyncH(async (req, res, next) => {
  const token = req.cookies?.aid;
  if (token) {
    const r = await db.q('SELECT 1 FROM sessions WHERE token_hash = $1 AND expires_at > now() AND is_admin = TRUE', [sha256(token)]);
    if (r.rowCount) return next();
  }
  res.status(401).json({ error: 'admin_login_required' });
});

function publicUser(u) {
  const active = u.expires_at && new Date(u.expires_at) > new Date();
  return {
    phone: u.phone,
    balance: Number(u.balance),
    planId: u.plan_id,
    planTotal: Number(u.plan_total),
    expiresAt: u.expires_at,
    active: Boolean(active),
  };
}

router.post('/api/auth/send-otp', asyncH(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'bad_phone', message: 'Enter a valid Bangladeshi mobile number.' });
  const ip = clientIp(req);
  if (!hit('otp-phone-min:' + phone, 1, 60e3)) return res.status(429).json({ error: 'wait', message: 'Please wait a minute before asking for a new code.' });
  if (!hit('otp-phone-hr:' + phone, 5, 3600e3)) return res.status(429).json({ error: 'too_many', message: 'Too many codes requested. Try again in an hour.' });
  if (!hit('otp-ip-hr:' + ip, 15, 3600e3)) return res.status(429).json({ error: 'too_many', message: 'Too many requests from this network. Try again later.' });

  const code = String(crypto.randomInt(100000, 1000000));
  await db.q(`INSERT INTO otps (phone, code_hash, expires_at, ip) VALUES ($1, $2, now() + interval '${OTP_TTL_MIN} minutes', $3)`, [phone, otpHash(phone, code), ip]);

  if (config.smsReady()) {
    try {
      await sendSms(phone, `${code} is your ${config.BRAND} login code. It expires in ${OTP_TTL_MIN} minutes. Do not share it with anyone.`);
    } catch (e) {
      console.error('[otp] sms error:', e.message);
      if (!config.OTP_DEBUG) return res.status(502).json({ error: 'sms_failed', message: 'We could not send the SMS. Please try again.' });
    }
  } else if (!config.OTP_DEBUG) {
    return res.status(503).json({ error: 'sms_off', message: 'Login by SMS is not available right now.' });
  }
  res.json({ ok: true, ...(config.OTP_DEBUG ? { debugCode: code } : {}) });
}));

router.post('/api/auth/verify-otp', asyncH(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (!phone || code.length !== 6) return res.status(400).json({ error: 'bad_input', message: 'Enter the 6-digit code.' });
  if (!hit('verify-ip:' + clientIp(req), 30, 3600e3)) return res.status(429).json({ error: 'too_many', message: 'Too many attempts. Try again later.' });

  const r = await db.q('SELECT * FROM otps WHERE phone = $1 AND used = FALSE AND expires_at > now() ORDER BY id DESC LIMIT 1', [phone]);
  const otp = r.rows[0];
  if (!otp) return res.status(400).json({ error: 'expired', message: 'This code has expired. Ask for a new one.' });
  if (otp.attempts >= 5) return res.status(400).json({ error: 'locked', message: 'Too many wrong tries. Ask for a new code.' });
  if (!safeEqual(otp.code_hash, otpHash(phone, code))) {
    await db.q('UPDATE otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    return res.status(400).json({ error: 'wrong', message: "That code doesn't match. Try again." });
  }
  await db.q('UPDATE otps SET used = TRUE WHERE id = $1', [otp.id]);

  const up = await db.q(
    `INSERT INTO users (phone, last_seen) VALUES ($1, now())
     ON CONFLICT (phone) DO UPDATE SET last_seen = now()
     RETURNING *, (xmax = 0) AS is_new`,
    [phone]
  );
  let user = up.rows[0];
  if (user.blocked) return res.status(403).json({ error: 'blocked', message: 'This account is blocked. Contact support.' });

  if (user.is_new) {
    const s = await db.getSettings();
    const bonus = Number(s.signup_bonus?.tokens || 0);
    if (bonus > 0) {
      const b = await db.q(
        `UPDATE users SET balance = balance + $1, plan_total = plan_total + $1, expires_at = now() + ($2 || ' days')::interval WHERE id = $3 RETURNING *`,
        [bonus, String(s.signup_bonus.days || 7), user.id]
      );
      user = b.rows[0];
      await db.q('INSERT INTO ledger (user_id, delta, reason, balance_after) VALUES ($1, $2, $3, $4)', [user.id, bonus, 'signup_bonus', user.balance]);
    }
  }
  await createSession(res, { userId: user.id, days: config.SESSION_DAYS });
  res.json({ ok: true, user: publicUser(user) });
}));

router.post('/api/auth/logout', asyncH(async (req, res) => {
  if (req.cookies?.sid) await db.q('DELETE FROM sessions WHERE token_hash = $1', [sha256(req.cookies.sid)]);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));

router.get('/api/me', requireUser, asyncH(async (req, res) => {
  const u = await db.applyExpiry(req.user);
  db.q('UPDATE users SET last_seen = now() WHERE id = $1', [u.id]).catch(() => {});
  res.json({ user: publicUser(u), brand: config.BRAND });
}));

// Admin login uses ADMIN_PASSWORD from Railway variables.
router.post('/api/admin/login', asyncH(async (req, res) => {
  const ip = clientIp(req);
  if (!hit('admin-login:' + ip, 5, 15 * 60e3)) return res.status(429).json({ error: 'too_many', message: 'Too many tries. Wait 15 minutes.' });
  const pw = String(req.body?.password || '');
  if (!config.ADMIN_PASSWORD || !safeEqual(pw, config.ADMIN_PASSWORD)) return res.status(401).json({ error: 'wrong', message: 'Wrong password.' });
  await createSession(res, { isAdmin: true, days: 7 });
  res.json({ ok: true });
}));

router.post('/api/admin/logout', asyncH(async (req, res) => {
  if (req.cookies?.aid) await db.q('DELETE FROM sessions WHERE token_hash = $1', [sha256(req.cookies.aid)]);
  res.clearCookie('aid', { path: '/' });
  res.json({ ok: true });
}));

module.exports = { router, loadUser, requireUser, requireAdmin, publicUser };
