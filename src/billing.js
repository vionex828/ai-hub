const express = require('express');
const crypto = require('crypto');
const { config } = require('./config');
const db = require('./db');
const eps = require('./eps');
const { requireUser, publicUser } = require('./auth');
const { hit, clientIp, asyncH } = require('./util');
const { notify } = require('./telegram');

const router = express.Router();

router.get('/api/plans', asyncH(async (req, res) => {
  const r = await db.q('SELECT id, name, tagline, price, tokens, days, featured FROM plans WHERE active = TRUE ORDER BY sort, price');
  const s = await db.getSettings();
  res.json({ plans: r.rows, topup: s.topup, paymentsOn: config.epsReady() });
}));

const newMtid = () => String(Date.now()) + String(crypto.randomInt(100, 1000));

router.post('/api/pay/init', requireUser, asyncH(async (req, res) => {
  if (!config.epsReady()) return res.status(503).json({ error: 'payments_off', message: 'Payments are not available right now.' });
  if (!hit('pay:' + req.user.id, 6, 10 * 60e3)) return res.status(429).json({ error: 'too_many', message: 'Too many payment attempts. Wait a few minutes.' });
  const user = await db.applyExpiry(req.user);
  const item = String(req.body?.item || '');
  let row;
  if (item === 'topup') {
    const s = await db.getSettings();
    const active = user.expires_at && new Date(user.expires_at) > new Date();
    if (!active) return res.status(400).json({ error: 'no_plan', message: 'Top-ups need an active plan. Buy a plan first.' });
    row = { kind: 'topup', plan_id: null, amount: Number(s.topup.price), tokens: Number(s.topup.tokens), days: Number(s.topup.days || 30), name: 'Token top-up' };
  } else {
    const p = (await db.q('SELECT * FROM plans WHERE id = $1 AND active = TRUE', [item])).rows[0];
    if (!p) return res.status(400).json({ error: 'bad_plan', message: 'That plan is not available.' });
    row = { kind: 'plan', plan_id: p.id, amount: p.price, tokens: p.tokens, days: p.days, name: `${p.name} plan` };
  }

  const mtid = newMtid();
  const ins = await db.q(
    'INSERT INTO payments (user_id, mtid, kind, plan_id, amount, tokens, days) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [user.id, mtid, row.kind, row.plan_id, row.amount, row.tokens, row.days]
  );
  const back = r => `${config.BASE_URL}/pay/return?r=${r}&mtid=${mtid}`;
  try {
    const url = await eps.initPayment({
      mtid,
      orderId: 'AIH' + ins.rows[0].id,
      amount: row.amount,
      phone: user.phone,
      productName: `${config.BRAND} ${row.name}`,
      successUrl: back('success'),
      failUrl: back('fail'),
      cancelUrl: back('cancel'),
      ip: clientIp(req),
    });
    res.json({ url });
  } catch (e) {
    console.error('[pay] init error:', e.message);
    await db.q("UPDATE payments SET status = 'failed' WHERE mtid = $1", [mtid]);
    res.status(502).json({ error: 'eps_error', message: 'Could not open the payment page. Please try again.' });
  }
}));

