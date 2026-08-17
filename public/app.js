'use strict';

/* ================= tiny helpers ================= */

const $ = (s) => document.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const DAY = 86400000;
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - DAY);
  if (dayKey(ts) === dayKey(today.getTime())) return 'Today';
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function fmtListTime(ts) {
  const d = new Date(ts);
  if (dayKey(ts) === dayKey(Date.now())) return fmtTime(ts);
  if (dayKey(ts) === dayKey(Date.now() - DAY)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? 'POST' : 'GET') };
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) init.body = opts.body;
    else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function staticSvg(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

const DOC_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
const DL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

/* ================= state ================= */

const state = {
  me: null,
  users: new Map(),        // userId -> user
  last: new Map(),         // convKey -> { senderId, senderName, preview, createdAt }
  unread: new Map(),       // convKey -> count
  active: null,            // 'general' | 'dm:<id>'
  messages: new Map(),     // convKey -> [msg ascending]
  loadedAll: new Set(),
  loadingOlder: false,
  online: new Set(),
  pending: [],             // [{ file, name, size, thumbUrl }]
  sending: false,
  typing: new Map(),       // convKey -> Map(userId -> expiresAt)
  ws: null,
  wsRetry: 0,
  lastTypingSent: 0,
};

const PAGE = 50;
const GROUP_WINDOW = 5 * 60 * 1000;
const dropOverlay = document.getElementById('drop-overlay');

/* ================= boot & auth ================= */

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#field-display').classList.toggle('hidden', mode === 'login');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#f-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('#auth-error').classList.add('hidden');
}

