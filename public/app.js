// Chatt – klientlogik: inloggning, chattar, filer, röstmeddelanden, inställningar och samtal (WebRTC).
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  me: null,
  config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  current: null,        // användarnamn i öppen chatt
  currentUser: null,    // profil för öppen chatt
  messages: new Map(),  // id -> meddelande i öppen chatt
  hasMore: false,
  loadingOlder: false,
  replyTo: null,
  editing: null,
  socket: null,
  pendingEmail: null,
  lastTypingSent: 0,
  typingTimer: null,
};

// ================= Hjälpfunktioner =================
async function api(path, { body, method, raw, headers } = {}) {
  const res = await fetch(path, {
    method: method || (body || raw ? 'POST' : 'GET'),
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...headers },
    body: raw || (body && JSON.stringify(body)),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || 'Något gick fel');
    Object.assign(err, data, { status: res.status });
    throw err;
  }
  return data;
}

function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

const COLORS = ['#f2c14e', '#6cc59a', '#7fb3e0', '#e39b7b', '#c7a3e0', '#e0c27f', '#8fd1c7'];
function avatar(user, size = 40) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.style.width = el.style.height = size + 'px';
  el.style.fontSize = Math.round(size * 0.4) + 'px';
  if (user?.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '';
    el.appendChild(img);
  } else {
    const name = user?.displayName || user?.username || '?';
    let h = 0;
    for (const ch of user?.username || name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    el.style.background = COLORS[h % COLORS.length];
    el.textContent = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  }
  return el;
}
function setAvatar(slot, user, size) {
  const el = $(slot);
  el.replaceChildren(avatar(user, size));
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}
function fmtShort(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(iso);
  const diff = (now - d) / 864e5;
  if (diff < 6) return d.toLocaleDateString('sv-SE', { weekday: 'short' });
  return d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
}
function fmtDay(iso) {
  const d = new Date(iso), now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Idag';
  if (d.toDateString() === yesterday.toDateString()) return 'Igår';
  return d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' kB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function formError(form, msg) { form.querySelector('.error').textContent = msg || ''; }
function formSaved(form, msg) {
  const el = form.querySelector('.saved');
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
}

// ================= Inloggning =================
function showAuth(view) {
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  for (const id of ['login-form', 'register-form', 'verify-form']) {
    $(id).classList.toggle('hidden', id !== view + '-form');
    formError($(id));
  }
  const first = $(view + '-form').querySelector('input');
  first?.focus();
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => showAuth(b.dataset.go)));

function needVerification(email) {
  state.pendingEmail = email;
  $('verify-email').textContent = email;
  $('verify-form').reset();
  showAuth('verify');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  formError(f);
  try {
    const data = await api('/api/login', { body: { login: f.login.value, password: f.password.value } });
    f.reset();
    start(data.user);
  } catch (err) {
    if (err.needsVerification) return needVerification(err.email);
    formError(f, err.message);
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  formError(f);
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const data = await api('/api/register', {
      body: { email: f.email.value, displayName: f.displayName.value, username: f.username.value, password: f.password.value },
    });
    f.reset();
    needVerification(data.email);
  } catch (err) { formError(f, err.message); }
  btn.disabled = false;
});

$('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  formError(f);
  try {
    const data = await api('/api/verify', { body: { email: state.pendingEmail, code: f.code.value } });
    start(data.user);
  } catch (err) { formError(f, err.message); }
});
$('verify-form').code.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) $('verify-form').requestSubmit();
});
$('resend').addEventListener('click', async () => {
  try {
    await api('/api/resend', { body: { email: state.pendingEmail } });
    toast('En ny kod har skickats');
  } catch (err) { formError($('verify-form'), err.message); }
});

async function logout() {
  try { await api('/api/logout', { body: {} }); } catch {}
  location.reload();
}
$('logout').addEventListener('click', logout);

// ================= Start =================
async function start(user) {
  state.me = user;
  renderMe();
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  try { state.config = await api('/api/config'); } catch {}
  loadConvos();
  connect();
}

function renderMe() {
  setAvatar('me-avatar', state.me, 42);
  $('me-name').textContent = state.me.displayName;
  $('me-user').textContent = '@' + state.me.username;
}

