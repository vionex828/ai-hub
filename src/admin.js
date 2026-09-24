const express = require('express');
const { config } = require('./config');
const db = require('./db');
const { requireAdmin } = require('./auth');
const { listModels, credits } = require('./openrouter');
const { verifyAndCredit } = require('./billing');
const { normalizePhone, asyncH } = require('./util');
const { notify } = require('./telegram');

const router = express.Router();
router.use('/api/admin', (req, res, next) => (req.path === '/login' || req.path === '/logout' ? next() : requireAdmin(req, res, next)));

const DAY_START = "date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka'";

router.get('/api/admin/overview', asyncH(async (req, res) => {
  const s = await db.getSettings();
  const [sales, cost, active, fresh, month] = await Promise.all([
    db.q(`SELECT COALESCE(SUM(amount),0)::int AS amount, COUNT(*)::int AS n FROM payments WHERE status = 'paid' AND paid_at >= ${DAY_START}`),
    db.q(`SELECT COALESCE(SUM(cost_usd),0) AS usd, COUNT(*)::int AS n FROM answers WHERE created_at >= ${DAY_START}`),
    db.q("SELECT COUNT(DISTINCT user_id)::int AS n FROM answers WHERE created_at > now() - interval '30 days'"),
    db.q(`SELECT COUNT(*)::int AS n FROM users WHERE created_at >= ${DAY_START}`),
    db.q(`SELECT COALESCE(SUM(amount),0)::int AS amount FROM payments WHERE status = 'paid' AND paid_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka'`),
  ]);
  const monthCost = await db.q(`SELECT COALESCE(SUM(cost_usd),0) AS usd FROM answers WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka'`);
  let orCredits = null;
  try { orCredits = await credits(); } catch (e) { orCredits = { error: e.message }; }
  res.json({
    brand: config.BRAND,
    today: { sales: sales.rows[0].amount, payments: sales.rows[0].n, costUsd: cost.rows[0].usd, messages: cost.rows[0].n, newUsers: fresh.rows[0].n },
    month: { sales: month.rows[0].amount, costUsd: monthCost.rows[0].usd },
    activeUsers30d: active.rows[0].n,
    openrouter: orCredits,
    lowCreditUsd: config.LOW_CREDIT_USD,
    settings: s,
    status: { payments: config.epsReady(), sms: config.smsReady(), otpDebug: config.OTP_DEBUG },
  });
}));

// ----- settings -----
router.put('/api/admin/settings', asyncH(async (req, res) => {
  const b = req.body || {};
  const num = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error('bad'), { status: 400 }); return n; };
  try {
    if (b.usd_rate !== undefined) await db.setSetting('usd_rate', num(b.usd_rate, 1, 1000));
    if (b.or_fee_pct !== undefined) await db.setSetting('or_fee_pct', num(b.or_fee_pct, 0, 50));
    if (b.max_output_tokens !== undefined) await db.setSetting('max_output_tokens', Math.round(num(b.max_output_tokens, 200, 32000)));
    if (b.history_turns !== undefined) await db.setSetting('history_turns', Math.round(num(b.history_turns, 0, 30)));
    if (b.topup) await db.setSetting('topup', { price: Math.round(num(b.topup.price, 10, 100000)), tokens: Math.round(num(b.topup.tokens, 1000, 1e9)), days: Math.round(num(b.topup.days ?? 30, 1, 365)) });
    if (b.signup_bonus) await db.setSetting('signup_bonus', { tokens: Math.round(num(b.signup_bonus.tokens, 0, 1e8)), days: Math.round(num(b.signup_bonus.days ?? 7, 1, 365)) });
    if (b.system_prompt !== undefined) await db.setSetting('system_prompt', String(b.system_prompt).slice(0, 4000));
  } catch (e) {
    return res.status(400).json({ error: 'bad_value', message: 'One of the values is out of range.' });
  }
  res.json({ ok: true, settings: await db.getSettings() });
}));

// ----- models -----
router.get('/api/admin/models', asyncH(async (req, res) => {
  res.json({ models: (await db.q('SELECT * FROM models ORDER BY sort, name')).rows });
}));

const MODEL_FIELDS = { name: 'text', provider: 'text', or_id: 'text', mult: 'int', cost_usd: 'num', note: 'text', color: 'color', logo_url: 'text', enabled: 'bool', sort: 'int' };
function cleanModel(b, partial) {
  const out = {};
  for (const [k, t] of Object.entries(MODEL_FIELDS)) {
    if (b[k] === undefined) { if (!partial && ['name', 'provider', 'or_id'].includes(k)) throw new Error(`${k} is required`); continue; }
    let v = b[k];
    if (t === 'text') v = String(v).trim().slice(0, 300);
    if (t === 'int') { v = Math.round(Number(v)); if (!Number.isFinite(v)) throw new Error(`${k} must be a number`); }
    if (t === 'num') { v = Number(v); if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a number`); }
    if (t === 'bool') v = Boolean(v);
    if (t === 'color' && !/^#[0-9a-fA-F]{6}$/.test(String(v))) throw new Error('color must look like #1E8577');
    if (k === 'mult' && v < 1) throw new Error('rate must be 1 or more');
    out[k] = v;
  }
  return out;
}

router.post('/api/admin/models', asyncH(async (req, res) => {
  let m;
  try { m = cleanModel(req.body || {}, false); } catch (e) { return res.status(400).json({ error: 'bad_model', message: e.message }); }
  const id = String(req.body.id || m.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!id) return res.status(400).json({ error: 'bad_model', message: 'Give the model a name.' });
  const cols = ['id', ...Object.keys(m)];
  const vals = [id, ...Object.values(m)];
  await db.q(`INSERT INTO models (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals).catch(e => {
    throw Object.assign(new Error(e.code === '23505' ? 'A model with this id already exists.' : e.message), { status: 400 });
  });
  res.json({ ok: true });
}));

