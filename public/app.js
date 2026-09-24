(() => {
'use strict';

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const ICONS = window.ICONS || {};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const hydrate = root => (root || document).querySelectorAll('i[data-ic]').forEach(el => { el.outerHTML = ic(el.dataset.ic); });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toLatin = s => String(s).replace(/[০-৯]/g, c => '০১২৩৪৫৬৭৮৯'.indexOf(c));
const fmt = v => Math.round(Number(v) || 0).toLocaleString('en-US');
const short = v => { v = Number(v) || 0; return v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M' : v >= 1e4 ? Math.round(v / 1e3) + 'K' : v >= 1e3 ? (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : fmt(v); };
const tk = v => '৳' + fmt(v);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fDate = d => { d = new Date(d); return `${MON[d.getMonth()]} ${d.getDate()}`; };
const fDateY = d => { d = new Date(d); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
const fDT = d => { d = new Date(d); return `${fDate(d)}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`; };
const fPhone = p => p ? `+880 ${p.slice(0, 4)}-${p.slice(4)}` : '';
const greet = () => { const h = new Date().getHours(); return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const estTokens = s => { s = String(s || ''); const b = (s.match(/[ঀ-৿]/g) || []).length; return Math.max(1, Math.ceil(b / 2 + (s.length - b) / 4)); };
const LOW = 50000;
const FAMILY = { OpenAI: 'ChatGPT', Anthropic: 'Claude', Google: 'Gemini', xAI: 'Grok', DeepSeek: 'DeepSeek' };
let keySeq = 0; const newKey = () => 'k' + (++keySeq);

const store = {
  get(k, d) { try { const v = localStorage.getItem('aih:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('aih:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  });
}
function md(text) {
  const src = String(text || '');
  if (!window.marked || !window.DOMPurify) return '<p>' + esc(src).replace(/\n/g, '<br>') + '</p>';
  return DOMPurify.sanitize(marked.parse(src, { gfm: true, breaks: true }));
}
function withCaret(html) {
  const c = '<span class="caret" aria-hidden="true"></span>';
  const i = Math.max(html.lastIndexOf('</p>'), html.lastIndexOf('</li>'));
  return i < 0 ? html + c : html.slice(0, i) + c + html.slice(i);
}
function addCodeCopy(root) {
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'code-copy'; b.textContent = 'Copy';
    b.addEventListener('click', () => copyText(pre.querySelector('code')?.innerText || pre.innerText, pre));
    pre.appendChild(b);
  });
}

/* ================= state ================= */
const S = {
  me: null, brand: 'AI Hub', models: [], plans: [], topup: null, paymentsOn: true,
  chats: [], chat: null, selected: null, compare: false, compareSel: [],
  busy: false, ctrl: null, screen: 'chat', pickerOpen: false, collapsed: false,
};
const model = id => S.models.find(m => m.id === id);
const modelOr = (id, mult) => model(id) || { id, name: id, provider: '', color: '#667069', mult: mult || 1, logo: '' };
const planName = id => (S.plans.find(p => p.id === id) || {}).name || '';
const maxMult = () => Math.max(1, ...S.models.map(m => m.mult));
const letter = m => (m.provider || m.name || '?').trim()[0].toUpperCase();
const mk = (m, lg) => m.logo
  ? `<span class="mk logo ${lg ? 'lg' : ''}" aria-hidden="true"><img src="${esc(m.logo)}" alt=""></span>`
  : `<span class="mk ${lg ? 'lg' : ''}" style="background-color:${/^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#667069'}" aria-hidden="true">${esc(letter(m))}</span>`;
const mx = mult => `<span class="mx ${mult > 1 ? 'prem' : ''}">${mult}×</span>`;

/* ================= API ================= */
async function api(path, { method = 'GET', body, allow401 = false } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error('No connection. Check your internet and try again.'); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401) {
    if (allow401) return null;
    showLogin();
    throw Object.assign(new Error('Please log in again.'), { status: 401 });
  }
  if (!res.ok) throw Object.assign(new Error(data?.message || 'Something went wrong. Please try again.'), { status: res.status, data });
  return data;
}

let toastT;
function toast(msg, icon = 'circle-check') {
  const t = $('#toast'); t.innerHTML = ic(icon) + esc(msg); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
}
function copyText(text, selectEl) {
  const fallback = () => {
    if (!selectEl) return;
    const r = document.createRange(); r.selectNodeContents(selectEl);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    toast('Text selected. Copy it from here');
  };
  try { navigator.clipboard.writeText(text).then(() => toast('Copied'), fallback); } catch { fallback(); }
}

/* ================= boot & auth ================= */
async function boot() {
  hydrate();
  try { const m = await api('/api/models'); S.models = m.models || []; } catch { S.models = []; }
  S.selected = store.get('model', null);
  if (!model(S.selected)) S.selected = S.models[0]?.id || null;
  S.compare = store.get('compare', false);
  S.compareSel = store.get('compareSel', []).filter(id => model(id));
  S.collapsed = store.get('collapsed', false);
  renderLoginModels();
  const me = await api('/api/me', { allow401: true }).catch(() => null);
  $('#boot').hidden = true;
  if (me) enterApp(me); else showLogin();
}

function setBrand(b) {
  S.brand = b || S.brand;
  $$('[data-brand]').forEach(e => { e.textContent = S.brand; });
  document.title = S.brand;
}

function showLogin() {
  S.me = null;
  $('#shell').hidden = true;
  $('#v-login').hidden = false;
  closeDrawer(); closePicker();
  resetLogin();
  setBrand();
}

async function enterApp(me) {
  S.me = me.user; setBrand(me.brand);
  $('#v-login').hidden = true;
  $('#shell').hidden = false;
  $('#shell').classList.toggle('collapsed', S.collapsed && wide());
  try { const p = await api('/api/plans'); S.plans = p.plans; S.topup = p.topup; S.paymentsOn = p.paymentsOn; } catch { /* shown later */ }
  updateBalanceUI();
  loadChats();
  const params = new URLSearchParams(location.search);
  const pay = params.get('pay');
  if (pay) {
    history.replaceState(null, '', location.pathname + '#plans');
    if (pay === 'success') toast('Payment successful. Tokens added');
    else if (pay === 'failed') toast('Payment was not completed', 'circle-alert');
    else toast('Payment is being confirmed. This can take a minute', 'info');
    if (pay === 'pending') setTimeout(refreshMe, 20000);
  }
  const h = location.hash.replace('#', '');
  go(['plans', 'usage'].includes(h) ? h : 'chat', { keepHash: true });
}

async function refreshMe() {
  const me = await api('/api/me', { allow401: true }).catch(() => null);
  if (me) { S.me = me.user; updateBalanceUI(); if (S.screen === 'plans') renderPlans(); }
}

function renderLoginModels() {
  const seen = new Set();
  const rows = [];
  for (const m of S.models) {
    const fam = FAMILY[m.provider] || m.provider || m.name;
    if (seen.has(fam)) continue; seen.add(fam);
    rows.push(`<div class="lg-m">${mk(m, true)}<span>${esc(fam)}</span><span class="lg-sub">${esc(m.provider)}</span></div>`);
  }
  $('#lgModels').innerHTML = rows.join('');
}

let pendingPhone = '', resendT = null;
function cleanPhone(raw) { let d = toLatin(raw).replace(/\D/g, ''); if (d.startsWith('880')) d = d.slice(3); if (d.startsWith('0')) d = d.slice(1); return d; }
function resetLogin() {
  $('#fPhone').hidden = false; $('#fOtp').hidden = true;
  $('#phoneErr').hidden = true; $('#otpErr').hidden = true;
  $$('#otpBoxes input').forEach(i => { i.value = ''; });
  $('#debugCode').textContent = '';
  clearInterval(resendT);
}
function startResend() {
  let s = 60; const b = $('#resend'); b.disabled = true;
  const tick = () => { b.textContent = `Resend in ${s}s`; if (s-- <= 0) { clearInterval(resendT); b.disabled = false; b.textContent = 'Resend code'; } };
  clearInterval(resendT); tick(); resendT = setInterval(tick, 1000);
}
function busyBtn(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = label || 'Please wait…'; }
  else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
}
async function requestOtp() {
  const d = cleanPhone($('#phone').value); const err = $('#phoneErr');
  if (!/^1[3-9]\d{8}$/.test(d)) { err.textContent = 'Enter a valid Bangladeshi mobile number, like 1712 345678 or 01712 345678.'; err.hidden = false; return false; }
  err.hidden = true;
  const r = await api('/api/auth/send-otp', { method: 'POST', body: { phone: d } });
  pendingPhone = d;
  $('#otpTo').textContent = fPhone(d);
  $('#debugCode').innerHTML = r.debugCode ? `Test code <span class="demo-code">${esc(r.debugCode)}</span>` : '';
  return true;
}
$('#fPhone').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#phoneBtn'); busyBtn(btn, true, 'Sending code…');
  try {
    if (await requestOtp()) { $('#fPhone').hidden = true; $('#fOtp').hidden = false; startResend(); $('#otp0').focus(); }
  } catch (x) { const err = $('#phoneErr'); err.textContent = x.message; err.hidden = false; }
  busyBtn(btn, false);
});
$('#chgNum').addEventListener('click', resetLogin);
$('#resend').addEventListener('click', async () => {
  $('#phone').value = pendingPhone;
  try { await requestOtp(); toast('New code sent'); startResend(); } catch (x) { const err = $('#otpErr'); err.textContent = x.message; err.hidden = false; }
});
const otpIns = $$('#otpBoxes input');
otpIns.forEach((inp, i) => {
  inp.addEventListener('input', () => {
    inp.value = toLatin(inp.value).replace(/\D/g, '').slice(-1);
    if (inp.value && i < 5) otpIns[i + 1].focus();
    if (otpIns.every(x => x.value)) $('#fOtp').requestSubmit();
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Backspace' && !inp.value && i > 0) otpIns[i - 1].focus(); });
  inp.addEventListener('paste', e => {
    const t = toLatin((e.clipboardData || window.clipboardData).getData('text')).replace(/\D/g, '').slice(0, 6);
    if (!t) return; e.preventDefault();
    t.split('').forEach((c, k) => { if (otpIns[k]) otpIns[k].value = c; });
    otpIns[Math.min(t.length, 5)].focus();
    if (t.length === 6) $('#fOtp').requestSubmit();
  });
});
let verifying = false;
$('#fOtp').addEventListener('submit', async e => {
  e.preventDefault();
  if (verifying) return;
  const code = otpIns.map(i => i.value).join(''); const err = $('#otpErr');
  if (code.length < 6) { err.textContent = 'Enter all 6 digits.'; err.hidden = false; return; }
  verifying = true; const btn = $('#otpBtn'); busyBtn(btn, true, 'Checking…');
  try {
    await api('/api/auth/verify-otp', { method: 'POST', body: { phone: pendingPhone, code } });
    err.hidden = true; clearInterval(resendT);
    const me = await api('/api/me');
    S.chat = null;
    await enterApp(me);
    toast("Welcome! You're logged in");
  } catch (x) {
    err.textContent = x.message; err.hidden = false;
    otpIns.forEach(i => { i.value = ''; }); otpIns[0].focus();
  }
  verifying = false; busyBtn(btn, false);
});

async function logout() {
  if (S.ctrl) S.ctrl.abort();
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  S.chats = []; S.chat = null;
  showLogin();
}

/* ================= shared UI ================= */
function updateBalanceUI() {
  if (!S.me) return;
  const u = S.me;
  const total = Math.max(u.planTotal || 0, u.balance || 0, 1);
  const pct = Math.max(0, Math.min(1, u.balance / total));
  const low = u.balance < LOW;
  $$('[data-bal-short]').forEach(e => { e.textContent = short(u.balance); });
  $$('[data-ring]').forEach(e => { e.style.strokeDashoffset = 113.1 * (1 - pct); e.classList.toggle('low', low); });
  const days = u.expiresAt ? Math.max(0, Math.ceil((new Date(u.expiresAt) - Date.now()) / 864e5)) : 0;
  $$('[data-bal-sub]').forEach(e => { e.textContent = u.active ? `of ${short(total)} · ${days} day${days === 1 ? '' : 's'} left` : 'No active plan'; });
  $$('[data-bal-pill]').forEach(e => e.classList.toggle('low', low));
  $$('[data-phone]').forEach(e => { e.textContent = fPhone(u.phone); });
  $$('[data-plan-line]').forEach(e => { e.textContent = u.active && u.planId ? `${planName(u.planId) || 'Active'} plan` : 'No plan yet'; });
  updateComposer();
}

const wide = () => matchMedia('(min-width:920px)').matches;
function go(s, { keepHash } = {}) {
  S.screen = s;
  ['chat', 'plans', 'usage'].forEach(v => { $('#v-' + v).hidden = v !== s; });
  $$('.nav button').forEach(b => { const on = b.dataset.go === s; b.classList.toggle('on', on); on ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'); });
  closeDrawer(); closePicker();
  if (!keepHash) history.replaceState(null, '', location.pathname + (s === 'chat' ? '' : '#' + s));
  if (s === 'chat') { renderChat(); renderModelBtn(); updateComposer(); }
  if (s === 'plans') renderPlans();
  if (s === 'usage') renderUsage();
  renderRecent();
}
function toggleSide() {
  if (wide()) { S.collapsed = !S.collapsed; store.set('collapsed', S.collapsed); $('#shell').classList.toggle('collapsed', S.collapsed); }
  else if ($('#side').classList.contains('open')) closeDrawer(); else openDrawer();
}
function openDrawer() { $('#side').classList.add('open'); $('#scrim').hidden = false; }
function closeDrawer() { $('#side').classList.remove('open'); $('#scrim').hidden = true; }

/* ================= chats list ================= */
async function loadChats() {
  try { const r = await api('/api/chats'); S.chats = r.chats || []; } catch { S.chats = []; }
  renderRecent();
}
function renderRecent() {
  const box = $('#recent');
  if (!S.chats.length) { box.innerHTML = '<div class="recent-empty">Your chats will show up here</div>'; return; }
  box.innerHTML = S.chats.map(c => `<div class="recent-row ${S.chat && c.id === S.chat.id && S.screen === 'chat' ? 'on' : ''}">
    <button class="recent-item" data-chat="${c.id}" title="${esc(c.title)}">${esc(c.title)}</button>
    <button class="icon-btn recent-del" data-del="${c.id}" aria-label="Delete chat" title="Delete chat">${ic('trash-2')}</button>
  </div>`).join('');
}
async function openChat(id) {
  if (S.busy) { toast('Wait for the answer to finish, or press stop', 'info'); return; }
  try {
    const r = await api('/api/chats/' + id);
    S.chat = { id: r.chat.id, title: r.chat.title, turns: r.chat.turns.map(t => ({ ...t, answers: t.answers.map(a => ({ ...a, key: newKey() })) })) };
    go('chat');
  } catch (x) { toast(x.message, 'circle-alert'); }
}
async function deleteChat(id) {
  if (!confirm('Delete this chat? This cannot be undone.')) return;
  try {
    await api('/api/chats/' + id, { method: 'DELETE' });
    S.chats = S.chats.filter(c => c.id !== id);
    if (S.chat && S.chat.id === id) { S.chat = null; if (S.screen === 'chat') renderChat(); }
    renderRecent();
    toast('Chat deleted');
  } catch (x) { toast(x.message, 'circle-alert'); }
}
function newChat() {
  if (S.busy) { toast('Wait for the answer to finish, or press stop', 'info'); return; }
  S.chat = null; hideWarn();
  go('chat');
  $('#prompt').focus();
}

/* ================= chat rendering ================= */
const SUGS = [
  { q: "Write a Bangla Facebook caption for my clothing page's Eid sale", ic: 'pen-line', t: 'Bangla Facebook caption', s: 'Eid sale post for a clothing page' },
  { q: 'Explain VLOOKUP in Excel in simple words', ic: 'file-text', t: 'Explain VLOOKUP', s: 'Excel, in simple words' },
  { q: 'Write a CV summary for me. BBA graduate, 2 years in sales', ic: 'user', t: 'CV summary', s: 'BBA graduate, 2 years in sales' },
  { q: "Plan a 3-day budget trip to Cox's Bazar from Dhaka", ic: 'map-pin', t: "3-day Cox's Bazar trip", s: 'Budget plan from Dhaka' },
];

function bodyHTML(a) {
  if (a.status === 'streaming' && !a.content) return '<span class="thinking">Thinking…</span>';
  const html = md(a.content);
  return a.status === 'streaming' ? withCaret(html) : html;
}
function metaHTML(a) {
  if (a.status === 'streaming') return '';
  let out = '';
  if (a.status === 'error') out += `<div class="ans-err">${ic('circle-alert')}<span>${esc(a.error || 'This model could not answer right now.')}</span></div>`;
  if (a.status === 'stopped') out += '<div class="ans-note">Stopped</div>';
  const tokens = (Number(a.prompt_tokens) || 0) + (Number(a.completion_tokens) || 0);
  const meta = a.charged ? `<span class="meta">${fmt(tokens)} tokens × ${a.mult} = <b>${fmt(a.charged)}</b> used</span>` : '<span class="meta">No tokens used</span>';
  const acts = a.content ? `<span class="acts">
      <button class="icon-btn" data-copy="${a.key}" aria-label="Copy" title="Copy">${ic('copy')}</button>
      <button class="icon-btn" data-rate="up" aria-pressed="false" aria-label="Good response" title="Good response">${ic('thumbs-up')}</button>
      <button class="icon-btn" data-rate="down" aria-pressed="false" aria-label="Bad response" title="Bad response">${ic('thumbs-down')}</button>
    </span>` : '';
  return out + meta + acts;
}
function ansHTML(a) {
  const m = modelOr(a.model_id, a.mult);
  return `<article class="ans">
    <header class="ans-h">${mk(m)}<span>${esc(m.name)}</span>${mx(a.mult || m.mult)}</header>
    <div class="ans-b md" id="b-${a.key}">${bodyHTML(a)}</div>
    <footer class="ans-f" id="f-${a.key}">${metaHTML(a)}</footer>
  </article>`;
}
function turnHTML(t) {
  const w = t.answers.length > 1;
  return `<div class="turn ${w ? 'wide' : 'single'} ${t.isNew ? 'new' : ''}">
    <div class="q">${esc(t.prompt)}</div>
    <div class="answers ${w ? 'compare' : 'single'}">${t.answers.map(ansHTML).join('')}</div>
  </div>`;
}
function renderChat() {
  const box = $('#msgs');
  const c = S.chat;
  $('#chatTitle').textContent = c && c.turns.length ? c.title : '';
  if (!c || !c.turns.length) {
    box.innerHTML = `<div class="hello">
      <h1>${greet()}.<span>What can I help you with?</span></h1>
      <div class="sugs">${SUGS.map((s, i) => `<button class="sug" data-sug="${i}"><span class="s-ic">${ic(s.ic)}</span><span>${esc(s.t)}<small>${esc(s.s)}</small></span></button>`).join('')}</div>
    </div>`;
    return;
  }
  box.innerHTML = `<div class="thread">${c.turns.map(turnHTML).join('')}</div>`;
  c.turns.forEach(t => { t.isNew = false; });
  box.querySelectorAll('.ans-b').forEach(addCodeCopy);
  const last = box.querySelector('.turn:last-child');
  if (last) { box.style.scrollBehavior = 'auto'; box.scrollTop = Math.max(0, last.offsetTop - 8); box.style.scrollBehavior = ''; }
}
const dirty = new Set(); let rafId = 0;
function paintSoon(a) {
  dirty.add(a);
  if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; dirty.forEach(x => paint(x)); dirty.clear(); });
}
function paint(a) {
  const b = document.getElementById('b-' + a.key); if (b) { b.innerHTML = bodyHTML(a); if (a.status !== 'streaming') addCodeCopy(b); }
  const f = document.getElementById('f-' + a.key); if (f) f.innerHTML = metaHTML(a);
}

/* ================= composer ================= */
const selectedIds = () => S.compare ? S.compareSel.filter(id => model(id)) : (model(S.selected) ? [S.selected] : []);
function estimate(text, ids) {
  const inTok = estTokens(text || 'question') + 40;
  let low = 0, high = 0;
  ids.forEach(id => { const m = model(id); low += (inTok + 120) * m.mult; high += (inTok + 600) * m.mult; });
  return { low: Math.round(low / 50) * 50, high: Math.round(high / 50) * 50 };
}
function updateComposer() {
  const est = $('#est'); if (!est || !S.me) return;
  const ids = selectedIds(); const text = $('#prompt').value;
  $('#left').innerHTML = `<b>${fmt(S.me.balance)}</b> tokens left`;
  if (!ids.length) est.textContent = S.compare ? 'Pick at least one model to compare' : 'No models are available right now';
  else { const e = estimate(text, ids); est.innerHTML = `This message: about <b>${short(e.low)}–${short(e.high)}</b> tokens${ids.length > 1 ? ` across ${ids.length} models` : ''}`; }
  const sb = $('#sendBtn');
  if (S.busy) {
    sb.classList.add('stop'); sb.disabled = false; sb.setAttribute('aria-label', 'Stop'); sb.title = 'Stop';
    sb.innerHTML = ic('square');
  } else {
    sb.classList.remove('stop'); sb.setAttribute('aria-label', 'Send'); sb.title = 'Send';
    sb.innerHTML = ic('arrow-up');
    sb.disabled = !text.trim() || !ids.length;
  }
}
function showWarn(html) { const w = $('#warn'); w.innerHTML = html; w.hidden = false; }
function hideWarn() { $('#warn').hidden = true; }
function autoGrow() { const ta = $('#prompt'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; }

async function send(textArg) {
  const ta = $('#prompt');
  const text = String(textArg ?? ta.value).trim();
  if (!text || S.busy) return;
  const ids = selectedIds();
  if (!ids.length) { showWarn(esc(S.compare ? 'Pick at least one model to compare.' : 'No models are available right now.')); return; }
  hideWarn();
  if (!S.chat) S.chat = { id: null, title: '', turns: [] };
  const chat = S.chat;
  const turn = { id: null, prompt: text, isNew: true, answers: ids.map(id => ({ key: newKey(), id: null, model_id: id, content: '', status: 'streaming', mult: model(id).mult })) };
  chat.turns.push(turn);
  S.busy = true;
  ta.value = ''; autoGrow();
  if (S.screen === 'chat') renderChat();
  updateComposer();

  const ctrl = new AbortController(); S.ctrl = ctrl;
  const byId = new Map();
  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chat.id, message: text, models: ids }),
      signal: ctrl.signal,
    });
  } catch {
    chat.turns.pop(); ta.value = text; autoGrow(); renderChat();
    showWarn(ctrl.signal.aborted ? 'Stopped.' : 'No connection. Check your internet and try again.');
    return finishSend();
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    chat.turns.pop(); ta.value = text; autoGrow();
    if (S.screen === 'chat') renderChat();
    finishSend();
    if (res.status === 401) return showLogin();
    if (res.status === 402) {
      showWarn(`<span>Not enough tokens for this message. You have ${fmt(S.me.balance)} left.</span><button class="btn btn-pri btn-sm" data-go="plans">Top up</button>`);
    } else showWarn(esc(j.message || 'Something went wrong. Please try again.'));
    return;
  }

  const handle = (ev, d) => {
    if (ev === 'meta') {
      chat.id = d.chatId; chat.title = d.title; turn.id = d.turnId;
      d.answers.forEach((x, k) => { if (turn.answers[k]) { turn.answers[k].id = x.id; byId.set(x.id, turn.answers[k]); } });
      const existing = S.chats.find(c => c.id === d.chatId);
      if (existing) S.chats = [existing, ...S.chats.filter(c => c !== existing)];
      else S.chats.unshift({ id: d.chatId, title: d.title });
      if (S.chat === chat && S.screen === 'chat') $('#chatTitle').textContent = chat.title;
      renderRecent();
    } else if (ev === 'delta') {
      const a = byId.get(d.a); if (!a) return;
      a.content += d.t; paintSoon(a);
    } else if (ev === 'done') {
      const a = byId.get(d.a); if (!a) return;
      Object.assign(a, { status: d.status, prompt_tokens: d.promptTokens, completion_tokens: d.completionTokens, mult: d.mult, charged: d.charged, error: d.error });
      paint(a);
      S.me.balance = d.balance; updateBalanceUI();
    } else if (ev === 'end') {
      S.me.balance = d.balance; updateBalanceUI();
    }
  };

  try {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let d; try { d = JSON.parse(data); } catch { continue; }
        handle(ev, d);
      }
    }
  } catch { /* aborted or connection dropped */ }

  turn.answers.forEach(a => {
    if (a.status !== 'streaming') return;
    if (ctrl.signal.aborted) a.status = 'stopped';
    else { a.status = 'error'; a.error = 'The connection dropped. Open this chat again to see what was saved.'; }
    paint(a);
  });
  finishSend();
  if (ctrl.signal.aborted) setTimeout(refreshMe, 2000);
}
function finishSend() { S.busy = false; S.ctrl = null; updateComposer(); }

