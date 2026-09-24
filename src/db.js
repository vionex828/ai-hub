const { Pool, types } = require('pg');
const { config } = require('./config');

// Return BIGINT and NUMERIC columns as JS numbers (token counts fit safely).
types.setTypeParser(20, v => Number(v));
types.setTypeParser(1700, v => Number(v));

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.PGSSL ? { rejectUnauthorized: false } : false,
  max: 10,
});
pool.on('error', err => console.error('[db] idle client error:', err.message));

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  or_id TEXT NOT NULL,
  mult INT NOT NULL DEFAULT 1,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#3F74E0',
  logo_url TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  price INT NOT NULL,
  tokens BIGINT NOT NULL,
  days INT NOT NULL,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,
  plan_id TEXT,
  plan_total BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS otps (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otps_phone_idx ON otps (phone, created_at DESC);
CREATE TABLE IF NOT EXISTS chats (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chats_user_idx ON chats (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS turns (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS turns_chat_idx ON turns (chat_id, id);
CREATE TABLE IF NOT EXISTS answers (
  id BIGSERIAL PRIMARY KEY,
  turn_id BIGINT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'streaming',
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  mult INT NOT NULL DEFAULT 1,
  charged BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS answers_turn_idx ON answers (turn_id);
CREATE INDEX IF NOT EXISTS answers_user_idx ON answers (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  mtid TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  plan_id TEXT,
  amount INT NOT NULL,
  tokens BIGINT NOT NULL,
  days INT,
  status TEXT NOT NULL DEFAULT 'pending',
  eps_txn TEXT,
  method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status, created_at);
CREATE TABLE IF NOT EXISTS ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta BIGINT NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  balance_after BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger (user_id, created_at DESC);
`;

// First-run defaults. Change them later from the admin panel.
const DEFAULT_SETTINGS = {
  usd_rate: 122,
  or_fee_pct: 5.5,
  max_output_tokens: 2000,
  history_turns: 8,
  topup: { price: 100, tokens: 500000, days: 30 },
  signup_bonus: { tokens: 0, days: 7 },
  system_prompt: 'You are a helpful assistant. Reply in the same language the user writes in (Bangla or English). Use clear formatting.',
};

const DEFAULT_MODELS = [
  ['gpt-mini', 'GPT mini', 'OpenAI', 'openai/gpt-5-mini', 1, 0.8, 'Fast answers for everyday questions', '#1E8577', 10],
  ['deepseek', 'DeepSeek', 'DeepSeek', 'deepseek/deepseek-chat', 1, 0.5, 'Math, logic and code at low cost', '#5B59D6', 20],
  ['gemini-flash', 'Gemini Flash', 'Google', 'google/gemini-2.5-flash', 1, 0.9, 'Quick summaries and translation', '#3C6FD8', 30],
  ['gpt', 'GPT-5', 'OpenAI', 'openai/gpt-5', 6, 4.5, 'Strong all-rounder', '#1E8577', 40],
  ['claude', 'Claude Sonnet', 'Anthropic', 'anthropic/claude-sonnet-4.5', 6, 6, 'Great for writing and coding', '#C26A43', 50],
  ['gemini-pro', 'Gemini Pro', 'Google', 'google/gemini-2.5-pro', 6, 4.5, 'Long PDFs and documents', '#3C6FD8', 60],
  ['grok', 'Grok', 'xAI', 'x-ai/grok-4', 6, 6, 'Creative, trend-aware writing', '#444A52', 70],
];

const DEFAULT_PLANS = [
  ['mini', 'Mini', 'For trying things out', 200, 1000000, 30, false, 10],
  ['plus', 'Plus', 'For everyday use', 500, 3000000, 30, true, 20],
  ['pro', 'Pro', 'For heavy users', 1000, 6000000, 30, false, 30],
];

async function init() {
  await q(SCHEMA);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
  }
  const m = await q('SELECT COUNT(*)::int AS n FROM models');
  if (m.rows[0].n === 0) {
    for (const r of DEFAULT_MODELS) {
      await q('INSERT INTO models (id, name, provider, or_id, mult, cost_usd, note, color, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', r);
    }
  }
  const p = await q('SELECT COUNT(*)::int AS n FROM plans');
  if (p.rows[0].n === 0) {
    for (const r of DEFAULT_PLANS) {
      await q('INSERT INTO plans (id, name, tagline, price, tokens, days, featured, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', r);
    }
  }
}

async function getSettings() {
  const r = await q('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

async function setSetting(key, value) {
  await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
}

// Tokens are valid until expires_at. Once it passes, the remaining balance is cleared.
async function applyExpiry(user) {
  if (!user || !user.expires_at || user.balance <= 0) return user;
  if (new Date(user.expires_at) > new Date()) return user;
  const r = await q(
    `UPDATE users u SET balance = 0 FROM (SELECT id, balance AS old FROM users WHERE id = $1 FOR UPDATE) o
     WHERE u.id = o.id AND u.expires_at <= now() AND u.balance > 0 RETURNING o.old`,
    [user.id]
  );
  if (r.rowCount) {
    await q('INSERT INTO ledger (user_id, delta, reason, balance_after) VALUES ($1, $2, $3, 0)', [user.id, -Number(r.rows[0].old), 'expired']);
  }
  user.balance = 0;
  return user;
}

module.exports = { pool, q, tx, init, getSettings, setSetting, applyExpiry, DEFAULT_SETTINGS };
