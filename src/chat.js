const express = require('express');
const db = require('./db');
const { requireUser } = require('./auth');
const { streamChat } = require('./openrouter');
const { estTokens, estMessages, hit, asyncH } = require('./util');

const router = express.Router();
const MAX_MESSAGE_CHARS = 20000;
const MAX_HISTORY_CHARS = 40000;
const MIN_OUTPUT_TOKENS = 150;

const publicModel = m => ({ id: m.id, name: m.name, provider: m.provider, mult: m.mult, note: m.note, color: m.color, logo: m.logo_url });

async function enabledModels() {
  const r = await db.q('SELECT * FROM models WHERE enabled = TRUE ORDER BY sort, name');
  return r.rows;
}

router.get('/api/models', asyncH(async (req, res) => {
  res.json({ models: (await enabledModels()).map(publicModel) });
}));

router.get('/api/chats', requireUser, asyncH(async (req, res) => {
  const r = await db.q('SELECT id, title, updated_at FROM chats WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 60', [req.user.id]);
  res.json({ chats: r.rows });
}));

async function loadChat(chatId, userId) {
  const c = await db.q('SELECT id, title, updated_at FROM chats WHERE id = $1 AND user_id = $2', [chatId, userId]);
  if (!c.rows[0]) return null;
  const t = await db.q('SELECT id, prompt, created_at FROM turns WHERE chat_id = $1 ORDER BY id', [chatId]);
  const a = await db.q(
    `SELECT a.id, a.turn_id, a.model_id, a.content, a.status, a.prompt_tokens, a.completion_tokens, a.mult, a.charged
     FROM answers a JOIN turns t ON t.id = a.turn_id WHERE t.chat_id = $1 ORDER BY a.id`,
    [chatId]
  );
  const byTurn = new Map(t.rows.map(x => [x.id, { ...x, answers: [] }]));
  for (const ans of a.rows) byTurn.get(ans.turn_id)?.answers.push(ans);
  return { ...c.rows[0], turns: [...byTurn.values()] };
}

router.get('/api/chats/:id', requireUser, asyncH(async (req, res) => {
  const chat = await loadChat(Number(req.params.id) || 0, req.user.id);
  if (!chat) return res.status(404).json({ error: 'not_found', message: 'Chat not found.' });
  res.json({ chat });
}));

router.delete('/api/chats/:id', requireUser, asyncH(async (req, res) => {
  await db.q('DELETE FROM chats WHERE id = $1 AND user_id = $2', [Number(req.params.id) || 0, req.user.id]);
  res.json({ ok: true });
}));

// Builds the conversation for one model: earlier turns, preferring that model's own earlier answers.
function historyFor(turns, modelId) {
  const out = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const done = t.answers.filter(a => a.content && a.status !== 'error');
    const ans = done.find(a => a.model_id === modelId) || done[0];
    if (!ans) continue;
    chars += t.prompt.length + ans.content.length;
    if (chars > MAX_HISTORY_CHARS) break;
    out.unshift({ role: 'user', content: t.prompt }, { role: 'assistant', content: ans.content });
  }
  return out;
}