/* ================= model picker ================= */
function renderModelBtn() {
  const b = $('#modelBtn'); const cb = $('#cmpBtn');
  if (!S.models.length) { b.innerHTML = '<span class="nm">No models</span>'; return; }
  if (S.compare) {
    const ms = selectedIds().map(model);
    b.innerHTML = `<span class="stack">${ms.map(m => mk(m)).join('')}</span><span class="nm">${ms.length ? ms.length + (ms.length > 1 ? ' models' : ' model') : 'Pick models'}</span>${ic('chevron-down')}`;
  } else {
    const m = model(S.selected) || S.models[0];
    b.innerHTML = `${mk(m)}<span class="nm">${esc(m.name)}</span>${mx(m.mult)}${ic('chevron-down')}`;
  }
  cb.setAttribute('aria-pressed', String(S.compare));
}
function renderPicker() {
  const mm = maxMult();
  const groups = [['Everyday models', 'zap', S.models.filter(m => m.mult <= 1)], ['Premium models', 'gem', S.models.filter(m => m.mult > 1)]];
  const row = m => {
    const sel = S.compare ? S.compareSel.includes(m.id) : S.selected === m.id;
    const dis = S.compare && !sel && S.compareSel.length >= 3;
    return `<button type="button" class="pk-row" role="${S.compare ? 'menuitemcheckbox' : 'menuitemradio'}" aria-checked="${sel}" data-pick="${esc(m.id)}" ${dis ? 'disabled' : ''}>
      ${mk(m, true)}<span class="pk-t"><span class="pk-n">${esc(m.name)}<span class="pk-p">${esc(m.provider)}</span></span><span class="pk-note">${esc(m.note)}</span></span>${mx(m.mult)}<span class="pk-ck">${ic('check')}</span></button>`;
  };
  $('#picker').innerHTML = `<div class="pk-h">${S.compare ? 'Compare models' : 'Choose a model'}<small>${S.compare ? `${S.compareSel.length} of 3 selected` : ''}</small></div>` +
    groups.filter(g => g[2].length).map(([t, i, list]) => `<div class="pk-g" role="group" aria-label="${t}"><div class="pk-gt">${ic(i)}${t}</div>${list.map(row).join('')}</div>`).join('') +
    `<div class="pk-f">Using 1,000 tokens on a 1× model takes 1,000 from your balance. On a ${mm}× model it takes ${fmt(1000 * mm)}.${S.compare ? ' In compare mode each model is counted separately.' : ''}</div>`;
}
function openPicker() { renderPicker(); $('#picker').hidden = false; S.pickerOpen = true; $('#modelBtn').setAttribute('aria-expanded', 'true'); }
function closePicker() { const p = $('#picker'); if (p) p.hidden = true; S.pickerOpen = false; $('#modelBtn')?.setAttribute('aria-expanded', 'false'); }
function pick(id) {
  if (S.compare) {
    const i = S.compareSel.indexOf(id);
    if (i >= 0) S.compareSel.splice(i, 1); else if (S.compareSel.length < 3) S.compareSel.push(id);
    store.set('compareSel', S.compareSel); renderPicker();
  } else { S.selected = id; store.set('model', id); closePicker(); }
  renderModelBtn(); updateComposer(); hideWarn();
}