async function submitAuth(e) {
  e.preventDefault();
  const btn = $('#auth-submit');
  const errBox = $('#auth-error');
  btn.disabled = true;
  try {
    const payload = {
      username: $('#f-username').value.trim(),
      password: $('#f-password').value,
    };
    if (authMode === 'register') payload.displayName = $('#f-display').value.trim();
    const d = await api(`/api/auth/${authMode}`, { body: payload });
    enterChat(d.user);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

/* ================= enter chat ================= */

function enterChat(user) {
  state.me = user;
  $('#boot').classList.add('hidden');
  $('#auth-screen').classList.add('hidden');
  $('#chat-screen').classList.remove('hidden');
  $('#me-avatar').textContent = initials(user.displayName);
  $('#me-avatar').style.background = user.color;
  $('#me-name').textContent = user.displayName;
  $('#me-username').textContent = '@' + user.username;
  refreshSidebar().catch((e) => toast(e.message));
  openConversation('general');
  connectWs();
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

/* ================= sidebar ================= */

async function refreshSidebar() {
  const d = await api('/api/sidebar');
  state.users = new Map(d.users.map((u) => [u.id, u]));
  state.last = new Map();
  state.unread = new Map();
  if (d.general.last) state.last.set('general', d.general.last);
  state.unread.set('general', d.general.unread);
  for (const dm of d.dms) {
    const key = `dm:${dm.user.id}`;
    if (dm.last) state.last.set(key, dm.last);
    if (dm.unread) state.unread.set(key, dm.unread);
  }
  renderSidebar();
  renderHeader();
}

function sortedEntries() {
  const dms = [...state.users.values()].map((u) => ({ key: `dm:${u.id}`, user: u }));
  dms.sort((a, b) => {
    const la = state.last.get(a.key)?.createdAt || 0;
    const lb = state.last.get(b.key)?.createdAt || 0;
    if (la !== lb) return lb - la;
    return a.user.displayName.localeCompare(b.user.displayName);
  });
  return [{ key: 'general' }, ...dms];
}

function renderSidebar() {
  const list = $('#conv-list');
  list.innerHTML = '';
  const q = $('#user-search').value.trim().toLowerCase();
  const entries = sortedEntries();
  let generalRendered = false;

  for (const entry of entries) {
    if (entry.key === 'general') {
      list.append(renderConvItem(entry, q === '' || 'general'.includes(q)));
      generalRendered = true;
      continue;
    }
    if (generalRendered) {
      list.append(el('div', { class: 'section-label', text: 'People' }));
      generalRendered = false;
    }
    const u = entry.user;
    const hay = `${u.displayName} ${u.username}`.toLowerCase();
    list.append(renderConvItem(entry, q === '' || hay.includes(q)));
  }
}

function renderConvItem(entry, visible) {
  const key = entry.key;
  const isGeneral = key === 'general';
  const user = entry.user;
  const name = isGeneral ? 'General' : user.displayName;
  const unread = state.unread.get(key) || 0;
  const last = state.last.get(key);

  const avatar = el('div', { class: `avatar${isGeneral ? ' general' : ''}`, style: isGeneral ? '' : `background:${user.color}` },
    isGeneral ? '#' : initials(name));
  if (!isGeneral && state.online.has(user.id)) avatar.append(el('span', { class: 'online-dot' }));

  const preview = last
    ? `${state.me && last.senderId === state.me.id ? 'You: ' : isGeneral ? last.senderName.split(' ')[0] + ': ' : ''}${last.preview}`
    : isGeneral ? 'Everyone on this network' : 'No messages yet';

  const item = el('button', {
    class: `conv-item${state.active === key ? ' active' : ''}`,
    style: visible ? '' : 'display:none',
    onclick: () => openConversation(key),
  },
    avatar,
    el('div', { class: 'conv-mid' },
      el('div', { class: 'conv-name', text: name }),
      el('div', { class: `conv-preview${unread ? ' unread' : ''}`, text: preview })
    ),
    el('div', { class: 'conv-right' },
      last ? el('span', { class: 'conv-time', text: fmtListTime(last.createdAt) }) : null,
      unread ? el('span', { class: 'unread-badge', text: unread > 99 ? '99+' : String(unread) }) : null
    )
  );
  return item;
}

/* ================= conversation & messages ================= */

function dmUserOf(key) {
  const m = /^dm:(\d+)$/.exec(key || '');
  return m ? state.users.get(Number(m[1])) : null;
}

async function openConversation(key) {
  state.active = key;
  state.typing.delete(key);
  renderTyping();
  renderHeader();
  renderSidebar();
  closeMobileSidebar();
  markReadIfFocused();

  if (!state.messages.has(key)) {
    $('#messages').innerHTML = '';
    $('#messages').append(el('div', { class: 'empty-state' }, el('div', { class: 'spinner' })));
    try {
      await loadMessages(key);
    } catch (e) {
      toast(e.message);
      return;
    }
  }
  renderMessages();
  scrollBottom(true);
  $('#msg-input').focus();
}

async function loadMessages(key) {
  const d = await api(`/api/messages?conv=${encodeURIComponent(key)}&limit=${PAGE}`);
  state.messages.set(key, d.messages);
  if (d.messages.length < PAGE) state.loadedAll.add(key);
}

async function loadOlder() {
  const key = state.active;
  const arr = state.messages.get(key);
  if (!arr || !arr.length || state.loadedAll.has(key) || state.loadingOlder) return;
  state.loadingOlder = true;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  try {
    const d = await api(`/api/messages?conv=${encodeURIComponent(key)}&before=${arr[0].id}&limit=${PAGE}`);
    if (d.messages.length < PAGE) state.loadedAll.add(key);
    if (d.messages.length) {
      const ids = new Set(arr.map((m) => m.id));
      const merged = [...d.messages.filter((m) => !ids.has(m.id)), ...arr];
      state.messages.set(key, merged);
      renderMessages();
      box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    }
  } catch (e) {
    toast(e.message);
  } finally {
    state.loadingOlder = false;
  }
}

function renderMessages() {
  const key = state.active;
  const arr = state.messages.get(key) || [];
  const box = $('#messages');
  box.innerHTML = '';
  box.append(dropOverlay);
  if (!arr.length) {
    const other = dmUserOf(key);
    box.append(el('div', { class: 'empty-state' },
      el('div', { text: key === 'general' ? 'No messages yet — say hi to everyone!' : `This is the beginning of your conversation with ${other ? other.displayName : 'them'}` })
    ));
    return;
  }
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of arr) {
    frag.append(...messageBits(m, prev));
    prev = m;
  }
  box.append(frag);
}

function messageBits(m, prev) {
  const bits = [];
  if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) {
    bits.push(el('div', { class: 'day-divider' }, el('span', { text: fmtDay(m.createdAt) })));
  }
  bits.push(messageEl(m, prev));
  return bits;
}

function messageEl(m, prev) {
  const mine = m.sender.id === state.me.id;
  const grouped = !!(prev && prev.sender.id === m.sender.id && dayKey(prev.createdAt) === dayKey(m.createdAt) && m.createdAt - prev.createdAt < GROUP_WINDOW);

  const row = el('div', { class: `m-row${mine ? ' mine' : 'theirs'}${grouped ? ' grouped' : ''}`, dataset: { id: m.id } });

  if (!mine) row.append(grouped ? el('div', { class: 'spacer' }) : avatarEl(m.sender));

  const bubble = el('div', { class: 'bubble' });
  if (!mine && !grouped) bubble.append(el('div', { class: 'sender-name', text: m.sender.displayName, style: `color:${m.sender.color}` }));

  if (m.body) {
    const body = el('div', { class: 'm-body' });
    for (const line of m.body.split('\n')) body.append(el('div', { class: 'b-line', text: line || '\u200b' }));
    bubble.append(body);
  }

  if (m.attachments?.length) {
    bubble.append(el('div', { class: 'attachments' }, m.attachments.map(attachmentEl)));
  }

  bubble.append(el('span', { class: 'm-meta', text: fmtTime(m.createdAt) }));
  row.append(bubble);
  return row;
}

function avatarEl(user) {
  return el('div', { class: 'avatar', style: `background:${user.color}`, text: initials(user.displayName) });
}

function attachmentEl(a) {
  if (a.kind === 'image') {
    return el('img', { class: 'att-img', src: a.url, alt: a.name, loading: 'lazy', onclick: () => openLightbox(a) });
  }
  if (a.kind === 'video') {
    return el('video', { class: 'att-video', src: a.url, controls: true, preload: 'metadata', playsinline: true });
  }
  if (a.kind === 'audio') {
    return el('audio', { class: 'att-audio', src: a.url, controls: true, preload: 'metadata' });
  }
  return el('a', { class: 'file-card', href: a.download },
    el('span', { class: 'fc-icon' }, staticSvg(DOC_ICON)),
    el('div', { class: 'fc-mid' },
      el('div', { class: 'fc-name', text: a.name }),
      el('div', { class: 'fc-size', text: fmtSize(a.size) })
    ),
    el('span', { class: 'fc-dl' }, staticSvg(DL_ICON))
  );
}

function nearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 180;
}
function scrollBottom(force) {
  const box = $('#messages');
  if (force) box.scrollTop = box.scrollHeight;
}