router.put('/api/admin/models/:id', asyncH(async (req, res) => {
  let m;
  try { m = cleanModel(req.body || {}, true); } catch (e) { return res.status(400).json({ error: 'bad_model', message: e.message }); }
  const keys = Object.keys(m);
  if (!keys.length) return res.json({ ok: true });
  await db.q(`UPDATE models SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [req.params.id, ...Object.values(m)]);
  res.json({ ok: true });
}));

router.delete('/api/admin/models/:id', asyncH(async (req, res) => {
  await db.q('DELETE FROM models WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Live list from OpenRouter to check IDs and prices (USD per 1M tokens).
router.get('/api/admin/openrouter-models', asyncH(async (req, res) => {
  const list = await listModels();
  res.json({
    models: list.map(m => ({
      id: m.id,
      name: m.name,
      input: Number(m.pricing?.prompt || 0) * 1e6,
      output: Number(m.pricing?.completion || 0) * 1e6,
      context: m.context_length,
    })),
  });
}));

// ----- plans -----
router.get('/api/admin/plans', asyncH(async (req, res) => {
  res.json({ plans: (await db.q('SELECT * FROM plans ORDER BY sort, price')).rows });
}));

router.put('/api/admin/plans/:id', asyncH(async (req, res) => {
  const b = req.body || {};
  const sets = []; const vals = [req.params.id];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const n = (v, min) => { const x = Math.round(Number(v)); if (!Number.isFinite(x) || x < min) throw new Error('bad'); return x; };
  try {
    if (b.name !== undefined) add('name', String(b.name).slice(0, 40));
    if (b.tagline !== undefined) add('tagline', String(b.tagline).slice(0, 80));
    if (b.price !== undefined) add('price', n(b.price, 1));
    if (b.tokens !== undefined) add('tokens', n(b.tokens, 1000));
    if (b.days !== undefined) add('days', n(b.days, 1));
    if (b.featured !== undefined) add('featured', Boolean(b.featured));
    if (b.active !== undefined) add('active', Boolean(b.active));
  } catch { return res.status(400).json({ error: 'bad_value', message: 'Check the numbers and try again.' }); }
  if (sets.length) await db.q(`UPDATE plans SET ${sets.join(', ')} WHERE id = $1`, vals);
  res.json({ ok: true });
}));

// ----- customers -----
router.get('/api/admin/users', asyncH(async (req, res) => {
  const raw = String(req.query.q || '').trim();
  const phone = normalizePhone(raw);
  const r = raw
    ? await db.q('SELECT * FROM users WHERE phone LIKE $1 ORDER BY last_seen DESC NULLS LAST LIMIT 50', ['%' + (phone || raw.replace(/\D/g, '').replace(/^0|^880/, '')) + '%'])
    : await db.q('SELECT * FROM users ORDER BY last_seen DESC NULLS LAST LIMIT 50');
  res.json({ users: r.rows });
}));

router.post('/api/admin/users/:id/adjust', asyncH(async (req, res) => {
  const delta = Math.round(Number(req.body?.delta));
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'bad_value', message: 'Enter a number like 50000 or -50000.' });
  const days = Math.round(Number(req.body?.days || 0));
  const r = await db.q(
    `UPDATE users SET balance = GREATEST(balance + $2, 0),
       plan_total = GREATEST(plan_total, balance + $2),
       expires_at = CASE WHEN $3::int > 0 THEN GREATEST(COALESCE(expires_at, now()), now()) + make_interval(days => $3::int) ELSE expires_at END
     WHERE id = $1 RETURNING *`,
    [req.params.id, delta, days]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  await db.q('INSERT INTO ledger (user_id, delta, reason, ref, balance_after) VALUES ($1,$2,$3,$4,$5)', [r.rows[0].id, delta, 'admin', String(req.body?.note || '').slice(0, 200), r.rows[0].balance]);
  res.json({ ok: true, user: r.rows[0] });
}));

router.post('/api/admin/users/:id/block', asyncH(async (req, res) => {
  const blocked = Boolean(req.body?.blocked);
  await db.q('UPDATE users SET blocked = $2 WHERE id = $1', [req.params.id, blocked]);
  if (blocked) await db.q('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ----- payments -----
router.get('/api/admin/payments', asyncH(async (req, res) => {
  const status = String(req.query.status || '');
  const r = await db.q(
    `SELECT p.*, u.phone FROM payments p JOIN users u ON u.id = p.user_id
     ${status ? 'WHERE p.status = $1' : ''} ORDER BY p.id DESC LIMIT 100`,
    status ? [status] : []
  );
  res.json({ payments: r.rows });
}));

router.post('/api/admin/payments/:mtid/verify', asyncH(async (req, res) => {
  res.json({ result: await verifyAndCredit(String(req.params.mtid)) });
}));

// Hourly check of OpenRouter credit; alerts the owner on Telegram once a day when low.
let lastLowAlert = 0;
function startCreditWatch() {
  setInterval(async () => {
    try {
      const c = await credits();
      if (c.left < config.LOW_CREDIT_USD && Date.now() - lastLowAlert > 20 * 3600e3) {
        lastLowAlert = Date.now();
        notify(`⚠️ OpenRouter credit is low: $${c.left.toFixed(2)} left. Top up so chats keep working.`);
      }
    } catch { /* ignore */ }
  }, 3600e3).unref();
}

module.exports = { router, startCreditWatch };
