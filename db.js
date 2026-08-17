'use strict';
const { sql } = require('@vercel/postgres');

/* Convert snake_case row to camelCase object. */
function cc(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}
function ccAll(rows) { return (rows || []).map(cc); }

/* Convert Postgres TIMESTAMPTZ to epoch ms (float8 so JS gets a number). */
const EPOCH_MS = (col) => `(EXTRACT(EPOCH FROM ${col}) * 1000)::float8`;

/* --------------- schema migration --------------- */

let _migrated = false;

async function migrate() {
  if (_migrated) return;
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      VARCHAR(32) NOT NULL UNIQUE,
      display_name  VARCHAR(48) NOT NULL,
      password_hash TEXT        NOT NULL,
      color         TEXT        NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id     SERIAL PRIMARY KEY,
      type   TEXT NOT NULL CHECK (type IN ('general', 'dm')),
      user_a INTEGER REFERENCES users(id),
      user_b INTEGER REFERENCES users(id)
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id              SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      sender_id       INTEGER NOT NULL REFERENCES users(id),
      body            TEXT    NOT NULL DEFAULT '',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS attachments (
      id            SERIAL PRIMARY KEY,
      message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      blob_url      TEXT    NOT NULL,
      original_name TEXT    NOT NULL,
      mime          TEXT    NOT NULL,
      size          INTEGER NOT NULL
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS reads (
      user_id         INTEGER NOT NULL REFERENCES users(id),
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      message_id      INTEGER NOT NULL,
      PRIMARY KEY (user_id, conversation_id)
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS presence (
      user_id   INTEGER PRIMARY KEY REFERENCES users(id),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS typing (
      user_id         INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, conversation_id)
    )`;

  await sql`INSERT INTO conversations (type) VALUES ('general') ON CONFLICT DO NOTHING`;

  /* housekeeping on cold start */
  await sql`DELETE FROM sessions WHERE expires_at < NOW()`;
  await sql`DELETE FROM typing WHERE updated_at < NOW() - INTERVAL '10 seconds'`;

  _migrated = true;
}

/* thin wrapper: every exported function runs migrate() first */
const q = (fn) => async (...a) => { await migrate(); return fn(...a); };

/* --------------- users & sessions --------------- */

const createUser = q(async ({ username, displayName, passwordHash, color }) => {
  try {
    const r = await sql`
      INSERT INTO users (username, display_name, password_hash, color)
      VALUES (${username}, ${displayName}, ${passwordHash}, ${color})
      RETURNING id, username, display_name, password_hash, color`;
    return r.rows.length ? cc(r.rows[0]) : null;
  } catch (e) {
    if (/duplicate|unique|constraint/i.test(String(e.message))) return null;
    throw e;
  }
});

const getUserById = q(async (id) => {
  const r = await sql`SELECT id, username, display_name, password_hash, color FROM users WHERE id = ${id}`;
  return r.rows[0] ? cc(r.rows[0]) : null;
});

const getUserByUsername = q(async (username) => {
  const r = await sql`SELECT id, username, display_name, password_hash, color FROM users WHERE username = ${username}`;
  return r.rows[0] ? cc(r.rows[0]) : null;
});

const listUsers = q(async (exceptId) => {
  const r = await sql`SELECT id, username, display_name, color FROM users WHERE id <> ${exceptId} ORDER BY display_name`;
  return ccAll(r.rows);
});

const sessionUser = q(async (tokenHash) => {
  const r = await sql`
    SELECT u.id, u.username, u.display_name, u.color
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > NOW()`;
  return r.rows[0] ? cc(r.rows[0]) : null;
});

const createSession = q(async (tokenHash, userId, expiresAt) => {
  const ts = new Date(expiresAt);
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${tokenHash}, ${userId}, ${ts})
          ON CONFLICT (token_hash) DO UPDATE SET expires_at = ${ts}`;
});

const deleteSession = q(async (tokenHash) => {
  await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
});

/* --------------- conversations --------------- */

const findDm = q(async (a, b) => {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const r = await sql`SELECT id, user_a, user_b FROM conversations WHERE type = 'dm' AND user_a = ${lo} AND user_b = ${hi}`;
  return r.rows[0] ? cc(r.rows[0]) : null;
});

const findOrCreateDm = q(async (a, b) => {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const existing = await findDm(a, b);
  if (existing) return existing;
  const r = await sql`INSERT INTO conversations (type, user_a, user_b) VALUES ('dm', ${lo}, ${hi}) RETURNING id, user_a, user_b`;
  return cc(r.rows[0]);
});

const getDmRows = q(async (userId) => {
  const r = await sql`SELECT id, user_a, user_b FROM conversations WHERE type = 'dm' AND (user_a = ${userId} OR user_b = ${userId})`;
  return ccAll(r.rows);
});

/* --------------- messages --------------- */

const MSG_COLS = `
  m.id, ${EPOCH_MS('m.created_at')} AS created_at, m.sender_id, m.body,
  c.type AS conv_type, c.user_a, c.user_b,
  u.username, u.display_name, u.color`;

async function attachAttachments(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const r = await sql`
    SELECT id, message_id, blob_url, original_name, mime, size
    FROM attachments WHERE message_id = ANY(${ids}) ORDER BY id`;
  const byMsg = new Map();
  for (const a of ccAll(r.rows)) {
    if (!byMsg.has(a.messageId)) byMsg.set(a.messageId, []);
    byMsg.get(a.messageId).push(a);
  }
  for (const row of rows) row.attachments = byMsg.get(row.id) || [];
  return rows;
}

const getMessages = q(async (convId, beforeId, limit) => {
  let rows;
  if (beforeId) {
    const r = await sql`SELECT ${MSG_COLS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
      JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ${convId} AND m.id < ${beforeId}
      ORDER BY m.id DESC LIMIT ${limit}`;
    rows = ccAll(r.rows).reverse();
  } else {
    const r = await sql`SELECT ${MSG_COLS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
      JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ${convId}
      ORDER BY m.id DESC LIMIT ${limit}`;
    rows = ccAll(r.rows).reverse();
  }
  return attachAttachments(rows);
});

const getMessage = q(async (id) => {
  const r = await sql`SELECT ${MSG_COLS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = m.sender_id WHERE m.id = ${id}`;
  if (!r.rows.length) return null;
  return (await attachAttachments([cc(r.rows[0])]))[0];
});

const createMessage = q(async (convId, senderId, body) => {
  const r = await sql`INSERT INTO messages (conversation_id, sender_id, body) VALUES (${convId}, ${senderId}, ${body})
    RETURNING id`;
  return Number(r.rows[0].id);
});

const addAttachment = q(async (messageId, blobUrl, originalName, mime, size) => {
  await sql`INSERT INTO attachments (message_id, blob_url, original_name, mime, size)
    VALUES (${messageId}, ${blobUrl}, ${originalName}, ${mime}, ${size})`;
});

const getAttachment = q(async (id) => {
  const r = await sql`SELECT id, message_id, blob_url, original_name, mime, size FROM attachments WHERE id = ${id}`;
  return r.rows[0] ? cc(r.rows[0]) : null;
});

const lastMessageId = q(async (convId) => {
  const r = await sql`SELECT MAX(id)::int AS mid FROM messages WHERE conversation_id = ${convId}`;
  return r.rows[0].mid || 0;
});

/* messages after a timestamp for polling */
const getMessagesAfter = q(async (userId, since) => {
  const sinceTs = new Date(since);
  const r = await sql`
    SELECT ${MSG_COLS} FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = m.sender_id
    WHERE m.created_at > ${sinceTs}
      AND (m.conversation_id = 1
           OR m.conversation_id IN (
             SELECT id FROM conversations WHERE type = 'dm' AND (user_a = ${userId} OR user_b = ${userId})
           ))
    ORDER BY m.id ASC`;
  const rows = ccAll(r.rows);
  return attachAttachments(rows);
});

/* --------------- unread & sidebar --------------- */

const markRead = q(async (userId, convId) => {
  const mid = await lastMessageId(convId);
  if (!mid) return;
  await sql`
    INSERT INTO reads (user_id, conversation_id, message_id) VALUES (${userId}, ${convId}, ${mid})
    ON CONFLICT (user_id, conversation_id)
    DO UPDATE SET message_id = EXCLUDED.message_id WHERE EXCLUDED.message_id > reads.message_id`;
});

const unreadCounts = q(async (userId) => {
  const r = await sql`
    SELECT m.conversation_id AS conv_id, COUNT(*)::int AS n
    FROM messages m
    LEFT JOIN reads r ON r.user_id = ${userId} AND r.conversation_id = m.conversation_id
    WHERE m.sender_id <> ${userId}
      AND (r.message_id IS NULL OR m.id > r.message_id)
      AND (m.conversation_id = 1
           OR m.conversation_id IN (
             SELECT id FROM conversations WHERE type = 'dm' AND (user_a = ${userId} OR user_b = ${userId})
           ))
    GROUP BY m.conversation_id`;
  const out = new Map();
  for (const row of ccAll(r.rows)) out.set(Number(row.convId), Number(row.n));
  return out;
});

const getLastMessages = q(async (convIds) => {
  if (!convIds.length) return new Map();
  const r = await sql`
    SELECT m.id, m.conversation_id AS conv_id, m.sender_id,
           u.display_name AS sender_name, m.body,
           ${EPOCH_MS('m.created_at')} AS created_at,
           (SELECT COUNT(*)::int FROM attachments a WHERE a.message_id = m.id) AS att_count,
           (SELECT original_name FROM attachments a WHERE a.message_id = m.id ORDER BY a.id LIMIT 1) AS att_name,
           (SELECT mime FROM attachments a WHERE a.message_id = m.id ORDER BY a.id LIMIT 1) AS att_mime
    FROM messages m JOIN users u ON u.id = m.sender_id
    JOIN (SELECT conversation_id, MAX(id) AS mid FROM messages
          WHERE conversation_id = ANY(${convIds}) GROUP BY conversation_id) t ON t.mid = m.id`;
  const out = new Map();
  for (const row of ccAll(r.rows)) out.set(Number(row.convId), row);
  return out;
});

/* --------------- presence --------------- */

const touchPresence = q(async (userId) => {
  await sql`INSERT INTO presence (user_id, last_seen) VALUES (${userId}, NOW())
          ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW()`;
});

const getOnlineUserIds = q(async () => {
  const r = await sql`SELECT user_id FROM presence WHERE last_seen > NOW() - INTERVAL '15 seconds'`;
  return r.rows.map((row) => Number(row.user_id));
});

/* --------------- typing --------------- */

const upsertTyping = q(async (userId, convId) => {
  await sql`INSERT INTO typing (user_id, conversation_id) VALUES (${userId}, ${convId})
          ON CONFLICT (user_id, conversation_id) DO UPDATE SET updated_at = NOW()`;
});

const getTypingEvents = q(async (userId) => {
  const r = await sql`
    SELECT t.user_id, t.conversation_id, c.type AS conv_type, c.user_a, c.user_b
    FROM typing t
    JOIN conversations c ON c.id = t.conversation_id
    WHERE t.updated_at > NOW() - INTERVAL '4 seconds'
      AND t.user_id <> ${userId}
      AND (c.type = 'general'
           OR c.user_a = ${userId} OR c.user_b = ${userId})`;
  return ccAll(r.rows);
});

module.exports = {
  createUser, getUserById, getUserByUsername, listUsers,
  sessionUser, createSession, deleteSession,
  findDm, findOrCreateDm, getDmRows,
  getMessages, getMessage, createMessage, addAttachment, getAttachment,
  lastMessageId, getMessagesAfter,
  markRead, unreadCounts, getLastMessages,
  touchPresence, getOnlineUserIds,
  upsertTyping, getTypingEvents,
};