function addMessage(m) {
  const key = m.conv;
  let arr = state.messages.get(key);
  if (!arr) {
    arr = [];
    state.messages.set(key, arr);
  }
  if (arr.some((x) => x.id === m.id)) return;
  const wasNearBottom = key === state.active && nearBottom();

  // clear typing indicator from this sender
  state.typing.get(key)?.delete(m.sender.id);

  arr.push(m);
  arr.sort((a, b) => a.id - b.id);

  state.last.set(key, { senderId: m.sender.id, senderName: m.sender.displayName, preview: previewOf(m), createdAt: m.createdAt });

  if (key === state.active) {
    const box = $('#messages');
    box.querySelector('.empty-state')?.remove();
    if (arr[arr.length - 1].id !== m.id) renderMessages();
    else {
      box.append(...messageBits(m, arr[arr.length - 2]));
    }
    if (wasNearBottom || m.sender.id === state.me.id) scrollBottom(true);
    if ((document.hasFocus() && !document.hidden) || m.sender.id === state.me.id) markReadIfFocused();
  } else if (m.sender.id !== state.me.id) {
    state.unread.set(key, (state.unread.get(key) || 0) + 1);
  }
  renderSidebar();
  renderTyping();
  updateTitle();
}

function previewOf(m) {
  if (m.body && m.body.trim()) {
    const line = m.body.trim().split('\n')[0];
    return line.length > 60 ? line.slice(0, 59) + '…' : line;
  }
  const atts = m.attachments || [];
  if (atts.length > 1) return `${atts.length} attachments`;
  if (atts.length === 1) {
    if (atts[0].kind === 'image') return 'Photo';
    if (atts[0].kind === 'video') return 'Video';
    if (atts[0].kind === 'audio') return 'Audio';
    return atts[0].name;
  }
  return '';
}

/* ================= header / typing / unread ================= */

function renderHeader() {
  const key = state.active;
  if (!key) return;
  const title = $('#chat-title');
  const sub = $('#chat-sub');
  const avatar = $('#chat-avatar');
  if (key === 'general') {
    title.textContent = 'General';
    sub.textContent = 'Everyone on this network';
    sub.className = 'chat-sub';
    avatar.classList.add('hidden');
  } else {
    const u = dmUserOf(key);
    if (!u) return;
    title.textContent = u.displayName;
    const online = state.online.has(u.id);
    sub.textContent = online ? 'Online' : 'Offline';
    sub.className = `chat-sub${online ? ' online' : ''}`;
    sub.prepend(el('span', { class: 'status-dot' }));
    avatar.textContent = initials(u.displayName);
    avatar.style.background = u.color;
    avatar.classList.remove('hidden');
  }
}

