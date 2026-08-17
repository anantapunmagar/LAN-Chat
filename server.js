'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const express = require('express');
const multer = require('multer');

const db = require('./db');
const store = require('./store');
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
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file (Vercel body limit)
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

/* --------------- upload (memory storage -> Vercel Blob) --------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE },
});

/* --------------- helpers --------------- */

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
    createdAt: Number(row.createdAt),
    attachments: (row.attachments || []).map((a) => ({
      id: a.id,
      name: a.originalName,
      mime: a.mime,
      size: a.size,
      kind: attachmentKind(a.mime),
      url: a.blobUrl,
      download: `/api/download/${a.id}`,
    })),
  };
}

function resolveConv(user, convStr, create) {
  if (convStr === 'general') return { id: 1, type: 'general' };
  const m = /^dm:(\d+)$/.exec(String(convStr || ''));
  if (!m) return null;
  const other = Number(m[1]);
  if (!Number.isInteger(other) || other === user.id) return null;
  const otherUser = db.getUserById(other);
  if (!otherUser) return null; // eslint-disable-line no-undef
  const dm = create ? db.findOrCreateDm(user.id, other) : db.findDm(user.id, other);
  if (!dm) return null;
  return { id: dm.id, type: 'dm', userA: dm.userA, userB: dm.userB, other };
}

function previewOf(last) {
  if (!last) return null;
  if (last.body && last.body.trim()) {
    const line = last.body.trim().split('\n')[0];
    return line.length > 60 ? line.slice(0, 59) + '...' : line;
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

/* --------------- auth routes --------------- */

const loginFails = new Map();

app.post('/api/auth/register', async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const displayName = String(body.displayName || '').trim().slice(0, 48);
  const password = String(body.password || '');

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, . _ -)' });
  }
  if (password.length < 6 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be 6-200 characters' });
  }
  const user = await db.createUser({
    username,
    displayName: displayName || username,
    passwordHash: hashPassword(password),
    color: AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)],
  });
  if (!user) return res.status(409).json({ error: 'Username is already taken' });
  issueSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const key = `${req.ip}|${username.toLowerCase()}`;
  const now = Date.now();
  const fail = loginFails.get(key);

  if (fail && fail.count >= 15 && fail.until > now) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const user = await db.getUserByUsername(username);
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

app.post('/api/auth/logout', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) db.deleteSession(hashToken(token));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* --------------- data routes --------------- */

app.get('/api/sidebar', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const users = await db.listUsers(uid);
    const dmRows = await db.getDmRows(uid);
    const convIds = [1, ...dmRows.map((d) => d.id)];
    const lasts = await db.getLastMessages(convIds);
    const unread = await db.unreadCounts(uid);
    const onlineIds = await db.getOnlineUserIds();

    const dmConvByUser = new Map();
    for (const d of dmRows) dmConvByUser.set(d.userA === uid ? d.userB : d.userA, d.id);

    const generalLast = lasts.get(1);
    res.json({
      users: users.map((u) => ({ ...u, online: onlineIds.includes(u.id) })),
      general: {
        unread: unread.get(1) || 0,
        last: generalLast
          ? { senderId: generalLast.senderId, senderName: generalLast.senderName, preview: previewOf(generalLast), createdAt: Number(generalLast.createdAt) }
          : null,
      },
      dms: users.map((u) => {
        const convId = dmConvByUser.get(u.id);
        const last = convId && lasts.get(convId);
        return {
          user: { ...u, online: onlineIds.includes(u.id) },
          unread: convId ? unread.get(convId) || 0 : 0,
          last: last
            ? { senderId: last.senderId, senderName: last.senderName, preview: previewOf(last), createdAt: Number(last.createdAt) }
            : null,
        };
      }),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const conv = await resolveConv(req.user, String(req.query.conv || ''), false);
    if (!conv) return res.status(400).json({ error: 'Invalid conversation' });
    if (conv.type === 'dm' && !conv.id) return res.json({ messages: [] });
    const before = Number(req.query.before) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const rows = await db.getMessages(conv.id, before, limit);
    res.json({ messages: rows.map((r) => messageJson(r, req.user.id)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/messages', requireAuth, upload.array('files', MAX_FILES), async (req, res) => {
  try {
    const conv = await resolveConv(req.user, String(req.body.to || ''), true);
    if (!conv) return res.status(400).json({ error: 'Invalid recipient' });
    const body = String(req.body.body || '').trim().slice(0, MAX_BODY_LEN);
    const files = req.files || [];
    if (!body && !files.length) return res.status(400).json({ error: 'Message is empty' });

    const mid = await db.createMessage(conv.id, req.user.id, body);

    for (const f of files) {
      const blobUrl = await store.uploadFile(f.buffer, f.originalname, f.mimetype || 'application/octet-stream');
      await db.addAttachment(mid, blobUrl, f.originalname, f.mimetype || 'application/octet-stream', f.size);
    }

    const row = await db.getMessage(mid);
    res.json({ message: messageJson(row, req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/read', requireAuth, async (req, res) => {
  const conv = await resolveConv(req.user, String(req.body?.conv || ''), false);
  if (conv?.id) await db.markRead(req.user.id, conv.id);
  res.json({ ok: true });
});

/* download proxy: fetches blob, sets Content-Disposition attachment */
app.get('/api/download/:id', requireAuth, async (req, res) => {
  try {
    const att = await db.getAttachment(req.params.id);
    if (!att) return res.status(404).json({ error: 'Not found' });
    const response = await fetch(att.blobUrl);
    if (!response.ok) return res.status(502).json({ error: 'Failed to fetch file' });
    const asciiName = att.originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', att.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(att.originalName)}`);
    response.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Download failed' });
  }
});

/* --------------- polling (replaces WebSocket) --------------- */

app.get('/api/poll', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const since = Number(req.query.since) || 0;
    if (since < 1e12) return res.status(400).json({ error: 'Invalid since' });

    await db.touchPresence(uid);

    const [messages, typing, online] = await Promise.all([
      db.getMessagesAfter(uid, since),
      db.getTypingEvents(uid),
      db.getOnlineUserIds(),
    ]);

    res.json({
      messages: messages.map((r) => messageJson(r, uid)),
      typing: typing.map((t) => ({
        conv: t.convType === 'general' ? 'general' : `dm:${t.userA === uid ? t.userB : t.userA}`,
        from: t.userId,
      })),
      online,
      ts: Date.now(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Poll failed' });
  }
});

app.post('/api/typing', requireAuth, async (req, res) => {
  const conv = await resolveConv(req.user, String(req.body?.conv || ''), false);
  if (conv?.id) await db.upsertTyping(req.user.id, conv.id);
  res.json({ ok: true });
});

/* --------------- error handler --------------- */

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

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

/* --------------- export + listen --------------- */

module.exports = app;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, HOST, () => {
    console.log('LAN Chat is running');
    console.log(`  Local:   http://localhost:${PORT}`);
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets || []) {
        if (net.family === 'IPv4' && !net.internal) console.log(`  Network: http://${net.address}:${PORT}`);
      }
    }
  });
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} already in use`); else throw e; });
}
