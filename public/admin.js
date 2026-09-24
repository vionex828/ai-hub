(() => {
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const ICONS = window.ICONS || {};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const hydrate = root => (root || document).querySelectorAll('i[data-ic]').forEach(el => { el.outerHTML = ic(el.dataset.ic); });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = v => Math.round(Number(v) || 0).toLocaleString('en-US');
const tk = v => (v < 0 ? '−৳' : '৳') + fmt(Math.abs(v));
const usd = v => '$' + (Number(v) || 0).toFixed(2);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fDT = d => { if (!d) return '—'; d = new Date(d); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`; };
const fD = d => { if (!d) return '—'; d = new Date(d); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
const fPhone = p => `+880 ${p.slice(0, 4)}-${p.slice(4)}`;
const mk = m => `<span class="mk" style="background-color:${/^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#667069'}" aria-hidden="true">${esc((m.provider || m.name || '?')[0].toUpperCase())}</span>`;

let toastT;
function toast(msg, icon = 'circle-check') {
  const t = $('#toast'); t.innerHTML = ic(icon) + esc(msg); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
}
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && !path.endsWith('/login')) { showLogin(); throw new Error('Please log in again.'); }
  if (!res.ok) throw new Error(data?.message || `Request failed (${res.status})`);
  return data;
}

const A = { tab: 'overview', settings: null, models: [], plans: [], orModels: null };

function showLogin() { $('#a-app').hidden = true; $('#a-login').hidden = false; $('#apw').focus(); }
async function showApp() {
  $('#a-login').hidden = true; $('#a-app').hidden = false;
  await openTab(A.tab);
}
$('#fAdmin').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#aErr');
  try { await api('/api/admin/login', { method: 'POST', body: { password: $('#apw').value } }); err.hidden = true; $('#apw').value = ''; showApp(); }
  catch (x) { err.textContent = x.message; err.hidden = false; }
});
$('#aLogout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); showLogin(); });
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) openTab(b.dataset.tab); });

async function openTab(t) {
  A.tab = t;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  const box = $('#tab');
  box.innerHTML = '<div class="empty-box"><div class="spin" style="margin:0 auto"></div></div>';
  try {
    if (t === 'overview') await tabOverview(box);
    if (t === 'models') await tabModels(box);
    if (t === 'plans') await tabPlans(box);
    if (t === 'users') await tabUsers(box);
    if (t === 'payments') await tabPayments(box);
    if (t === 'settings') await tabSettings(box);
  } catch (x) {
    if (x.message !== 'Please log in again.') box.innerHTML = `<div class="banner bad">${ic('circle-alert')}${esc(x.message)}</div>`;
  }
}

/* ---------- overview ---------- */
async function tabOverview(box) {
  const d = await api('/api/admin/overview');
  A.settings = d.settings;
  $('#aBrand').textContent = d.brand + ' admin';
  const rate = Number(d.settings.usd_rate) || 0;
  const costToday = d.today.costUsd * rate, costMonth = d.month.costUsd * rate;
  const or = d.openrouter || {};
  const low = !or.error && or.left < d.lowCreditUsd;
  const flags = [];
  if (!d.status.payments) flags.push(`<div class="banner bad">${ic('circle-alert')}Payments are off. Set all EPS variables in Railway.</div>`);
  if (!d.status.sms && !d.status.otpDebug) flags.push(`<div class="banner bad">${ic('circle-alert')}SMS is not set up, so customers cannot log in. Set SMS_API_KEY and SMS_SENDER_ID.</div>`);
  if (d.status.otpDebug) flags.push(`<div class="banner warn">${ic('info')}OTP_DEBUG is on. Login codes appear on screen. Turn it off before launch.</div>`);
  if (low) flags.push(`<div class="banner warn">${ic('info')}OpenRouter credit is low (${usd(or.left)}). Top up so chats keep working.</div>`);
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:28px">
    ${flags.join('')}
    <section><div class="sec-h"><h2>Today</h2><small>Bangladesh time</small></div>
      <div class="tiles">
        <div class="panel tile"><span class="t-l">${ic('wallet')}Sales</span><span class="t-v">${tk(d.today.sales)}</span><span class="t-s">${d.today.payments} payment${d.today.payments === 1 ? '' : 's'}</span></div>
        <div class="panel tile"><span class="t-l">${ic('trending-up')}API cost</span><span class="t-v">${tk(costToday)}</span><span class="t-s">${usd(d.today.costUsd)} · ${fmt(d.today.messages)} replies</span></div>
        <div class="panel tile"><span class="t-l">${ic('users')}New customers</span><span class="t-v">${fmt(d.today.newUsers)}</span><span class="t-s">${fmt(d.activeUsers30d)} active in 30 days</span></div>
        <div class="panel tile"><span class="t-l">${ic('coins')}OpenRouter credit</span><span class="t-v" style="${low ? 'color:var(--danger)' : ''}">${or.error ? '—' : usd(or.left)}</span><span class="t-s">${or.error ? 'Could not read balance' : 'Alert below ' + usd(d.lowCreditUsd)}</span></div>
      </div>
    </section>
    <section><div class="sec-h"><h2>This month</h2></div>
      <div class="tiles">
        <div class="panel tile"><span class="t-l">Sales</span><span class="t-v">${tk(d.month.sales)}</span></div>
        <div class="panel tile"><span class="t-l">API cost</span><span class="t-v">${tk(costMonth)}</span><span class="t-s">${usd(d.month.costUsd)} before the OpenRouter fee</span></div>
        <div class="panel tile"><span class="t-l">Gross profit</span><span class="t-v ${d.month.sales - costMonth >= 0 ? 'pos' : 'neg'}">${tk(d.month.sales - costMonth * (1 + (Number(d.settings.or_fee_pct) || 0) / 100))}</span><span class="t-s">Sales minus API cost and fee</span></div>
      </div>
    </section>
  </div>`;
}

/* ---------- models ---------- */
async function tabModels(box) {
  const d = await api('/api/admin/models');
  A.models = d.models;
  const orMap = new Map((A.orModels || []).map(m => [m.id, m]));
  const orCell = m => {
    if (!A.orModels) return '';
    const o = orMap.get(m.or_id);
    if (!o) return '<div class="or-bad">Not found on OpenRouter</div>';
    const avg = (o.input + o.output) / 2;
    return `<div class="or-ok">In ${usd(o.input)} · Out ${usd(o.output)} <button class="link" data-useprice="${esc(m.id)}" data-price="${avg.toFixed(3)}">Use avg ${usd(avg)}</button></div>`;
  };
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:18px">
    <div class="sec-h" style="margin:0"><h2>Models</h2><button class="btn btn-out btn-sm" id="orCheck">${ic('refresh-cw')}Check IDs and prices on OpenRouter</button></div>
    <div class="panel tbl"><table>
      <thead><tr><th>On</th><th>Model</th><th>OpenRouter ID</th><th class="num">Cost $/1M</th><th class="num">Token rate</th><th>Note shown to customers</th><th>Color</th><th>Logo URL</th><th class="num">Order</th><th></th></tr></thead>
      <tbody>${A.models.map(m => `<tr data-row="${esc(m.id)}">
        <td><label class="sw"><input type="checkbox" data-f="enabled" ${m.enabled ? 'checked' : ''} aria-label="Enabled"><span class="tr"></span></label></td>
        <td><div class="cm">${mk(m)}<div><input class="inp" data-f="name" value="${esc(m.name)}" style="width:130px;text-align:left" aria-label="Name"><div><input class="inp" data-f="provider" value="${esc(m.provider)}" style="width:130px;text-align:left;height:28px;font-size:12.5px;margin-top:4px" aria-label="Provider"></div></div></div></td>
        <td><input class="inp wide" data-f="or_id" value="${esc(m.or_id)}" aria-label="OpenRouter ID">${orCell(m)}</td>
        <td class="num"><input class="inp" data-f="cost_usd" type="number" step="0.01" min="0" value="${m.cost_usd}" aria-label="Cost"></td>
        <td class="num"><input class="inp sm" data-f="mult" type="number" step="1" min="1" value="${m.mult}" aria-label="Token rate"></td>
        <td><input class="inp" data-f="note" value="${esc(m.note)}" style="width:220px;text-align:left" aria-label="Note"></td>
        <td><input class="inp color" data-f="color" type="color" value="${esc(m.color)}" aria-label="Color"></td>
        <td><input class="inp" data-f="logo_url" value="${esc(m.logo_url)}" placeholder="/logos/claude.svg" style="width:150px;text-align:left" aria-label="Logo URL"></td>
        <td class="num"><input class="inp sm" data-f="sort" type="number" step="1" value="${m.sort}" aria-label="Order"></td>
        <td><div class="row-act"><button class="btn btn-pri btn-sm" data-save="${esc(m.id)}">Save</button><button class="icon-btn" data-delmodel="${esc(m.id)}" title="Delete" aria-label="Delete">${ic('trash-2')}</button></div></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="note">Token rate is how many tokens you take from the customer per real token: 1 for everyday models, 6 for premium. Cost is your average price per 1M tokens (input and output), used for the profit numbers. Turn a model off to hide it from customers without deleting it.</p>
    <section class="panel"><div class="form-grid">
      <label class="field">Name<input class="inp" id="nm-name" placeholder="Claude Opus"></label>
      <label class="field">Provider<input class="inp" id="nm-provider" placeholder="Anthropic"></label>
      <label class="field">OpenRouter ID<input class="inp" id="nm-or" placeholder="anthropic/claude-opus-4.1"></label>
      <label class="field">Cost $/1M<input class="inp" id="nm-cost" type="number" step="0.01" min="0" value="1"></label>
      <label class="field">Token rate<input class="inp" id="nm-mult" type="number" step="1" min="1" value="1"></label>
      <label class="field">Note<input class="inp" id="nm-note" placeholder="Best for deep reasoning"></label>
    </div><div class="row-end"><button class="btn btn-pri btn-sm" id="nmAdd">${ic('plus')}Add model</button></div></section>
  </div>`;

  $('#orCheck').addEventListener('click', async () => {
    const b = $('#orCheck'); b.disabled = true; b.textContent = 'Checking…';
    try { A.orModels = (await api('/api/admin/openrouter-models')).models; toast('Checked against OpenRouter'); tabModels(box); }
    catch (x) { toast(x.message, 'circle-alert'); b.disabled = false; b.textContent = 'Try again'; }
  });
  box.querySelectorAll('[data-useprice]').forEach(b => b.addEventListener('click', () => {
    const row = box.querySelector(`tr[data-row="${CSS.escape(b.dataset.useprice)}"]`);
    row.querySelector('[data-f="cost_usd"]').value = b.dataset.price;
    toast('Price filled in. Press Save to keep it', 'info');
  }));
  box.querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('tr'); const body = {};
    row.querySelectorAll('[data-f]').forEach(inp => { body[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.value; });
    try { await api('/api/admin/models/' + encodeURIComponent(b.dataset.save), { method: 'PUT', body }); toast('Saved'); } catch (x) { toast(x.message, 'circle-alert'); }
  }));
  box.querySelectorAll('[data-delmodel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this model? Old chats keep their answers. You can also just switch it off.')) return;
    try { await api('/api/admin/models/' + encodeURIComponent(b.dataset.delmodel), { method: 'DELETE' }); toast('Deleted'); tabModels(box); } catch (x) { toast(x.message, 'circle-alert'); }
  }));
  $('#nmAdd').addEventListener('click', async () => {
    const body = { name: $('#nm-name').value, provider: $('#nm-provider').value, or_id: $('#nm-or').value, cost_usd: $('#nm-cost').value, mult: $('#nm-mult').value, note: $('#nm-note').value, sort: 100 };
    try { await api('/api/admin/models', { method: 'POST', body }); toast('Model added'); tabModels(box); } catch (x) { toast(x.message, 'circle-alert'); }
  });
}