function renderTyping() {
  const bar = $('#typing-bar');
  const key = state.active;
  const t = state.typing.get(key);
  const now = Date.now();
  const names = [];
  if (t) {
    for (const [uid, exp] of t) {
      if (exp > now) {
        const u = state.users.get(uid);
        names.push(u ? u.displayName : 'Someone');
      } else {
        t.delete(uid);
      }
    }
  }
  if (!names.length) {
    bar.textContent = '';
    return;
  }
  const label = names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'Several people are typing';
  bar.textContent = '';
  bar.append(el('span', { class: 'dots', text: label }));
}

function markReadIfFocused() {
  const key = state.active;
  if (!key || !document.hasFocus() || document.hidden) return;
  if (state.unread.get(key)) {
    state.unread.delete(key);
    renderSidebar();
    updateTitle();
  }
  api('/api/read', { body: { conv: key } }).catch(() => {});
}

function updateTitle() {
  let total = 0;
  for (const n of state.unread.values()) total += n;
  document.title = total ? `(${total}) LAN Chat` : 'LAN Chat';
}

/* ================= sending ================= */

function setSendEnabled() {
  $('#btn-send').disabled = state.sending || (!$('#msg-input').value.trim() && !state.pending.length);
}

function sendMessage(e) {
  e.preventDefault();
  if (state.sending) return;
  const input = $('#msg-input');
  const body = input.value.trim();
  if (!body && !state.pending.length) return;
  if (state.pending.length > 10) return toast('Max 10 files per message');

  const fd = new FormData();
  fd.append('to', state.active);
  fd.append('body', body);
  for (const p of state.pending) fd.append('files', p.file, p.name);

  state.sending = true;
  setSendEnabled();
  const btn = $('#btn-send');
  btn.classList.add('uploading');
  $('#progress-wrap').classList.remove('hidden');
  $('#progress-bar').style.width = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/messages');
  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) $('#progress-bar').style.width = `${Math.round((ev.loaded / ev.total) * 100)}%`;
  };
  xhr.onload = () => {
    state.sending = false;
    $('#progress-wrap').classList.add('hidden');
    $('#progress-bar').style.width = '0%';
    let d = null;
    try { d = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300 && d?.message) {
      input.value = '';
      input.style.height = 'auto';
      clearPending();
      addMessage(d.message);
    } else {
      toast(d?.error || `Send failed (${xhr.status})`);
    }
    setSendEnabled();
    input.focus();
  };
  xhr.onerror = () => {
    state.sending = false;
    $('#progress-wrap').classList.add('hidden');
    toast('Network error');
    setSendEnabled();
  };
  xhr.send(fd);
}

/* ================= pending attachments ================= */

function addPendingFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  for (const file of files) {
    if (state.pending.length >= 10) {
      toast('Max 10 files per message');
      break;
    }
    state.pending.push({
      file,
      name: file.name || 'file',
      size: file.size,
      thumbUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    });
  }
  renderAttachStrip();
  setSendEnabled();
}

function removePending(i) {
  const p = state.pending[i];
  if (p?.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  state.pending.splice(i, 1);
  renderAttachStrip();
  setSendEnabled();
}

function clearPending() {
  for (const p of state.pending) if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  state.pending = [];
  renderAttachStrip();
}

function renderAttachStrip() {
  const strip = $('#attach-strip');
  strip.innerHTML = '';
  state.pending.forEach((p, i) => {
    strip.append(el('div', { class: 'attach-chip' },
      p.thumbUrl ? el('img', { src: p.thumbUrl, alt: '' }) : el('span', { class: 'chip-icon' }, staticSvg(DOC_ICON)),
      el('div', {},
        el('div', { class: 'chip-name', text: p.name }),
        el('div', { class: 'chip-size', text: fmtSize(p.size) })
      ),
      el('button', { class: 'chip-remove', type: 'button', title: 'Remove', onclick: () => removePending(i) }, staticSvg(X_ICON))
    ));
  });
}

/* ================= websocket ================= */

function connectWs() {
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    const wasRetry = state.wsRetry > 0;
    state.wsRetry = 0;
    if (wasRetry) catchUpAfterReconnect();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'hello') {
      state.online = new Set(msg.online);
      renderSidebar();
      renderHeader();
    } else if (msg.type === 'presence') {
      if (msg.online) state.online.add(msg.userId);
      else state.online.delete(msg.userId);
      renderSidebar();
      renderHeader();
    } else if (msg.type === 'message') {
      addMessage(msg.message);
    } else if (msg.type === 'typing') {
      if (msg.conv !== state.active) return;
      let t = state.typing.get(msg.conv);
      if (!t) {
        t = new Map();
        state.typing.set(msg.conv, t);
      }
      t.set(msg.from, Date.now() + 3500);
      renderTyping();
    }
  };
  ws.onclose = (e) => {
    if (e.code === 4001) {
      location.reload(); // session gone / logged out elsewhere
      return;
    }
    const delay = Math.min(1000 * 2 ** state.wsRetry, 10000);
    state.wsRetry++;
    setTimeout(connectWs, delay);
  };
  ws.onerror = () => {};
}

