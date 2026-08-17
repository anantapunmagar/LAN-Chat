'use strict';
const crypto = require('node:crypto');
const db = require('./db');

const COOKIE_NAME = 'lanchat_session';
const SESSION_MAX_AGE = 30 * 24 * 3600; // seconds

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicUser(u) {
  return u && { id: u.id, username: u.username, displayName: u.displayName, color: u.color };
}

function attachUser(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    const user = db.sessionUser(hashToken(token));
    if (user) req.user = user;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.createSession(hashToken(token), userId, Date.now() + SESSION_MAX_AGE * 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
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
};
