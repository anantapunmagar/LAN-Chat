'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const db = require('./db');
const {
  COOKIE_NAME,
  parseCookies,
  hashPassword,
  verifyPassword,
  hashToken,
  publicUser,
  attachUser,
  requireAuth,
  issueSession,
  clearSessionCookie,
} = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILES = 10;
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB per file
const MAX_BODY_LEN = 4000;
const AVATAR_COLORS = [
  '#f43f5e', '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899',
];

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(attachUser);
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- upload storage ---------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: db.UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 16).replace(/[^.a-zA-Z0-9]/g, '');
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE },
});

/* ---------------- helpers ---------------- */

function attachmentKind(mime) {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  return 'file';
}

function messageJson(row, forUserId) {
  const conv =
    row.convType === 'general'
      ? 'general'
      : `dm:${forUserId === row.userA ? row.userB : row.userA}`;
  return {
    id: row.id,
    conv,
    sender: { id: row.senderId, displayName: row.displayName, color: row.color },
    body: row.body,
    createdAt: row.createdAt,
    attachments: (row.attachments || []).map((a) => ({
      id: a.id,
      name: a.originalName,
      mime: a.mime,
      size: a.size,
      kind: attachmentKind(a.mime),
      url: `/files/${a.storedName}`,
      download: `/files/${a.storedName}?dl=1`,
    })),
  };
}

// conv: 'general' | 'dm:<userId>' -> { id, type, userA, userB, other } or null
function resolveConv(user, convStr, create) {
  if (convStr === 'general') return { id: 1, type: 'general' };
  const m = /^dm:(\d+)$/.exec(String(convStr || ''));
  if (!m) return null;
  const other = Number(m[1]);
  if (!Number.isInteger(other) || other === user.id) return null;
  if (!db.getUserById(other)) return null;
  const dm = create ? db.findOrCreateDm(user.id, other) : db.findDm(user.id, other);
  if (!dm) return null;
  return { id: dm.id, type: 'dm', userA: dm.userA, userB: dm.userB, other };
}

function previewOf(last) {
  if (!last) return null;
  if (last.body && last.body.trim()) {
    const line = last.body.trim().split('\n')[0];
    return line.length > 60 ? line.slice(0, 59) + '…' : line;
  }
  if (last.attCount > 1) return `${last.attCount} attachments`;
  if (last.attName) {
    const kind = attachmentKind(last.attMime);
    if (kind === 'image') return 'Photo';
    if (kind === 'video') return 'Video';
    if (kind === 'audio') return 'Audio';
    return last.attName;
  }
  return '';
}

/* ---------------- auth routes ---------------- */

const loginFails = new Map(); // key -> { count, until }

app.post('/api/auth/register', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const displayName = String(body.displayName || '').trim().slice(0, 48);
  const password = String(body.password || '');

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–32 characters (letters, numbers, . _ -)' });
  }
  if (password.length < 6 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be 6–200 characters' });
  }
  const user = db.createUser({
    username,
    displayName: displayName || username,
    passwordHash: hashPassword(password),
    color: AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)],
  });
  if (!user) return res.status(409).json({ error: 'Username is already taken' });
  issueSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const key = `${req.ip}|${username.toLowerCase()}`;
  const now = Date.now();
  const fail = loginFails.get(key);

  if (fail && fail.count >= 15 && fail.until > now) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const user = db.getUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const f = loginFails.get(key);
    if (f && f.until > now) f.count += 1;
    else loginFails.set(key, { count: 1, until: now + 10 * 60 * 1000 });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  loginFails.delete(key);
  issueSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    db.deleteSession(hashToken(token));
    if (req.user) closeUserSockets(req.user.id);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ---------------- data routes ---------------- */

app.get('/api/sidebar', requireAuth, (req, res) => {
  const uid = req.user.id;
  const users = db.listUsers(uid);
  const dmRows = db.getDmRows(uid);
  const convIds = [1, ...dmRows.map((d) => d.id)];
  const lasts = db.getLastMessages(convIds);
  const unread = db.unreadCounts(uid);

  const dmConvByUser = new Map();
  for (const d of dmRows) dmConvByUser.set(d.userA === uid ? d.userB : d.userA, d.id);

  const generalLast = lasts.get(1);
  res.json({
    users,
    general: {
      unread: unread.get(1) || 0,
      last: generalLast
        ? { senderId: generalLast.senderId, senderName: generalLast.senderName, preview: previewOf(generalLast), createdAt: generalLast.createdAt }
        : null,
    },
    dms: users.map((u) => {
      const convId = dmConvByUser.get(u.id);
      const last = convId && lasts.get(convId);
      return {
        user: u,
        unread: convId ? unread.get(convId) || 0 : 0,
        last: last
          ? { senderId: last.senderId, senderName: last.senderName, preview: previewOf(last), createdAt: last.createdAt }
          : null,
      };
    }),
  });
});