async function catchUpAfterReconnect() {
  try {
    await refreshSidebar();
    const key = state.active;
    if (key && state.messages.has(key)) {
      const d = await api(`/api/messages?conv=${encodeURIComponent(key)}&limit=${PAGE}`);
      const existing = state.messages.get(key);
      const ids = new Set(existing.map((m) => m.id));
      const merged = [...existing, ...d.messages.filter((m) => !ids.has(m.id))];
      merged.sort((a, b) => a.id - b.id);
      state.messages.set(key, merged);
      renderMessages();
      if (nearBottom()) scrollBottom(true);
    }
  } catch {}
}

function sendTyping() {
  const now = Date.now();
  if (!state.ws || state.ws.readyState !== 1 || now - state.lastTypingSent < 1800) return;
  state.lastTypingSent = now;
  try {
    state.ws.send(JSON.stringify({ type: 'typing', conv: state.active }));
  } catch {}
}

/* ================= lightbox ================= */

function openLightbox(att) {
  $('#lb-img').src = att.url;
  $('#lb-img').alt = att.name;
  $('#lb-dl').href = att.download;
  $('#lb-dl').setAttribute('download', att.name);
  $('#lightbox').classList.remove('hidden');
}
function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lb-img').src = '';
}

/* ================= mobile sidebar ================= */

function closeMobileSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('show');
}

/* ================= wire up ================= */

function init() {
  $('#tab-login').addEventListener('click', () => setAuthMode('login'));
  $('#tab-register').addEventListener('click', () => setAuthMode('register'));
  $('#auth-form').addEventListener('submit', submitAuth);

  $('#btn-logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { body: {} }); } catch {}
    location.reload();
  });

  $('#composer').addEventListener('submit', sendMessage);

  const input = $('#msg-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
    setSendEnabled();
    sendTyping();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(e);
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addPendingFiles(files);
    }
  });

  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    addPendingFiles(e.target.files);
    e.target.value = '';
  });

  $('#user-search').addEventListener('input', renderSidebar);

  // scroll up to load history
  $('#messages').addEventListener('scroll', () => {
    if ($('#messages').scrollTop <= 40) loadOlder();
  });

  // drag & drop
  let dragDepth = 0;
  const main = $('#main-area');
  main.addEventListener('dragenter', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      dragDepth++;
      $('#drop-overlay').classList.remove('hidden');
    }
  });
  main.addEventListener('dragover', (e) => e.preventDefault());
  main.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('#drop-overlay').classList.add('hidden');
    }
  });
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').classList.add('hidden');
    if (e.dataTransfer?.files?.length) addPendingFiles(e.dataTransfer.files);
  });

  // typing expiry loop
  setInterval(() => {
    const t = state.typing.get(state.active);
    if (t && [...t.values()].some((exp) => exp <= Date.now())) renderTyping();
  }, 1000);

  // read on focus
  window.addEventListener('focus', markReadIfFocused);

  // lightbox
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  $('#lb-close').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });

  // mobile sidebar
  $('#btn-sidebar').addEventListener('click', () => {
    $('#sidebar').classList.add('open');
    $('#sidebar-backdrop').classList.add('show');
  });
  $('#sidebar-backdrop').addEventListener('click', closeMobileSidebar);

  // boot
  api('/api/me')
    .then((d) => enterChat(d.user))
    .catch(() => {
      $('#boot').classList.add('hidden');
      $('#auth-screen').classList.remove('hidden');
      $('#f-username').focus();
    });
}

init();