/* ================= plans & payment ================= */
function ringSVG(size) {
  const u = S.me; const total = Math.max(u.planTotal || 0, u.balance || 0, 1);
  const pct = Math.max(0, Math.min(1, u.balance / total));
  return `<svg class="ring" viewBox="0 0 44 44" style="width:${size}px;height:${size}px" aria-hidden="true"><circle class="r-bg" cx="22" cy="22" r="18"/><circle class="r-fg ${u.balance < LOW ? 'low' : ''}" cx="22" cy="22" r="18" style="stroke-dashoffset:${113.1 * (1 - pct)}"/></svg>`;
}
async function renderPlans() {
  const page = $('#plansPage');
  if (!S.plans.length) {
    try { const p = await api('/api/plans'); S.plans = p.plans; S.topup = p.topup; S.paymentsOn = p.paymentsOn; } catch (x) { page.innerHTML = `<div class="banner bad">${ic('circle-alert')}${esc(x.message)}</div>`; return; }
  }
  const u = S.me; const mm = maxMult();
  const everyday = S.models.filter(m => m.mult <= 1), premium = S.models.filter(m => m.mult > 1);
  const chips = list => list.map(m => `<span class="chip">${mk(m)}${esc(m.name)}</span>`).join('');
  const card = x => `<article class="plan ${x.featured ? 'feat' : ''}">
    <div class="plan-top"><h3>${esc(x.name)}</h3>${x.featured ? '<span class="rec">Recommended</span>' : ''}</div>
    <p class="plan-tag">${esc(x.tagline)}</p>
    <div class="price"><b>${tk(x.price)}</b><span>/ ${x.days} days</span></div>
    <ul class="feats">
      <li>${ic('check')}<span><b>${short(x.tokens)} tokens</b> to use on any model</span></li>
      <li>${ic('check')}<span>About ${short(x.tokens)} on everyday models</span></li>
      <li>${ic('check')}<span>About ${short(x.tokens / mm)} on premium models</span></li>
      <li>${ic('check')}<span>Compare up to 3 models side by side</span></li>
    </ul>
    <button class="btn ${x.featured ? 'btn-acc' : 'btn-out'} btn-block" data-buy="${esc(x.id)}" ${S.paymentsOn ? '' : 'disabled'}>Get ${esc(x.name)}</button>
  </article>`;
  const cur = u.active
    ? `<div class="panel curplan">${ringSVG(56)}
        <div class="cp-kv"><span>Current plan</span><b>${esc(planName(u.planId) || 'Active')}</b></div>
        <div class="cp-kv"><span>Tokens left</span><b>${fmt(u.balance)}</b></div>
        <div class="cp-kv"><span>Valid until</span><b>${fDateY(u.expiresAt)}</b></div></div>`
    : `<div class="banner warn">${ic('info')}You don't have an active plan. Pick one below to start chatting.</div>`;
  const tp = S.topup;
  page.innerHTML = `
    <div class="pg-h"><h1>Plans &amp; top-up</h1><p class="lead">Every plan gives you a pool of tokens for all models. Premium models use more tokens per message, so you always know what you're spending.</p></div>
    ${S.paymentsOn ? '' : `<div class="banner bad">${ic('circle-alert')}Payments are paused right now. Please try again later.</div>`}
    ${cur}
    <div class="plans">${S.plans.map(card).join('')}</div>
    ${tp ? `<div class="panel topup">
      <div class="topup-l"><span class="t-ic">${ic('coins')}</span><div><h3>Need a few more tokens?</h3><p>Top up ${short(tp.tokens)} tokens for ${tk(tp.price)}. ${u.active ? 'They last until your current plan ends.' : 'Top-ups need an active plan.'}</p></div></div>
      <button class="btn btn-out" data-buy="topup" ${S.paymentsOn && u.active ? '' : 'disabled'}>Top up ${tk(tp.price)}</button>
    </div>` : ''}
    <section>
      <div class="sec-h"><h2>How tokens are counted</h2></div>
      <div class="how">
        <div class="panel"><div class="how-h"><b>Everyday models</b>${mx(1)}</div><div class="how-big">1,000<span>tokens used per 1,000</span></div><div class="how-models">${chips(everyday)}</div></div>
        <div class="panel"><div class="how-h"><b>Premium models</b>${mx(mm)}</div><div class="how-big">${fmt(1000 * mm)}<span>tokens used per 1,000</span></div><div class="how-models">${chips(premium)}</div></div>
      </div>
      <p class="note">A token is a small piece of text. Your message, the reply, and earlier messages in the same chat all count. In English, 1,000 tokens is roughly 750 words. Bangla uses more tokens per word. Starting a new chat for a new topic saves tokens.</p>
    </section>
    <section>
      <div class="sec-h"><h2>Questions</h2></div>
      <div class="faq">
        <details><summary>Do my tokens expire?${ic('chevron-down')}</summary><p>Plan tokens are valid for the number of days shown on the plan. If you buy a new plan before then, your remaining tokens carry over and the new validity starts that day.</p></details>
        <details><summary>How do I pay?${ic('chevron-down')}</summary><p>You pay in Taka through EPS, which supports mobile wallets and cards. Tokens are added as soon as the payment is confirmed.</p></details>
        <details><summary>Can I use any model on any plan?${ic('chevron-down')}</summary><p>Yes. Every plan includes every model. Premium models simply use more tokens per message.</p></details>
        <details><summary>What happens when I run out?${ic('chevron-down')}</summary><p>You can top up or buy a new plan at any time. Your chats stay saved.</p></details>
      </div>
    </section>`;
}