/* ---------- plans ---------- */
async function tabPlans(box) {
  const [p, m, o] = await Promise.all([api('/api/admin/plans'), api('/api/admin/models'), A.settings ? null : api('/api/admin/overview')]);
  if (o) A.settings = o.settings;
  A.plans = p.plans; A.models = m.models;
  const s = A.settings;
  const worst = () => {
    const on = A.models.filter(x => x.enabled);
    let best = null;
    on.forEach(x => { const per = Number(x.cost_usd) / Number(x.mult); if (!best || per > best.per) best = { per, m: x }; });
    return best || { per: 0, m: null };
  };
  const w = worst();
  const perM = w.per * Number(s.usd_rate) * (1 + Number(s.or_fee_pct) / 100);
  const rows = [...A.plans.map(x => ({ ...x, kind: 'plan' })), { id: 'topup', name: 'Top-up', price: s.topup.price, tokens: s.topup.tokens, days: s.topup.days || 30, kind: 'topup' }];
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:18px">
    <div class="panel tbl"><table>
      <thead><tr><th>Plan</th><th>Tagline</th><th class="num">Price ৳</th><th class="num">Tokens (M)</th><th class="num">Days</th><th>Shown</th><th>Recommended</th><th class="num">Worst-case cost</th><th class="num">Minimum profit</th><th></th></tr></thead>
      <tbody>${rows.map(x => `<tr data-plan="${esc(x.id)}">
        <td>${x.kind === 'plan' ? `<input class="inp" data-f="name" value="${esc(x.name)}" style="width:90px;text-align:left" aria-label="Plan name">` : '<b style="font-weight:500">Top-up</b>'}</td>
        <td>${x.kind === 'plan' ? `<input class="inp" data-f="tagline" value="${esc(x.tagline)}" style="width:150px;text-align:left" aria-label="Tagline">` : '<span class="mono">—</span>'}</td>
        <td class="num"><input class="inp" data-f="price" type="number" step="10" min="1" value="${x.price}" aria-label="Price"></td>
        <td class="num"><input class="inp" data-f="tokens" type="number" step="0.1" min="0.01" value="${x.tokens / 1e6}" aria-label="Tokens in millions"></td>
        <td class="num"><input class="inp sm" data-f="days" type="number" step="1" min="1" value="${x.days}" aria-label="Days"></td>
        <td>${x.kind === 'plan' ? `<label class="sw"><input type="checkbox" data-f="active" ${x.active ? 'checked' : ''} aria-label="Shown"><span class="tr"></span></label>` : ''}</td>
        <td>${x.kind === 'plan' ? `<label class="sw"><input type="checkbox" data-f="featured" ${x.featured ? 'checked' : ''} aria-label="Recommended"><span class="tr"></span></label>` : ''}</td>
        <td class="num" data-wc></td><td class="num" data-mg></td>
        <td><button class="btn btn-pri btn-sm" data-saveplan="${esc(x.id)}">Save</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="note">${w.m ? `Worst case means a customer spends every token on <b>${esc(w.m.name)}</b>, the model that costs you the most per token: ${usd(w.per)} per 1M credits, or ${tk(perM)} with the ${s.or_fee_pct}% fee at ৳${s.usd_rate}/$. Most customers use far less than their full allowance, so real profit is usually much higher.` : 'Turn on at least one model to see profit.'} Change the dollar rate and fee in Settings.</p>
  </div>`;
  const recalc = tr => {
    const price = Number(tr.querySelector('[data-f="price"]').value) || 0;
    const tokens = (Number(tr.querySelector('[data-f="tokens"]').value) || 0) * 1e6;
    const wc = tokens / 1e6 * perM; const mg = price - wc;
    tr.querySelector('[data-wc]').textContent = tk(wc);
    const c = tr.querySelector('[data-mg]'); c.textContent = tk(mg); c.className = 'num ' + (mg >= 0 ? 'pos' : 'neg');
  };
  box.querySelectorAll('tr[data-plan]').forEach(tr => { recalc(tr); tr.addEventListener('input', () => recalc(tr)); });
  box.querySelectorAll('[data-saveplan]').forEach(b => b.addEventListener('click', async () => {
    const tr = b.closest('tr'); const id = b.dataset.saveplan; const get = f => tr.querySelector(`[data-f="${f}"]`);
    try {
      if (id === 'topup') {
        await api('/api/admin/settings', { method: 'PUT', body: { topup: { price: get('price').value, tokens: Math.round(Number(get('tokens').value) * 1e6), days: get('days').value } } });
        A.settings = null;
      } else {
        await api('/api/admin/plans/' + encodeURIComponent(id), { method: 'PUT', body: { name: get('name').value, tagline: get('tagline').value, price: get('price').value, tokens: Math.round(Number(get('tokens').value) * 1e6), days: get('days').value, active: get('active').checked, featured: get('featured').checked } });
      }
      toast('Saved');
    } catch (x) { toast(x.message, 'circle-alert'); }
  }));
}

/* ---------- customers ---------- */
async function tabUsers(box, q = '') {
  const d = await api('/api/admin/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
  const now = Date.now();
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:18px">
    <form class="row-act" id="uSearch" style="max-width:420px"><input class="inp" id="uq" placeholder="Search by phone number" value="${esc(q)}" style="flex:1;text-align:left;height:40px"><button class="btn btn-out btn-sm" type="submit">${ic('search')}Search</button></form>
    <div class="panel tbl">${d.users.length ? `<table>
      <thead><tr><th>Number</th><th>Plan</th><th class="num">Tokens left</th><th>Valid until</th><th>Last seen</th><th>Add or remove tokens</th><th></th></tr></thead>
      <tbody>${d.users.map(u => {
        const active = u.expires_at && new Date(u.expires_at) > now;
        return `<tr>
        <td class="num" style="text-align:left">${fPhone(u.phone)}${u.blocked ? ' <span class="st failed">Blocked</span>' : ''}</td>
        <td>${active ? esc(u.plan_id || '—') : '<span class="mono">none</span>'}</td>
        <td class="num">${fmt(u.balance)}</td>
        <td>${active ? fD(u.expires_at) : '—'}</td>
        <td>${fDT(u.last_seen)}</td>
        <td><div class="row-act"><input class="inp" data-delta="${u.id}" inputmode="numeric" placeholder="50000 or -50000" style="width:140px"><input class="inp sm" data-days="${u.id}" inputmode="numeric" placeholder="+days" title="Extra days of validity (optional)"><button class="btn btn-out btn-sm" data-adjust="${u.id}">Apply</button></div></td>
        <td><button class="btn btn-out btn-sm" data-block="${u.id}" data-to="${u.blocked ? '0' : '1'}">${u.blocked ? 'Unblock' : 'Block'}</button></td>
      </tr>`;
      }).join('')}</tbody>
    </table>` : '<div class="empty-box">No customers found.</div>'}</div>
    <p class="note">Giving tokens to someone without an active plan? Add days too (for example 30), or the tokens won't have an end date.</p>
  </div>`;
  $('#uSearch').addEventListener('submit', e => { e.preventDefault(); tabUsers(box, $('#uq').value.trim()); });
  box.querySelectorAll('[data-adjust]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.adjust;
    const delta = Number(String(box.querySelector(`[data-delta="${id}"]`).value).replace(/[^0-9-]/g, ''));
    const days = Number(box.querySelector(`[data-days="${id}"]`).value) || 0;
    if (!delta) { toast('Enter a number like 50000 or -50000', 'info'); return; }
    try { await api(`/api/admin/users/${id}/adjust`, { method: 'POST', body: { delta, days, note: 'admin panel' } }); toast(delta > 0 ? `Added ${fmt(delta)} tokens` : `Removed ${fmt(-delta)} tokens`); tabUsers(box, q); }
    catch (x) { toast(x.message, 'circle-alert'); }
  }));
  box.querySelectorAll('[data-block]').forEach(b => b.addEventListener('click', async () => {
    const blocked = b.dataset.to === '1';
    if (blocked && !confirm('Block this customer? They will be logged out and cannot log in.')) return;
    try { await api(`/api/admin/users/${b.dataset.block}/block`, { method: 'POST', body: { blocked } }); toast(blocked ? 'Blocked' : 'Unblocked'); tabUsers(box, q); }
    catch (x) { toast(x.message, 'circle-alert'); }
  }));
}

/* ---------- payments ---------- */
async function tabPayments(box, status = '') {
  const d = await api('/api/admin/payments' + (status ? '?status=' + status : ''));
  const opts = ['', 'paid', 'pending', 'failed', 'cancelled', 'expired'];
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:18px">
    <div class="row-act">${opts.map(o => `<button class="btn ${o === status ? 'btn-pri' : 'btn-out'} btn-sm" data-pst="${o}">${o ? o[0].toUpperCase() + o.slice(1) : 'All'}</button>`).join('')}</div>
    <div class="panel tbl">${d.payments.length ? `<table>
      <thead><tr><th>Time</th><th>Customer</th><th>Item</th><th class="num">Amount</th><th class="num">Tokens</th><th>Status</th><th>EPS transaction</th><th>Method</th><th></th></tr></thead>
      <tbody>${d.payments.map(p => `<tr>
        <td>${fDT(p.created_at)}</td><td>${fPhone(p.phone)}</td><td>${p.kind === 'plan' ? esc(p.plan_id) + ' plan' : 'Top-up'}</td>
        <td class="num">${tk(p.amount)}</td><td class="num">${fmt(p.tokens)}</td>
        <td><span class="st ${esc(p.status)}">${esc(p.status)}</span></td>
        <td><span class="mono">${esc(p.eps_txn || p.mtid)}</span></td><td>${esc(p.method || '—')}</td>
        <td>${p.status !== 'paid' ? `<button class="btn btn-out btn-sm" data-verify="${esc(p.mtid)}">Check with EPS</button>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="empty-box">No payments here yet.</div>'}</div>
    <p class="note">The server checks every payment directly with EPS before adding tokens. Pending payments are re-checked automatically every 2 minutes for 3 hours.</p>
  </div>`;
  box.querySelectorAll('[data-pst]').forEach(b => b.addEventListener('click', () => tabPayments(box, b.dataset.pst)));
  box.querySelectorAll('[data-verify]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Checking…';
    try { const r = await api(`/api/admin/payments/${encodeURIComponent(b.dataset.verify)}/verify`, { method: 'POST', body: {} }); toast('EPS says: ' + r.result, 'info'); tabPayments(box, status); }
    catch (x) { toast(x.message, 'circle-alert'); b.disabled = false; b.textContent = 'Check with EPS'; }
  }));
}

/* ---------- settings ---------- */
async function tabSettings(box) {
  const d = await api('/api/admin/overview');
  const s = d.settings; A.settings = s;
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:18px">
    <section class="panel">
      <div class="form-grid">
        <label class="field">Dollar rate (৳ per $)<input class="inp" id="s-rate" type="number" step="0.5" min="1" value="${s.usd_rate}"><small>Used for profit numbers</small></label>
        <label class="field">OpenRouter fee (%)<input class="inp" id="s-fee" type="number" step="0.1" min="0" value="${s.or_fee_pct}"><small>Charged when you buy credit</small></label>
        <label class="field">Max reply length (tokens)<input class="inp" id="s-max" type="number" step="100" min="200" value="${s.max_output_tokens}"><small>Longest single answer</small></label>
        <label class="field">Chat memory (turns)<input class="inp" id="s-hist" type="number" step="1" min="0" max="30" value="${s.history_turns}"><small>Earlier messages sent with each question. More memory uses more tokens</small></label>
        <label class="field">Free tokens for new sign-ups<input class="inp" id="s-bonus" type="number" step="1000" min="0" value="${s.signup_bonus?.tokens || 0}"><small>0 turns it off</small></label>
        <label class="field">Free tokens valid for (days)<input class="inp" id="s-bonusd" type="number" step="1" min="1" value="${s.signup_bonus?.days || 7}"></label>
      </div>
      <div class="form-grid" style="padding-top:0"><label class="field" style="grid-column:1/-1">Instructions sent to every model<textarea id="s-sys">${esc(s.system_prompt)}</textarea><small>Keep it short. It counts toward every message's tokens</small></label></div>
      <div class="row-end"><button class="btn btn-pri" id="sSave">Save settings</button></div>
    </section>
    <section class="panel" style="padding:18px 20px;display:flex;flex-direction:column;gap:8px">
      <h2 style="font-size:16px">Status</h2>
      <div><span class="dot ${d.status.payments ? 'on' : 'off'}"></span>EPS payments ${d.status.payments ? 'ready' : 'not set up'}</div>
      <div><span class="dot ${d.status.sms ? 'on' : 'off'}"></span>SMS login codes ${d.status.sms ? 'ready' : 'not set up'}</div>
      <div><span class="dot ${d.status.otpDebug ? 'off' : 'on'}"></span>OTP_DEBUG ${d.status.otpDebug ? 'ON (turn off before launch)' : 'off'}</div>
    </section>
  </div>`;
  $('#sSave').addEventListener('click', async () => {
    const body = {
      usd_rate: $('#s-rate').value, or_fee_pct: $('#s-fee').value, max_output_tokens: $('#s-max').value, history_turns: $('#s-hist').value,
      signup_bonus: { tokens: $('#s-bonus').value, days: $('#s-bonusd').value }, system_prompt: $('#s-sys').value,
    };
    try { const r = await api('/api/admin/settings', { method: 'PUT', body }); A.settings = r.settings; toast('Settings saved'); } catch (x) { toast(x.message, 'circle-alert'); }
  });
}

/* ---------- start ---------- */
hydrate();
api('/api/admin/overview').then(() => showApp()).catch(() => showLogin());
})();