app.get('/api/messages', requireAuth, (req, res) => {
  const conv = resolveConv(req.user, String(req.query.conv || ''), false);
  if (!conv) return res.status(400).json({ error: 'Invalid conversation' });
  if (conv.type === 'dm' && !conv.id) return res.json({ messages: [] });
  const before = Number(req.query.before) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const rows = db.getMessages(conv.id, before, limit);
  res.json({ messages: rows.map((r) => messageJson(r, req.user.id)) });
});

app.post('/api/messages', requireAuth, upload.array('files', MAX_FILES), (req, res) => {
  const conv = resolveConv(req.user, String(req.body.to || ''), true);
  if (!conv) {
    // clean up any files multer already wrote for this rejected request
    for (const f of req.files || []) fsUnlink(f.path);
    return res.status(400).json({ error: 'Invalid recipient' });
  }
  const body = String(req.body.body || '').trim().slice(0, MAX_BODY_LEN);
  const files = req.files || [];
  if (!body && !files.length) return res.status(400).json({ error: 'Message is empty' });

  const mid = db.createMessage(conv.id, req.user.id, body);
  for (const f of files) {
    db.addAttachment(mid, f.filename, f.originalname, f.mimetype || 'application/octet-stream', f.size);
  }

  const row = db.getMessage(mid);
  broadcastMessage(conv, row);
  res.json({ message: messageJson(row, req.user.id) });
});

app.post('/api/read', requireAuth, (req, res) => {
  const conv = resolveConv(req.user, String(req.body?.conv || ''), false);
  if (conv?.id) db.markRead(req.user.id, conv.id);
  res.json({ ok: true });
});

app.get('/files/:name', requireAuth, (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[a-f0-9]{32}(\.[a-zA-Z0-9]{1,16})?$/.test(name)) return res.status(404).json({ error: 'Not found' });
  const att = db.getAttachmentByStored(name);
  if (!att) return res.status(404).json({ error: 'Not found' });

  const asDownload = 'dl' in req.query;
  const asciiFallback = att.originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', att.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // keep hosted HTML/SVG uploads from running scripts if opened directly
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader(
    'Content-Disposition',
    `${asDownload ? 'attachment' : 'inline'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(att.originalName)}`
  );
  res.sendFile(path.join(db.UPLOADS_DIR, att.storedName));
});

function fsUnlink(p) {
  try {
    require('node:fs').unlinkSync(p);
  } catch {}
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/files', (_req, res) => res.status(404).json({ error: 'Not found' }));

/* ---------------- error handler ---------------- */

app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  let status = err.status || err.statusCode || 500;
  let message = 'Server error';
  if (err instanceof multer.MulterError) {
    status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') message = `File too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB)`;
    else if (err.code === 'LIMIT_FILE_COUNT') message = `Too many files (max ${MAX_FILES})`;
    else if (err.code === 'LIMIT_UNEXPECTED_FILE') message = "Unexpected upload field (use 'files')";
    else message = err.message;
  } else if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    status = 400;
    message = 'Invalid request body';
  } else if (status < 500) {
    message = err.message;
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

/* ---------------- websocket ---------------- */

const server = app.listen(PORT, HOST, () => {
  console.log(`LAN Chat is running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`  Network: http://${net.address}:${PORT}`);
    }
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map(); // userId -> Set<ws>

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendToUser(uid, obj) {
  for (const ws of sockets.get(uid) || []) send(ws, obj);
}

function broadcast(obj, exceptUid) {
  for (const [uid] of sockets) if (uid !== exceptUid) sendToUser(uid, obj);
}

function broadcastMessage(conv, row) {
  const recipients = conv.type === 'general' ? [...sockets.keys()] : [conv.userA, conv.userB];
  for (const uid of recipients) sendToUser(uid, { type: 'message', message: messageJson(row, uid) });
}

function closeUserSockets(uid) {
  for (const ws of sockets.get(uid) || []) {
    try {
      ws.close(4001, 'logged-out');
    } catch {}
  }
}

wss.on('connection', (ws, req) => {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const user = token && db.sessionUser(hashToken(token));
  if (!user) {
    ws.close(4001, 'unauthorized');
    return;
  }
  const uid = user.id;
  ws.uid = uid;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  let set = sockets.get(uid);
  const wasOnline = !!set?.size;
  if (!set) {
    set = new Set();
    sockets.set(uid, set);
  }
  set.add(ws);

  send(ws, { type: 'hello', online: [...sockets.keys()], you: uid });
  if (!wasOnline) broadcast({ type: 'presence', userId: uid, online: true });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.type === 'typing' && typeof msg.conv === 'string' && msg.conv.length < 20) {
      if (msg.conv === 'general') {
        broadcast({ type: 'typing', conv: 'general', from: uid }, uid);
      } else {
        const m = /^dm:(\d+)$/.exec(msg.conv);
        if (m) sendToUser(Number(m[1]), { type: 'typing', conv: msg.conv, from: uid });
      }
    }
  });

  ws.on('close', () => {
    const s = sockets.get(uid);
    if (!s) return;
    s.delete(ws);
    if (!s.size) {
      sockets.delete(uid);
      broadcast({ type: 'presence', userId: uid, online: false });
    }
  });
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));