// Checks EPS directly and credits tokens once. Safe to call many times for the same payment.
async function verifyAndCredit(mtid, hint) {
  const p = (await db.q('SELECT * FROM payments WHERE mtid = $1', [mtid])).rows[0];
  if (!p) return 'unknown';
  if (p.status === 'paid') return 'paid';

  let st;
  try { st = await eps.checkStatus(mtid); } catch (e) { console.error('[pay] verify error:', e.message); return p.status; }
  const status = String(st.Status || st.status || '').toLowerCase();
  const paidAmount = Number(st.TotalAmount || st.totalAmount || 0);

  if (status === 'success' && paidAmount + 0.01 >= p.amount) {
    const credited = await db.tx(async c => {
      const up = await c.query(
        "UPDATE payments SET status = 'paid', paid_at = now(), eps_txn = $2, method = $3 WHERE id = $1 AND status <> 'paid' RETURNING *",
        [p.id, String(st.EPSTransactionId || ''), String(st.FinancialEntity || '')]
      );
      if (!up.rowCount) return null;
      let u;
      if (p.kind === 'plan') {
        u = await c.query(
          `UPDATE users SET
             balance = (CASE WHEN expires_at > now() THEN balance ELSE 0 END) + $2,
             plan_total = (CASE WHEN expires_at > now() THEN balance ELSE 0 END) + $2,
             plan_id = $3,
             expires_at = now() + ($4 || ' days')::interval
           WHERE id = $1 RETURNING *`,
          [p.user_id, p.tokens, p.plan_id, String(p.days)]
        );
      } else {
        u = await c.query(
          `UPDATE users SET
             balance = balance + $2,
             plan_total = plan_total + $2,
             expires_at = CASE WHEN expires_at > now() THEN expires_at ELSE now() + ($3 || ' days')::interval END
           WHERE id = $1 RETURNING *`,
          [p.user_id, p.tokens, String(p.days || 30)]
        );
      }
      await c.query('INSERT INTO ledger (user_id, delta, reason, ref, balance_after) VALUES ($1,$2,$3,$4,$5)', [p.user_id, p.tokens, p.kind === 'plan' ? 'plan' : 'topup', mtid, u.rows[0].balance]);
      return u.rows[0];
    });
    if (credited) notify(`💰 Paid ৳${p.amount} · ${p.kind === 'plan' ? p.plan_id + ' plan' : 'top-up'} · +${Number(p.tokens).toLocaleString()} tokens · 0${credited.phone} · ${st.FinancialEntity || 'EPS'}`);
    return 'paid';
  }
  if (status === 'success') {
    // Paid, but less than the price. Leave it for a manual check.
    notify(`⚠️ EPS amount mismatch for ${mtid}: paid ${paidAmount}, expected ${p.amount}. Check it in the admin panel.`);
    return 'pending';
  }
  const failed = ['failed', 'fail', 'cancel', 'cancelled', 'canceled', 'declined', 'expired'].includes(status);
  if (failed || hint === 'fail' || hint === 'cancel') {
    const next = hint === 'cancel' || status.startsWith('cancel') ? 'cancelled' : 'failed';
    await db.q("UPDATE payments SET status = $2 WHERE id = $1 AND status = 'pending'", [p.id, next]);
    return 'failed';
  }
  return 'pending';
}

// Customer comes back here from the EPS page.
router.get('/pay/return', asyncH(async (req, res) => {
  const mtid = String(req.query.mtid || '').replace(/[^0-9A-Za-z_-]/g, '');
  const hint = String(req.query.r || '');
  let result = 'pending';
  if (mtid) result = await verifyAndCredit(mtid, hint === 'success' ? null : hint);
  res.redirect(`/?pay=${result === 'paid' ? 'success' : result === 'failed' ? 'failed' : 'pending'}#plans`);
}));

// EPS server notification. We never trust its contents: it only triggers a fresh check with EPS.
router.post('/api/eps/ipn', express.text({ type: '*/*', limit: '64kb' }), asyncH(async (req, res) => {
  let mtid = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    mtid = body?.MerchantTransactionId || body?.merchantTransactionId || null;
  } catch { /* encrypted or not JSON */ }
  res.json({ ok: true });
  if (mtid) verifyAndCredit(String(mtid)).catch(() => {});
  else checkPending().catch(() => {});
}));

router.get('/api/usage', requireUser, asyncH(async (req, res) => {
  const user = await db.applyExpiry(req.user);
  const a = await db.q(
    `SELECT a.created_at, a.model_id, m.name AS model_name, m.color, m.provider, m.logo_url, a.prompt_tokens + a.completion_tokens AS tokens, a.mult, a.charged, a.status
     FROM answers a LEFT JOIN models m ON m.id = a.model_id
     WHERE a.user_id = $1 AND a.status <> 'streaming' ORDER BY a.id DESC LIMIT 50`,
    [user.id]
  );
  const p = await db.q(
    `SELECT created_at, paid_at, kind, plan_id, amount, tokens, status, mtid, eps_txn, method
     FROM payments WHERE user_id = $1 AND (status <> 'pending' OR created_at > now() - interval '30 minutes')
     ORDER BY id DESC LIMIT 30`,
    [user.id]
  );
  res.json({ user: publicUser(user), usage: a.rows, payments: p.rows });
}));

// Safety net: re-check recent pending payments (customer may close the tab before returning).
async function checkPending() {
  if (!config.epsReady()) return;
  const r = await db.q("SELECT mtid FROM payments WHERE status = 'pending' AND created_at < now() - interval '1 minute' AND created_at > now() - interval '3 hours' ORDER BY id LIMIT 30");
  for (const row of r.rows) await verifyAndCredit(row.mtid);
  await db.q("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND created_at <= now() - interval '3 hours'");
}
function startPaymentPoller() {
  setInterval(() => checkPending().catch(e => console.error('[pay] poller:', e.message)), 120e3).unref();
}

module.exports = { router, verifyAndCredit, startPaymentPoller };