// ================= WebSocket =================
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/`);
  state.socket = ws;
  ws.onopen = () => {
    if (connect.wasDown) { toast('Ansluten igen'); if (state.current) openChat(state.current, true); loadConvos(); }
    connect.wasDown = false;
  };
  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    (wsHandlers[d.type] || (() => {}))(d);
  };
  ws.onclose = (e) => {
    if (e.code === 4001) return logout();
    connect.wasDown = true;
    setTimeout(connect, 2000);
  };
}
function wsSend(payload) {
  if (state.socket?.readyState === 1) { state.socket.send(JSON.stringify(payload)); return true; }
  toast('Ingen anslutning till servern just nu');
  return false;
}

const wsHandlers = {
  message({ message: m }) {
    const other = m.sender === state.me.username ? m.recipient : m.sender;
    if (other === state.current) {
      addMessage(m, true);
      if (m.sender !== state.me.username) { markRead(); stopTypingIndicator(); }
    }
    refreshConvosSoon();
  },
  update({ message: m }) {
    if (state.messages.has(m.id)) {
      state.messages.set(m.id, m);
      const old = document.querySelector(`.msg[data-id="${m.id}"]`);
      old?.replaceWith(renderMessage(m));
    }
    refreshConvosSoon();
  },
  read({ by }) {
    if (by !== state.current) return;
    for (const m of state.messages.values()) {
      if (m.sender === state.me.username && !m.read) {
        m.read = true;
        const t = document.querySelector(`.msg[data-id="${m.id}"] .ticks`);
        if (t) { t.textContent = '✓✓'; t.classList.add('read'); }
      }
    }
  },
  'read-self'() { refreshConvosSoon(); },
  typing({ from }) {
    if (from !== state.current) return;
    const s = $('chat-status');
    s.textContent = 'skriver…';
    s.classList.add('typing');
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTypingIndicator, 3500);
  },
  'call-offer': (d) => Call.onOffer(d),
  'call-answer': (d) => Call.onAnswer(d),
  ice: (d) => Call.onIce(d),
  'call-end': (d) => Call.onRemoteEnd(d, 'Samtalet avslutades'),
  'call-reject': (d) => Call.onRemoteEnd(d, 'Samtalet avvisades'),
  'call-busy': (d) => Call.onRemoteEnd(d, 'Upptaget – personen är i ett annat samtal'),
  'call-unavailable': (d) => Call.onRemoteEnd(d, d.reason === 'privacy'
    ? 'Personen tar inte emot samtal från dig' : 'Personen är inte online just nu'),
  'call-handled': (d) => Call.onHandledElsewhere(d),
};

function stopTypingIndicator() {
  const s = $('chat-status');
  s.classList.remove('typing');
  s.textContent = state.currentUser ? '@' + state.currentUser.username : '';
}

// ================= Chattlista och sök =================
function userRow(u, { preview, time, unread } = {}) {
  const b = document.createElement('button');
  b.className = 'row' + (u.username === state.current ? ' active' : '');
  const info = document.createElement('div');
  info.className = 'info';
  info.innerHTML = '<div class="top"><span class="name"></span><small></small></div><div class="bottom"><span class="preview"></span></div>';
  info.querySelector('.name').textContent = u.displayName;
  info.querySelector('small').textContent = time ? fmtShort(time) : '';
  info.querySelector('.preview').textContent = preview ?? '@' + u.username;
  if (unread) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = unread > 99 ? '99+' : unread;
    info.querySelector('.bottom').appendChild(badge);
  }
  b.append(avatar(u, 46), info);
  b.addEventListener('click', () => openChat(u.username));
  return b;
}

async function loadConvos() {
  let list;
  try { list = await api('/api/conversations'); } catch { return; }
  const box = $('convos');
  box.innerHTML = '<h2>Chattar</h2>';
  if (!list.length) box.insertAdjacentHTML('beforeend', '<p class="hint">Inga chattar än. Sök efter någons användarnamn ovan.</p>');
  let unreadTotal = 0;
  for (const c of list) {
    unreadTotal += c.unread;
    const prefix = c.lastMine ? 'Du: ' : '';
    box.appendChild(userRow(c, { preview: prefix + (c.lastText || ''), time: c.lastTime, unread: c.username === state.current ? 0 : c.unread }));
  }
  document.title = unreadTotal ? `(${unreadTotal}) Chatt` : 'Chatt';
}
function refreshConvosSoon() {
  clearTimeout(refreshConvosSoon.t);
  refreshConvosSoon.t = setTimeout(loadConvos, 250);
}

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const term = $('search').value.trim();
    const box = $('results');
    if (!term) { box.classList.add('hidden'); return; }
    let users = [];
    try { users = await api('/api/search?q=' + encodeURIComponent(term)); } catch {}
    box.innerHTML = '<h2>Sökresultat</h2>';
    if (!users.length) box.insertAdjacentHTML('beforeend', '<p class="hint">Ingen användare hittades.</p>');
    users.forEach((u) => box.appendChild(userRow(u)));
    box.classList.remove('hidden');
  }, 250);
});

// ================= Öppen chatt =================
async function openChat(username, keepScroll = false) {
  let data;
  try { data = await api('/api/messages/' + username); } catch (err) { return toast(err.message); }
  const switching = state.current !== username;
  state.current = username;
  state.currentUser = data.user;
  state.messages.clear();
  state.hasMore = data.hasMore;
  if (switching) { cancelReply(); cancelEdit(); }

  setAvatar('chat-avatar', data.user, 40);
  $('chat-name').textContent = data.user.displayName;
  stopTypingIndicator();
  $('call-audio').classList.remove('hidden');
  $('call-video').classList.remove('hidden');
  $('composer-wrap').classList.remove('hidden');

  const box = $('messages');
  box.innerHTML = '';
  if (!data.messages.length) box.innerHTML = '<p class="empty">Inga meddelanden än. Säg hej!</p>';
  data.messages.forEach((m) => addMessage(m, false));
  if (!keepScroll) box.scrollTop = box.scrollHeight;

  $('app').classList.add('chatting');
  $('search').value = '';
  $('results').classList.add('hidden');
  markRead();
  loadConvos();
  if (switching && matchMedia('(min-width: 761px)').matches) $('text').focus();
}

function markRead() {
  if (state.current && document.visibilityState === 'visible') wsSend({ type: 'read', peer: state.current });
}
document.addEventListener('visibilitychange', markRead);

$('messages').addEventListener('scroll', async () => {
  const box = $('messages');
  if (box.scrollTop > 60 || !state.hasMore || state.loadingOlder || !state.current) return;
  state.loadingOlder = true;
  const oldest = Math.min(...state.messages.keys());
  try {
    const data = await api(`/api/messages/${state.current}?before=${oldest}`);
    const prevHeight = box.scrollHeight;
    const frag = document.createDocumentFragment();
    let lastDay = null;
    for (const m of data.messages) {
      state.messages.set(m.id, m);
      const day = new Date(m.time).toDateString();
      if (day !== lastDay) { frag.appendChild(dayLabel(m.time)); lastDay = day; }
      frag.appendChild(renderMessage(m));
    }
    // Ta bort den första dagsetiketten om samma dag fortsätter.
    const firstDay = box.querySelector('.day');
    if (firstDay && lastDay === new Date(firstDay.dataset.time).toDateString()) firstDay.remove();
    box.prepend(frag);
    box.scrollTop = box.scrollHeight - prevHeight;
    state.hasMore = data.hasMore;
  } catch {}
  state.loadingOlder = false;
});

function dayLabel(iso) {
  const d = document.createElement('div');
  d.className = 'day';
  d.dataset.time = iso;
  d.textContent = fmtDay(iso);
  return d;
}

function addMessage(m, animate) {
  const box = $('messages');
  box.querySelector('.empty')?.remove();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const last = [...state.messages.values()].at(-1);
  if (!last || new Date(last.time).toDateString() !== new Date(m.time).toDateString()) box.appendChild(dayLabel(m.time));
  state.messages.set(m.id, m);
  box.appendChild(renderMessage(m));
  if (animate && (nearBottom || m.sender === state.me.username)) box.scrollTop = box.scrollHeight;
}

function renderMessage(m) {
  const mine = m.sender === state.me.username;
  const el = document.createElement('div');
  el.className = 'msg' + (mine ? ' mine' : '') + (m.deleted ? ' deleted' : '');
  el.dataset.id = m.id;

  if (m.replyTo && !m.deleted) {
    const q = document.createElement('div');
    q.className = 'quote';
    const who = document.createElement('strong');
    who.textContent = m.replyTo.sender === state.me.username ? 'Du' : (state.currentUser?.displayName || m.replyTo.sender);
    const t = document.createElement('span');
    t.textContent = m.replyTo.preview || '';
    q.append(who, t);
    q.addEventListener('click', (e) => { e.stopPropagation(); jumpTo(m.replyTo.id); });
    el.appendChild(q);
  }

  if (m.file && !m.deleted) {
    if (m.kind === 'image') {
      const a = document.createElement('a');
      a.href = m.file.url; a.target = '_blank'; a.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'photo'; img.src = m.file.url; img.alt = m.file.name; img.loading = 'lazy';
      img.addEventListener('load', () => {
        const box = $('messages');
        if (box.scrollHeight - box.scrollTop - box.clientHeight < img.height + 150) box.scrollTop = box.scrollHeight;
      });
      a.appendChild(img);
      a.addEventListener('click', (e) => e.stopPropagation());
      el.appendChild(a);
    } else if (m.kind === 'voice') {
      const audio = document.createElement('audio');
      audio.controls = true; audio.preload = 'metadata'; audio.src = m.file.url;
      audio.addEventListener('click', (e) => e.stopPropagation());
      el.appendChild(audio);
    } else {
      const a = document.createElement('a');
      a.className = 'file'; a.href = m.file.url; a.download = m.file.name;
      a.innerHTML = '<span class="ic">📄</span><span><span class="fn"></span><small></small></span>';
      a.querySelector('.fn').textContent = m.file.name;
      a.querySelector('small').textContent = fmtSize(m.file.size);
      a.addEventListener('click', (e) => e.stopPropagation());
      el.appendChild(a);
    }
  }

  if (m.deleted || m.text) {
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.deleted ? 'Meddelandet raderades' : m.text;
    el.appendChild(body);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (m.edited && !m.deleted) meta.append('redigerad · ');
  meta.append(fmtTime(m.time));
  if (mine && !m.deleted) {
    const ticks = document.createElement('span');
    ticks.className = 'ticks' + (m.read ? ' read' : '');
    ticks.textContent = m.read ? '✓✓' : '✓';
    ticks.title = m.read ? 'Läst' : 'Skickat';
    meta.prepend(ticks);
  }
  el.appendChild(meta);

  if (!m.deleted) el.addEventListener('click', (e) => openMsgMenu(e, m));
  return el;
}

function jumpTo(id) {
  const el = document.querySelector(`.msg[data-id="${id}"]`);
  if (!el) return toast('Meddelandet finns längre upp i historiken');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// ================= Meddelandemeny =================
let menuMsg = null;
function placeMenu(menu, x, y) {
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
function closeMenus() { $('main-menu').classList.add('hidden'); $('msg-menu').classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu') && !e.target.closest('#menu-btn') && !e.target.closest('.msg')) closeMenus(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMenus();
  document.querySelectorAll('.overlay:not(.hidden)').forEach((o) => o.classList.add('hidden'));
  if (state.editing) cancelEdit();
  else if (state.replyTo) cancelReply();
});

function openMsgMenu(e, m) {
  if (window.getSelection()?.toString()) return;
  closeMenus();
  menuMsg = m;
  const mine = m.sender === state.me.username;
  const menu = $('msg-menu');
  menu.querySelector('[data-act=edit]').classList.toggle('hidden', !mine || !m.text);
  menu.querySelector('[data-act=delete]').classList.toggle('hidden', !mine);
  menu.querySelector('[data-act=copy]').classList.toggle('hidden', !m.text);
  placeMenu(menu, e.clientX, e.clientY);
}
$('msg-menu').addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.act;
  const m = menuMsg;
  closeMenus();
  if (!act || !m) return;
  if (act === 'reply') startReply(m);
  if (act === 'copy') { try { await navigator.clipboard.writeText(m.text); toast('Kopierat'); } catch { toast('Kunde inte kopiera'); } }
  if (act === 'edit') startEdit(m);
  if (act === 'delete' && confirm('Radera meddelandet för båda?')) wsSend({ type: 'delete', id: m.id });
});

function msgPreview(m) {
  if (m.kind === 'image') return '📷 Bild' + (m.text ? ': ' + m.text : '');
  if (m.kind === 'voice') return '🎤 Röstmeddelande';
  if (m.kind === 'file') return '📎 ' + (m.file?.name || 'Fil');
  return m.text;
}
function startReply(m) {
  cancelEdit();
  state.replyTo = m;
  $('reply-title').textContent = 'Svar till ' + (m.sender === state.me.username ? 'dig själv' : state.currentUser.displayName);
  $('reply-text').textContent = msgPreview(m);
  $('reply-bar').classList.remove('hidden');
  $('text').focus();
}
function cancelReply() { state.replyTo = null; $('reply-bar').classList.add('hidden'); }
function startEdit(m) {
  cancelReply();
  state.editing = m;
  $('reply-title').textContent = 'Redigerar';
  $('reply-text').textContent = m.text;
  $('reply-bar').classList.remove('hidden');
  $('text').value = m.text;
  autosize(); updateComposerButtons();
  $('text').focus();
}
function cancelEdit() {
  if (!state.editing) return;
  state.editing = null;
  $('reply-bar').classList.add('hidden');
  $('text').value = '';
  autosize(); updateComposerButtons();
}
$('reply-cancel').addEventListener('click', () => { if (state.editing) cancelEdit(); else cancelReply(); });

// ================= Skrivfält =================
const textEl = $('text');
function autosize() {
  textEl.style.height = 'auto';
  textEl.style.height = Math.min(textEl.scrollHeight + 2, 140) + 'px';
}
function updateComposerButtons() {
  const hasText = textEl.value.trim().length > 0;
  $('send-btn').classList.toggle('hidden', !hasText && !state.editing);
  $('mic').classList.toggle('hidden', hasText || !!state.editing);
}
textEl.addEventListener('input', () => {
  autosize(); updateComposerButtons();
  if (state.current && Date.now() - state.lastTypingSent > 2500 && textEl.value) {
    state.lastTypingSent = Date.now();
    wsSend({ type: 'typing', to: state.current });
  }
});
textEl.addEventListener('keydown', (e) => {
  const desktop = matchMedia('(pointer: fine)').matches;
  if (e.key === 'Enter' && !e.shiftKey && desktop) { e.preventDefault(); $('composer').requestSubmit(); }
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textEl.value.trim();
  if (state.editing) {
    if (text && text !== state.editing.text) wsSend({ type: 'edit', id: state.editing.id, text });
    cancelEdit();
    return;
  }
  if (!text || !state.current) return;
  if (wsSend({ type: 'send', to: state.current, text, replyTo: state.replyTo?.id })) {
    textEl.value = '';
    state.lastTypingSent = 0;
    cancelReply();
    autosize(); updateComposerButtons();
  }
});

// ---------- Bifoga filer ----------
$('attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) await sendFile(file);
});
document.addEventListener('paste', (e) => {
  if (!state.current) return;
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) { e.preventDefault(); sendFile(file); }
});

async function uploadFile(blob, name) {
  return api('/api/upload', {
    raw: blob,
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
  });
}
async function sendFile(file, kind) {
  if (file.size > 25 * 1024 * 1024) return toast('Filen är för stor (max 25 MB)');
  kind = kind || (/^image\/(png|jpeg|gif|webp)$/.test(file.type) ? 'image' : 'file');
  const to = state.current;
  toast('Laddar upp…', 60000);
  try {
    const f = await uploadFile(file, file.name || 'fil');
    const caption = kind === 'image' ? textEl.value.trim() : '';
    wsSend({ type: 'send', to, kind, fileId: f.id, text: caption, replyTo: state.replyTo?.id });
    if (caption) { textEl.value = ''; autosize(); updateComposerButtons(); }
    cancelReply();
    $('toast').classList.add('hidden');
  } catch (err) { toast(err.message); }
}

// ---------- Röstmeddelanden ----------
const rec = { recorder: null, chunks: [], stream: null, timer: null, started: 0, cancelled: false };
function pickAudioType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return '';
}
function setRecordingUi(on) {
  $('recording').classList.toggle('hidden', !on);
  $('rec-cancel').classList.toggle('hidden', !on);
  textEl.classList.toggle('hidden', on);
  $('attach').classList.toggle('hidden', on);
  $('mic').classList.toggle('hidden', on);
  $('send-btn').classList.toggle('hidden', !on);
  if (!on) updateComposerButtons();
}
$('mic').addEventListener('click', async () => {
  if (!window.MediaRecorder) return toast('Din webbläsare kan inte spela in ljud');
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { return toast('Ingen åtkomst till mikrofonen'); }
  const type = pickAudioType();
  rec.recorder = new MediaRecorder(rec.stream, type ? { mimeType: type } : undefined);
  rec.chunks = [];
  rec.cancelled = false;
  rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = async () => {
    rec.stream.getTracks().forEach((t) => t.stop());
    clearInterval(rec.timer);
    setRecordingUi(false);
    if (rec.cancelled || Date.now() - rec.started < 700) return;
    const mime = (rec.recorder.mimeType || 'audio/webm').split(';')[0];
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    const blob = new Blob(rec.chunks, { type: mime });
    await sendFile(new File([blob], `rostmeddelande.${ext}`, { type: mime }), 'voice');
  };
  rec.recorder.start();
  rec.started = Date.now();
  $('rec-time').textContent = '0:00';
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.started) / 1000);
    $('rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 300) rec.recorder.stop();
  }, 250);
  setRecordingUi(true);
});
$('send-btn').addEventListener('click', (e) => {
  if (rec.recorder?.state === 'recording') { e.preventDefault(); rec.recorder.stop(); }
});
$('rec-cancel').addEventListener('click', () => {
  if (rec.recorder?.state === 'recording') { rec.cancelled = true; rec.recorder.stop(); }
});

// ================= Navigering =================
$('back').addEventListener('click', () => {
  $('app').classList.remove('chatting');
  state.current = null;
  state.currentUser = null;
  $('call-audio').classList.add('hidden');
  $('call-video').classList.add('hidden');
  $('composer-wrap').classList.add('hidden');
  loadConvos();
});

$('chat-who').addEventListener('click', () => {
  const u = state.currentUser;
  if (!u) return;
  const card = $('profile-card');
  card.replaceChildren(avatar(u, 110));
  const h = document.createElement('h3'); h.textContent = u.displayName;
  const un = document.createElement('div'); un.className = 'muted'; un.textContent = '@' + u.username;
  card.append(h, un);
  if (u.bio) { const p = document.createElement('p'); p.textContent = u.bio; p.style.margin = '8px 0 0'; card.appendChild(p); }
  $('profile-view').classList.remove('hidden');
});

// ================= Meny och inställningar =================
$('menu-btn').addEventListener('click', (e) => {
  const menu = $('main-menu');
  if (!menu.classList.contains('hidden')) return closeMenus();
  closeMenus();
  const r = e.currentTarget.getBoundingClientRect();
  placeMenu(menu, r.right - 200, r.bottom + 6);
});
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { closeMenus(); openSettings(b.dataset.open); }));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('.overlay').classList.add('hidden')));
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) o.classList.add('hidden'); }));
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
}
function openSettings(tab) {
  const me = state.me;
  const pf = $('profile-form');
  pf.displayName.value = me.displayName;
  pf.bio.value = me.bio || '';
  pf.username.value = '@' + me.username;
  pf.email.value = me.email;
  setAvatar('profile-avatar', me, 84);
  const pr = $('privacy-form');
  pr.searchable.checked = me.settings.searchable;
  pr.readReceipts.checked = me.settings.readReceipts;
  pr.callsFrom.value = me.settings.callsFrom;
  $('password-form').reset();
  formError($('password-form'));
  showTab(tab);
  $('settings').classList.remove('hidden');
}
function applyMe(user) {
  state.me = user;
  renderMe();
  setAvatar('profile-avatar', user, 84);
}

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    applyMe(await api('/api/me', { body: { displayName: e.target.displayName.value, bio: e.target.bio.value } }));
    formSaved(e.target, 'Sparat');
  } catch (err) { toast(err.message); }
});
$('privacy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    applyMe(await api('/api/me', { body: { settings: { searchable: f.searchable.checked, readReceipts: f.readReceipts.checked, callsFrom: f.callsFrom.value } } }));
    formSaved(f, 'Sparat');
  } catch (err) { toast(err.message); }
});
$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  formError(f);
  try {
    await api('/api/me/password', { body: { current: f.current.value, next: f.next.value } });
    f.reset();
    formSaved(f, 'Lösenordet är bytt');
  } catch (err) { formError(f, err.message); }
});

$('avatar-change').addEventListener('click', () => $('avatar-input').click());
$('avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const small = await shrinkImage(file, 512);
    applyMe(await api('/api/me/avatar', { raw: small, headers: { 'Content-Type': small.type, 'X-Filename': 'avatar' } }));
    formSaved($('profile-form'), 'Profilbilden är uppdaterad');
    loadConvos();
  } catch (err) { toast(err.message); }
});
$('avatar-remove').addEventListener('click', async () => {
  try { applyMe(await api('/api/me/avatar', { method: 'DELETE' })); } catch (err) { toast(err.message); }
});

// Förminska och beskär profilbilden till en kvadrat innan uppladdning.
function shrinkImage(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = Math.min(size, s);
      canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Kunde inte läsa bilden'))), 'image/jpeg', 0.88);
    };
    img.onerror = () => reject(new Error('Kunde inte läsa bilden'));
    img.src = URL.createObjectURL(file);
  });
}

// ================= Samtal (WebRTC) =================
const Call = {
  c: null,         // pågående samtal
  incoming: null,  // inkommande erbjudande som väntar på svar
  ringTimer: null,
  durationTimer: null,
  tone: null,

  ui(mode, user, status) {
    $('call').classList.remove('hidden');
    setAvatar('call-avatar', user, 120);
    $('call-name').textContent = user.displayName;
    $('call-status').textContent = status;
    $('call-incoming').classList.toggle('hidden', mode !== 'incoming');
    $('call-active').classList.toggle('hidden', mode === 'incoming');
  },

  async getMedia(video) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { facingMode: 'user', width: { ideal: 1280 } } : false });
    } catch {
      if (video) {
        toast('Ingen åtkomst till kameran – ringer utan video');
        try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
      }
      throw new Error('Ingen åtkomst till mikrofonen. Tillåt mikrofon i webbläsaren.');
    }
  },

  makePeer(c) {
    const pc = new RTCPeerConnection({ iceServers: state.config.iceServers });
    pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: 'ice', to: c.peer.username, callId: c.id, candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      $('remote-audio').srcObject = stream;
      $('remote-video').srcObject = stream;
      const hasVideo = () => stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
      const refresh = () => this.setVideoMode(hasVideo() || !!c.localVideo);
      e.track.onunmute = refresh; e.track.onmute = refresh; e.track.onended = refresh;
      refresh();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected' && !c.connectedAt) {
        c.connectedAt = Date.now();
        clearTimeout(this.ringTimer);
        this.stopTone();
        this.durationTimer = setInterval(() => {
          const s = Math.floor((Date.now() - c.connectedAt) / 1000);
          $('call-status').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }, 500);
      }
      if (pc.connectionState === 'failed') { toast('Anslutningen misslyckades. Nätverket kan blockera samtal (se README om TURN).'); this.hangup(); }
    };
    return pc;
  },

  setVideoMode(on) {
    $('call').classList.toggle('video-on', on);
    const remoteHasVideo = $('remote-video').srcObject?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
    $('remote-video').classList.toggle('hidden', !remoteHasVideo);
  },

  showLocal(stream) {
    const hasVideo = stream.getVideoTracks().length > 0;
    $('local-video').srcObject = stream;
    $('local-video').classList.toggle('hidden', !hasVideo);
    $('call-cam').classList.toggle('hidden', !hasVideo);
    $('call-mute').classList.remove('off');
    $('call-cam').classList.remove('off');
    this.setVideoMode(hasVideo);
  },

  async start(video) {
    if (this.c || this.incoming) return toast('Du är redan i ett samtal');
    const peer = state.currentUser;
    if (!peer) return;
    const c = { id: crypto.randomUUID(), peer, role: 'caller', pendingIce: [] };
    this.c = c;
    this.ui('outgoing', peer, video ? 'Videosamtal – ringer…' : 'Ringer…');
    try {
      c.local = await this.getMedia(video);
    } catch (err) { this.cleanup(); return toast(err.message); }
    if (this.c !== c) { c.local.getTracks().forEach((t) => t.stop()); return; }
    c.localVideo = c.local.getVideoTracks().length > 0;
    this.showLocal(c.local);
    c.pc = this.makePeer(c);
    c.local.getTracks().forEach((t) => c.pc.addTrack(t, c.local));
    const offer = await c.pc.createOffer();
    await c.pc.setLocalDescription(offer);
    wsSend({ type: 'call-offer', to: peer.username, callId: c.id, sdp: offer.sdp, video: c.localVideo });
    this.playTone('outgoing');
    this.ringTimer = setTimeout(() => { if (this.c === c && !c.connectedAt) { toast('Inget svar'); this.hangup(); } }, 45000);
  },

  onOffer(d) {
    if (this.c || this.incoming) return wsSend({ type: 'call-busy', to: d.from, callId: d.callId });
    this.incoming = { ...d, pendingIce: [] };
    this.ui('incoming', d.caller, d.video ? 'Inkommande videosamtal' : 'Inkommande samtal');
    $('local-video').classList.add('hidden');
    $('remote-video').classList.add('hidden');
    $('call').classList.remove('video-on');
    this.playTone('incoming');
    navigator.vibrate?.([400, 200, 400, 200, 400]);
    this.ringTimer = setTimeout(() => { if (this.incoming?.callId === d.callId) this.reject(); }, 45000);
  },

  async accept() {
    const inc = this.incoming;
    if (!inc) return;
    this.stopTone();
    clearTimeout(this.ringTimer);
    const c = { id: inc.callId, peer: inc.caller, role: 'callee', pendingIce: inc.pendingIce };
    this.incoming = null;
    this.c = c;
    this.ui('active', c.peer, 'Ansluter…');
    try {
      c.local = await this.getMedia(inc.video);
    } catch (err) {
      wsSend({ type: 'call-reject', to: c.peer.username, callId: c.id });
      this.cleanup(); return toast(err.message);
    }
    c.localVideo = c.local.getVideoTracks().length > 0;
    this.showLocal(c.local);
    c.pc = this.makePeer(c);
    await c.pc.setRemoteDescription({ type: 'offer', sdp: inc.sdp });
    c.local.getTracks().forEach((t) => c.pc.addTrack(t, c.local));
    const answer = await c.pc.createAnswer();
    await c.pc.setLocalDescription(answer);
    wsSend({ type: 'call-answer', to: c.peer.username, callId: c.id, sdp: answer.sdp });
    await this.flushIce(c);
  },

  reject() {
    const inc = this.incoming;
    if (!inc) return;
    wsSend({ type: 'call-reject', to: inc.from, callId: inc.callId });
    this.incoming = null;
    this.cleanup();
  },

  async onAnswer(d) {
    const c = this.c;
    if (!c || c.id !== d.callId || c.role !== 'caller') return;
    this.stopTone();
    $('call-status').textContent = 'Ansluter…';
    await c.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    await this.flushIce(c);
  },

  async onIce(d) {
    const target = this.c?.id === d.callId ? this.c : this.incoming?.callId === d.callId ? this.incoming : null;
    if (!target) return;
    if (target.pc?.remoteDescription) {
      try { await target.pc.addIceCandidate(d.candidate); } catch {}
    } else target.pendingIce.push(d.candidate);
  },

  async flushIce(c) {
    for (const cand of c.pendingIce.splice(0)) { try { await c.pc.addIceCandidate(cand); } catch {} }
  },

  onRemoteEnd(d, message) {
    const matches = this.c?.id === d.callId || this.incoming?.callId === d.callId;
    if (!matches) return;
    this.incoming = null;
    this.cleanup();
    toast(message);
  },

  onHandledElsewhere(d) {
    if (this.incoming?.callId === d.callId) { this.incoming = null; this.cleanup(); toast('Samtalet besvarades på en annan enhet'); }
  },

  hangup() {
    if (this.c) wsSend({ type: 'call-end', to: this.c.peer.username, callId: this.c.id });
    this.cleanup();
  },

  cleanup() {
    const c = this.c;
    this.c = null;
    clearTimeout(this.ringTimer);
    clearInterval(this.durationTimer);
    this.stopTone();
    if (c) {
      c.local?.getTracks().forEach((t) => t.stop());
      try { c.pc?.close(); } catch {}
    }
    for (const id of ['remote-video', 'local-video', 'remote-audio']) $(id).srcObject = null;
    $('call').classList.add('hidden');
    $('call').classList.remove('video-on');
  },

  toggleMute() {
    const t = this.c?.local?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    $('call-mute').classList.toggle('off', !t.enabled);
  },
  toggleCam() {
    const t = this.c?.local?.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    $('call-cam').classList.toggle('off', !t.enabled);
    $('local-video').classList.toggle('hidden', !t.enabled);
  },

  // Enkel ringsignal genererad i webbläsaren.
  playTone(kind) {
    this.stopTone();
    try {
      const ctx = new AudioContext();
      const beep = () => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = kind === 'incoming' ? 660 : 440;
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
        o.connect(g).connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 1);
      };
      beep();
      this.tone = { ctx, interval: setInterval(beep, kind === 'incoming' ? 2000 : 3000) };
    } catch {}
  },
  stopTone() {
    if (!this.tone) return;
    clearInterval(this.tone.interval);
    this.tone.ctx.close().catch(() => {});
    this.tone = null;
  },
};

$('call-audio').addEventListener('click', () => Call.start(false));
$('call-video').addEventListener('click', () => Call.start(true));
$('call-accept').addEventListener('click', () => Call.accept());
$('call-reject').addEventListener('click', () => Call.reject());
$('call-hangup').addEventListener('click', () => Call.hangup());
$('call-mute').addEventListener('click', () => Call.toggleMute());
$('call-cam').addEventListener('click', () => Call.toggleCam());
window.addEventListener('beforeunload', () => { if (Call.c) Call.hangup(); });

// ================= Uppstart =================
api('/api/me').then(start).catch(() => showAuth('login'));