let payItem = null;
function openPay(id) {
  const it = id === 'topup' ? { id, name: 'Top-up', price: S.topup.price, tokens: S.topup.tokens, kind: 'topup' } : { ...S.plans.find(p => p.id === id), kind: 'plan' };
  if (!it || !it.price) return;
  payItem = it;
  $('#payCard').innerHTML = `
    <div class="mh"><div class="mh-l"><span class="t-ic">${ic('lock')}</span><h2 id="payT">Checkout<small>Secure payment with EPS</small></h2></div><button class="icon-btn" data-payclose aria-label="Close">${ic('x')}</button></div>
    <div class="sum">
      <div class="kv"><span>Item</span><b>${it.kind === 'plan' ? esc(it.name) + ' plan' : 'Top-up'}</b></div>
      <div class="kv"><span>Tokens</span><b>${fmt(it.tokens)}</b></div>
      <div class="kv"><span>Valid for</span><b>${it.kind === 'plan' ? it.days + ' days' : 'Until your plan ends'}</b></div>
      <div class="kv"><span>Account</span><b>${fPhone(S.me.phone)}</b></div>
      <div class="kv total"><span>Total</span><b>${tk(it.price)}</b></div>
    </div>
    ${it.kind === 'plan' && S.me.active ? '<p class="fine">Your remaining tokens carry over, and the new validity starts today.</p>' : ''}
    <button class="btn btn-acc btn-lg btn-block" id="payGo" data-paygo>${ic('lock')}Pay ${tk(it.price)} with EPS</button>
    <p class="err" id="payErr" hidden></p>
    <p class="fine center">You'll finish the payment on the EPS page, then come back here automatically. <a class="link" href="/refund" target="_blank" rel="noopener">Refund policy</a></p>`;
  $('#pay').hidden = false;
  $('#payGo').focus();
}
function closePay() { $('#pay').hidden = true; payItem = null; }
async function startPay() {
  if (!payItem) return;
  const btn = $('#payGo'); btn.disabled = true; btn.textContent = 'Opening EPS…';
  try {
    const r = await api('/api/pay/init', { method: 'POST', body: { item: payItem.id } });
    location.href = r.url;
  } catch (x) {
    btn.disabled = false; btn.innerHTML = `${ic('lock')}Pay ${tk(payItem.price)} with EPS`;
    const e = $('#payErr'); e.textContent = x.message; e.hidden = false;
  }
}

