'use strict';
/**
 * Minimal session auth: scrypt password hashing + opaque cookie sessions.
 * (Laravel Auth/Guardia analogue, kept intentionally small.)
 */
const crypto = require('crypto');
const { nowIso } = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt') return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function authMiddleware(db) {
  return (req, _res, next) => {
    req.user = null;
    const token = parseCookies(req.headers.cookie).session;
    if (token) {
      const row = db.prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`,
      ).get(token, nowIso());
      if (row) req.user = { id: row.id, name: row.name, email: row.email, role: row.role };
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

function login(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, user.id, expires);
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { hashPassword, verifyPassword, parseCookies, authMiddleware, requireAuth, requireRole, login, logout };