router.post('/api/chat', requireUser, asyncH(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  const ids = [...new Set(Array.isArray(req.body?.models) ? req.body.models.map(String) : [])];
  if (!message) return res.status(400).json({ error: 'empty', message: 'Write a message first.' });
  if (message.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: 'too_long', message: `Messages can be up to ${MAX_MESSAGE_CHARS.toLocaleString()} characters.` });
  if (ids.length < 1 || ids.length > 3) return res.status(400).json({ error: 'models', message: 'Pick 1 to 3 models.' });
  if (!hit('chat:' + req.user.id, 20, 60e3)) return res.status(429).json({ error: 'slow_down', message: 'Too many messages in a minute. Please slow down.' });

  const all = await enabledModels();
  const models = ids.map(id => all.find(m => m.id === id));
  if (models.some(m => !m)) return res.status(400).json({ error: 'model_off', message: 'One of the selected models is not available. Refresh and try again.' });

  const user = await db.applyExpiry(req.user);
  const s = await db.getSettings();

  // Chat: existing (must belong to user) or new
  let chatId = Number(req.body?.chatId) || null;
  let prior = [];
  let title;
  if (chatId) {
    const chat = await loadChat(chatId, user.id);
    if (!chat) return res.status(404).json({ error: 'not_found', message: 'Chat not found.' });
    title = chat.title;
    prior = chat.turns.slice(-Math.max(0, Number(s.history_turns) || 0));
  }

  const system = { role: 'system', content: String(s.system_prompt || '') };
  const jobs = models.map(m => {
    const messages = [...(system.content ? [system] : []), ...historyFor(prior, m.id), { role: 'user', content: message }];
    return { m, messages, inTok: estMessages(messages) };
  });

  // Reserve tokens up front so parallel requests can't overspend; refund the difference afterwards.
  const sumMult = jobs.reduce((n, j) => n + j.m.mult, 0);
  const inCharge = jobs.reduce((n, j) => n + j.inTok * j.m.mult, 0);
  let maxOut = Number(s.max_output_tokens) || 2000;
  if (user.balance < inCharge + maxOut * sumMult) {
    maxOut = Math.floor((user.balance - inCharge) / sumMult);
  }
  if (maxOut < MIN_OUTPUT_TOKENS) {
    return res.status(402).json({
      error: 'not_enough_tokens',
      message: 'Not enough tokens for this message.',
      need: inCharge + MIN_OUTPUT_TOKENS * sumMult,
      balance: user.balance,
    });
  }
  const reserve = inCharge + maxOut * sumMult;
  const held = await db.q('UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance', [reserve, user.id]);
  if (!held.rowCount) return res.status(402).json({ error: 'not_enough_tokens', message: 'Not enough tokens for this message.', balance: user.balance });

  let turn, answers;
  try {
    if (!chatId) {
      title = message.replace(/\s+/g, ' ').slice(0, 60);
      const c = await db.q('INSERT INTO chats (user_id, title) VALUES ($1, $2) RETURNING id', [user.id, title]);
      chatId = c.rows[0].id;
    } else {
      await db.q('UPDATE chats SET updated_at = now() WHERE id = $1', [chatId]);
    }
    turn = (await db.q('INSERT INTO turns (chat_id, prompt) VALUES ($1, $2) RETURNING id', [chatId, message])).rows[0];
    answers = [];
    for (const j of jobs) {
      const a = await db.q('INSERT INTO answers (turn_id, user_id, model_id, mult) VALUES ($1, $2, $3, $4) RETURNING id', [turn.id, user.id, j.m.id, j.m.mult]);
      answers.push(a.rows[0].id);
    }
  } catch (e) {
    await db.q('UPDATE users SET balance = balance + $1 WHERE id = $2', [reserve, user.id]);
    throw e;
  }

  // Server-sent events over this POST response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

  send('meta', { chatId, title, turnId: turn.id, answers: jobs.map((j, i) => ({ id: answers[i], model: j.m.id })) });

  await Promise.all(jobs.map(async (j, i) => {
    const answerId = answers[i];
    let text = '';
    let usage = null;
    let status = 'done';
    let errMsg = null;
    try {
      for await (const ev of streamChat({ model: j.m.or_id, messages: j.messages, maxTokens: maxOut, signal: ac.signal })) {
        if (ev.type === 'delta') { text += ev.text; send('delta', { a: answerId, t: ev.text }); }
        else if (ev.type === 'usage') usage = ev.usage;
      }
    } catch (e) {
      if (ac.signal.aborted) status = 'stopped';
      else {
        status = 'error';
        errMsg = 'This model could not answer right now. You were only charged for what it wrote.';
        console.error(`[chat] ${j.m.or_id}:`, e.message);
      }
    }
    const promptTokens = Number(usage?.prompt_tokens) || j.inTok;
    const completionTokens = Number(usage?.completion_tokens) || (text ? estTokens(text) : 0);
    const charged = status === 'error' && !text ? 0 : (promptTokens + completionTokens) * j.m.mult;
    const heldHere = j.inTok * j.m.mult + maxOut * j.m.mult;
    const costUsd = Number(usage?.cost) || 0;

    let balance = 0;
    try {
      const b = await db.q('UPDATE users SET balance = GREATEST(balance + $1, 0) WHERE id = $2 RETURNING balance', [heldHere - charged, user.id]);
      balance = b.rows[0]?.balance ?? 0;
      await db.q(
        'UPDATE answers SET content = $1, status = $2, prompt_tokens = $3, completion_tokens = $4, charged = $5, cost_usd = $6 WHERE id = $7',
        [text, status, promptTokens, completionTokens, charged, costUsd, answerId]
      );
      if (charged > 0) {
        await db.q('INSERT INTO ledger (user_id, delta, reason, ref, balance_after) VALUES ($1, $2, $3, $4, $5)', [user.id, -charged, 'chat', String(answerId), balance]);
      }
    } catch (e) {
      console.error(`[chat] saving answer ${answerId} failed (held ${heldHere}, charge ${charged}, user ${user.id}):`, e.message);
    }
    send('done', { a: answerId, status, error: errMsg, promptTokens, completionTokens, mult: j.m.mult, charged, balance });
  }));

  clearInterval(ping);
  const fin = await db.q('SELECT balance FROM users WHERE id = $1', [user.id]);
  send('end', { balance: fin.rows[0]?.balance ?? 0 });
  res.end();
}));

module.exports = { router, publicModel };