/* ================= usage ================= */
async function renderUsage() {
  const page = $('#usagePage');
  page.innerHTML = '<div class="empty-box"><div class="spin" style="margin:0 auto"></div></div>';
  let d;
  try { d = await api('/api/usage'); } catch (x) { page.innerHTML = `<div class="banner bad">${ic('circle-alert')}${esc(x.message)}</div>`; return; }
  S.me = d.user; updateBalanceUI();
  const u = d.user; const total = Math.max(u.planTotal || 0, u.balance || 0);
  const used = Math.max(0, total - u.balance);
  const days = u.expiresAt ? Math.max(0, Math.ceil((new Date(u.expiresAt) - Date.now()) / 864e5)) : 0;
  const statusLabel = { paid: 'Paid', pending: 'Pending', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired' };
  page.innerHTML = `
    <div class="pg-h"><h1>Usage</h1><p class="lead">Every message, the model that answered it, and how many tokens it used.</p></div>
    <div class="tiles">
      <div class="panel tile"><span class="t-l">${ic('coins')}Tokens left</span><span class="t-v">${fmt(u.balance)}</span><span class="t-s">of ${fmt(total)}</span></div>
      <div class="panel tile"><span class="t-l">${ic('trending-up')}Used this period</span><span class="t-v">${fmt(used)}</span><span class="t-s">${u.active ? esc(planName(u.planId) || 'Active') + ' plan' : 'No active plan'}</span></div>
      <div class="panel tile"><span class="t-l">${ic('credit-card')}Days left</span><span class="t-v">${u.active ? days : 0}</span><span class="t-s">${u.active ? 'Valid until ' + fDateY(u.expiresAt) : 'Buy a plan to start'}</span></div>
    </div>
    <section><div class="sec-h"><h2>Messages</h2><small>Latest ${d.usage.length}</small></div>
      <div class="panel tbl">${d.usage.length ? `<table>
        <thead><tr><th>Time</th><th>Model</th><th class="num">Tokens</th><th class="num">Rate</th><th class="num">Used from balance</th></tr></thead>
        <tbody>${d.usage.map(r => { const m = modelOr(r.model_id, r.mult); const mm2 = { ...m, name: r.model_name || m.name, color: r.color || m.color, provider: r.provider || m.provider, logo: r.logo_url || m.logo }; return `<tr><td>${fDT(r.created_at)}</td><td><span class="cm">${mk(mm2)}${esc(mm2.name)}</span></td><td class="num">${fmt(r.tokens)}</td><td class="num">${mx(r.mult)}</td><td class="num"><b>${fmt(r.charged)}</b></td></tr>`; }).join('')}</tbody>
      </table>` : '<div class="empty-box">No messages yet.</div>'}</div>
    </section>
    <section><div class="sec-h"><h2>Payments</h2></div>
      <div class="panel tbl">${d.payments.length ? `<table>
        <thead><tr><th>Date</th><th>Item</th><th class="num">Amount</th><th>Transaction</th><th>Status</th></tr></thead>
        <tbody>${d.payments.map(p => `<tr><td>${fDateY(p.paid_at || p.created_at)}</td><td>${p.kind === 'plan' ? esc(planName(p.plan_id) || p.plan_id) + ' plan' : 'Top-up'}</td><td class="num">${tk(p.amount)}</td><td><span class="mono">${esc(p.eps_txn || p.mtid)}</span></td><td><span class="st ${esc(p.status)}">${statusLabel[p.status] || esc(p.status)}</span></td></tr>`).join('')}</tbody>
      </table>` : '<div class="empty-box">No payments yet.</div>'}</div>
    </section>`;
}

/* ================= events ================= */
document.addEventListener('click', e => {
  const el = e.target;
  if (S.pickerOpen && !el.closest('#picker') && !el.closest('#modelBtn') && !el.closest('#cmpBtn')) closePicker();
  if (el.id === 'pay') { closePay(); return; }
  const b = el.closest('[data-go],[data-pick],[data-chat],[data-del],[data-new],[data-side-toggle],[data-logout],[data-sug],[data-buy],[data-copy],[data-rate],[data-paygo],[data-payclose]');
  if (!b || b.disabled) return;
  const d = b.dataset;
  if ('payclose' in d) { closePay(); return; }
  if ('paygo' in d) { startPay(); return; }
  if (d.go) { go(d.go); return; }
  if (d.pick) { pick(d.pick); return; }
  if (d.chat) { openChat(Number(d.chat)); return; }
  if (d.del) { deleteChat(Number(d.del)); return; }
  if ('new' in d) { newChat(); return; }
  if ('sideToggle' in d) { toggleSide(); return; }
  if ('logout' in d) { logout(); return; }
  if (d.sug !== undefined) { send(SUGS[Number(d.sug)].q); return; }
  if (d.buy) { openPay(d.buy); return; }
  if (d.copy) {
    let a; S.chat?.turns.forEach(t => t.answers.forEach(x => { if (x.key === d.copy) a = x; }));
    if (a) copyText(a.content, document.getElementById('b-' + a.key));
    return;
  }
  if (d.rate) {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.parentElement.querySelectorAll('[data-rate]').forEach(x => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', String(on));
    if (on) toast('Thanks for the feedback');
  }
});
$('#modelBtn').addEventListener('click', () => (S.pickerOpen ? closePicker() : openPicker()));
$('#cmpBtn').addEventListener('click', () => {
  S.compare = !S.compare; store.set('compare', S.compare);
  if (S.compare && !S.compareSel.length && S.selected) { S.compareSel = [S.selected]; store.set('compareSel', S.compareSel); }
  renderModelBtn(); if (S.pickerOpen) renderPicker(); else if (S.compare) openPicker();
  updateComposer(); hideWarn();
});
$('#scrim').addEventListener('click', closeDrawer);
$('#fSend').addEventListener('submit', e => { e.preventDefault(); if (S.busy) { S.ctrl?.abort(); return; } send(); });
$('#prompt').addEventListener('input', () => { autoGrow(); updateComposer(); });
$('#prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover:hover)').matches) { e.preventDefault(); if (!S.busy) send(); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#pay').hidden) closePay(); else if (S.pickerOpen) closePicker(); else closeDrawer();
});
window.addEventListener('pageshow', e => { if (e.persisted && S.me) refreshMe(); });
window.addEventListener('hashchange', () => {
  if (!S.me) return;
  const h = location.hash.replace('#', '');
  const to = ['plans', 'usage'].includes(h) ? h : 'chat';
  if (to !== S.screen) go(to, { keepHash: true });
});

boot();
})();
