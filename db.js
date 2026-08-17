'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    color         TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS conversations (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    type   TEXT NOT NULL CHECK (type IN ('general', 'dm')),
    user_a INTEGER REFERENCES users(id),
    user_b INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    sender_id       INTEGER NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    stored_name   TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);

  CREATE TABLE IF NOT EXISTS reads (
    user_id         INTEGER NOT NULL REFERENCES users(id),
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    message_id      INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  );

  INSERT OR IGNORE INTO conversations (id, type) VALUES (1, 'general');
`);

/* ---------------- users & sessions ---------------- */

function createUser({ username, displayName, passwordHash, color }) {
  try {
    const r = db
      .prepare('INSERT INTO users (username, display_name, password_hash, color, created_at) VALUES (?,?,?,?,?)')
      .run(username, displayName, passwordHash, color, Date.now());
    return getUserById(Number(r.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null;
    throw e;
  }
}

function getUserById(id) {
  return db
    .prepare('SELECT id, username, display_name AS displayName, password_hash AS passwordHash, color FROM users WHERE id = ?')
    .get(id);
}

function getUserByUsername(username) {
  return db
    .prepare('SELECT id, username, display_name AS displayName, password_hash AS passwordHash, color FROM users WHERE username = ?')
    .get(username);
}

function listUsers(exceptId) {
  return db
    .prepare('SELECT id, username, display_name AS displayName, color FROM users WHERE id <> ? ORDER BY display_name COLLATE NOCASE')
    .all(exceptId);
}

function sessionUser(tokenHash) {
  if (Math.random() < 0.02) db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return db
    .prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, u.color
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `)
    .get(tokenHash, Date.now());
}

function createSession(tokenHash, userId, expiresAt) {
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(tokenHash, userId, expiresAt);
}

function deleteSession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

/* ---------------- conversations ---------------- */

const DM_COLS = 'id, user_a AS userA, user_b AS userB';

function findDm(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return db.prepare(`SELECT ${DM_COLS} FROM conversations WHERE type = 'dm' AND user_a = ? AND user_b = ?`).get(lo, hi);
}

function findOrCreateDm(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const existing = findDm(a, b);
  if (existing) return existing;
  const r = db.prepare("INSERT INTO conversations (type, user_a, user_b) VALUES ('dm', ?, ?)").run(lo, hi);
  return { id: Number(r.lastInsertRowid), userA: lo, userB: hi };
}

function getDmRows(userId) {
  return db
    .prepare(`SELECT ${DM_COLS} FROM conversations WHERE type = 'dm' AND (user_a = ? OR user_b = ?)`)
    .all(userId, userId);
}

/* ---------------- messages ---------------- */

const MSG_QUERY = `
  SELECT m.id, m.created_at AS createdAt, m.sender_id AS senderId, m.body,
         c.type AS convType, c.user_a AS userA, c.user_b AS userB,
         u.username, u.display_name AS displayName, u.color
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  JOIN users u ON u.id = m.sender_id
`;

function attachAttachments(rows) {
  if (!rows.length) return rows;
  const placeholders = rows.map(() => '?').join(',');
  const atts = db
    .prepare(
      `SELECT id, message_id AS messageId, stored_name AS storedName, original_name AS originalName, mime, size
       FROM attachments WHERE message_id IN (${placeholders}) ORDER BY id`
    )
    .all(...rows.map((r) => r.id));
  const byMsg = new Map();
  for (const a of atts) {
    if (!byMsg.has(a.messageId)) byMsg.set(a.messageId, []);
    byMsg.get(a.messageId).push(a);
  }
  for (const r of rows) r.attachments = byMsg.get(r.id) || [];
  return rows;
}

function getMessages(convId, beforeId, limit) {
  const where = beforeId ? 'WHERE m.conversation_id = ? AND m.id < ?' : 'WHERE m.conversation_id = ?';
  const params = beforeId ? [convId, beforeId, limit] : [convId, limit];
  const rows = db
    .prepare(`${MSG_QUERY} ${where} ORDER BY m.id DESC LIMIT ?`)
    .all(...params)
    .reverse();
  return attachAttachments(rows);
}

function getMessage(id) {
  const row = db.prepare(`${MSG_QUERY} WHERE m.id = ?`).get(id);
  return row ? attachAttachments([row])[0] : null;
}

function createMessage(convId, senderId, body) {
  const r = db
    .prepare('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?,?,?,?)')
    .run(convId, senderId, body, Date.now());
  return Number(r.lastInsertRowid);
}

function addAttachment(messageId, storedName, originalName, mime, size) {
  db.prepare('INSERT INTO attachments (message_id, stored_name, original_name, mime, size) VALUES (?,?,?,?,?)').run(
    messageId,
    storedName,
    originalName,
    mime,
    size
  );
}

function getAttachmentByStored(storedName) {
  return db
    .prepare('SELECT id, message_id AS messageId, stored_name AS storedName, original_name AS originalName, mime, size FROM attachments WHERE stored_name = ?')
    .get(storedName);
}

function lastMessageId(convId) {
  const r = db.prepare('SELECT MAX(id) AS mid FROM messages WHERE conversation_id = ?').get(convId);
  return r && r.mid ? Number(r.mid) : 0;
}

/* ---------------- unread & sidebar ---------------- */

function markRead(userId, convId) {
  const mid = lastMessageId(convId);
  if (!mid) return;
  db.prepare(
    `INSERT INTO reads (user_id, conversation_id, message_id) VALUES (?,?,?)
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET message_id = excluded.message_id
     WHERE excluded.message_id > reads.message_id`
  ).run(userId, convId, mid);
}

function unreadCounts(userId) {
  const rows = db
    .prepare(
      `SELECT m.conversation_id AS convId, COUNT(*) AS n
       FROM messages m
       LEFT JOIN reads r ON r.user_id = ? AND r.conversation_id = m.conversation_id
       WHERE m.sender_id <> ?
         AND (r.message_id IS NULL OR m.id > r.message_id)
         AND (m.conversation_id = 1 OR m.conversation_id IN
              (SELECT id FROM conversations WHERE type = 'dm' AND (user_a = ? OR user_b = ?)))
       GROUP BY m.conversation_id`
    )
    .all(userId, userId, userId, userId);
  const out = new Map();
  for (const r of rows) out.set(r.convId, Number(r.n));
  return out;
}

function getLastMessages(convIds) {
  const out = new Map();
  if (!convIds.length) return out;
  const placeholders = convIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.id, m.conversation_id AS convId, m.sender_id AS senderId,
              u.display_name AS senderName, m.body, m.created_at AS createdAt,
              (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attCount,
              (SELECT original_name FROM attachments a WHERE a.message_id = m.id ORDER BY a.id LIMIT 1) AS attName,
              (SELECT mime FROM attachments a WHERE a.message_id = m.id ORDER BY a.id LIMIT 1) AS attMime
       FROM messages m JOIN users u ON u.id = m.sender_id
       JOIN (SELECT conversation_id, MAX(id) AS mid FROM messages
             WHERE conversation_id IN (${placeholders}) GROUP BY conversation_id) t ON t.mid = m.id`
    )
    .all(...convIds);
  for (const r of rows) out.set(r.convId, r);
  return out;
}

module.exports = {
  DATA_DIR,
  UPLOADS_DIR,
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  sessionUser,
  createSession,
  deleteSession,
  findDm,
  findOrCreateDm,
  getDmRows,
  getMessages,
  getMessage,
  createMessage,
  addAttachment,
  getAttachmentByStored,
  markRead,
  unreadCounts,
  getLastMessages,
};
