const { config } = require('./config');

function headers() {
  return {
    Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': config.BASE_URL || 'https://localhost',
    'X-Title': config.BRAND,
  };
}

class ORError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Streams one chat completion. Yields { type: 'delta', text } and finally { type: 'usage', usage }.
async function* streamChat({ model, messages, maxTokens, signal }) {
  const res = await fetch(`${config.OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, usage: { include: true } }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `OpenRouter error ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch { /* ignore */ }
    throw new ORError(msg, res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue; // keep-alive comments
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new ORError(j.error.message || 'Model error', j.error.code);
      const text = j.choices?.[0]?.delta?.content;
      if (text) yield { type: 'delta', text };
      if (j.usage) yield { type: 'usage', usage: j.usage };
    }
  }
}

async function listModels() {
  const res = await fetch(`${config.OPENROUTER_BASE}/models`, { headers: headers(), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new ORError(`OpenRouter models error ${res.status}`, res.status);
  const j = await res.json();
  return j.data || [];
}

// Remaining prepaid credit in USD.
async function credits() {
  const res = await fetch(`${config.OPENROUTER_BASE}/credits`, { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new ORError(`OpenRouter credits error ${res.status}`, res.status);
  const j = await res.json();
  const d = j.data || {};
  return { total: Number(d.total_credits || 0), used: Number(d.total_usage || 0), left: Number(d.total_credits || 0) - Number(d.total_usage || 0) };
}

module.exports = { streamChat, listModels, credits, ORError };
