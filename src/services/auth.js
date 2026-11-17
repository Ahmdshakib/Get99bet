'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { DomainError } = require('../lib/errors');
const { sha256Hex, newToken } = require('../lib/security');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const dk = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

/** Stable pseudonymous id shown in public bet feeds (never reveals the user id). */
function publicHandle(userId) {
  return sha256Hex('g99-handle:' + userId).slice(0, 10);
}

function maskName(username) {
  if (username.length <= 2) return username[0] + '***';
  return username.slice(0, 2) + '***' + username.slice(-1);
}

class AuthService extends EventEmitter {
  constructor({ db, wallet, audit, config, now = () => Date.now() }) {
    super();
    this.db = db;
    this.wallet = wallet;
    this.audit = audit;
    this.config = config;
    this.now = now;
    this.failures = new Map(); // username_lc -> { count, lockedUntil }
    // Pre-computed hash so unknown-user logins cost the same as real ones (no user enumeration by timing).
    this._dummy = hashPassword('dummy-password-for-timing');
  }

  static validate({ username, password }) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw new DomainError('bad_username', 'Username must be 3-20 letters, numbers or underscores', 400);
    }
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
      throw new DomainError('bad_password', 'Password must be 10-128 characters', 400);
    }
  }

  async register({ username, password, ageConfirmed, locale = 'en', ip, userAgent }) {
    AuthService.validate({ username, password });
    if (ageConfirmed !== true) {
      throw new DomainError('age_not_confirmed', 'You must confirm that you are 18 or older', 400);
    }
    const lc = username.toLowerCase();
    const existing = await this.db.get('SELECT id FROM users WHERE username_lc = ?', [lc]);
    if (existing) throw new DomainError('username_taken', 'Username is already taken', 409);

    const id = crypto.randomUUID();
    const ts = this.now();
    const passwordHash = await hashPassword(password);
    try {
      await this.db.run(
        'INSERT INTO users (id, username, username_lc, password_hash, status, locale, age_confirmed_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, username, lc, passwordHash, 'active', locale === 'bn' ? 'bn' : 'en', ts, ts]
      );
    } catch (e) {
      if (this.db.isUniqueViolation(e)) throw new DomainError('username_taken', 'Username is already taken', 409);
      throw e;
    }
    await this.wallet.ensureAccount(id);
    await this.audit.log(id, 'user.register', { username, ip });
    return this._startSession(id, { ip, userAgent });
  }

  async login({ username, password, ip, userAgent }) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 128) {
      throw new DomainError('invalid_credentials', 'Invalid username or password', 401);
    }
    const lc = username.toLowerCase();
    const f = this.failures.get(lc);
    if (f && f.lockedUntil > this.now()) {
      await this.audit.log('system', 'auth.locked', { username: lc, ip });
      throw new DomainError('account_locked', 'Too many failed attempts. Try again later.', 429, {
        retryAfterMs: f.lockedUntil - this.now(),
      });
    }
    const user = await this.db.get('SELECT * FROM users WHERE username_lc = ?', [lc]);
    const ok = await verifyPassword(password, user ? user.password_hash : await this._dummy);
    if (!user || !ok) {
      const rec = this.failures.get(lc) || { count: 0, lockedUntil: 0 };
      rec.count += 1;
      if (rec.count >= MAX_FAILS) {
        rec.lockedUntil = this.now() + LOCK_MS;
        rec.count = 0;
      }
      this.failures.set(lc, rec);
      await this.audit.log(user ? user.id : 'system', 'auth.login_failed', { username: lc, ip });
      throw new DomainError('invalid_credentials', 'Invalid username or password', 401);
    }
    if (user.status !== 'active') throw new DomainError('account_disabled', 'Account is disabled', 403);
    this.failures.delete(lc);
    await this.audit.log(user.id, 'auth.login', { ip });
    return this._startSession(user.id, { ip, userAgent });
  }

  async _startSession(userId, { ip, userAgent }) {
    const token = newToken();
    const ts = this.now();
    const expiresAt = ts + this.config.sessionTtlHours * 3600 * 1000;
    await this.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, revoked, ip, user_agent) VALUES (?,?,?,?,0,?,?)',
      [sha256Hex(token), userId, ts, expiresAt, ip || null, (userAgent || '').slice(0, 200)]
    );
    return { token, expiresAt, user: await this.getUser(userId) };
  }

  /** Resolve a raw session token. Returns { user, tokenHash, expiresAt } or null. */
  async resolveSession(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const tokenHash = sha256Hex(token);
    const s = await this.db.get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
    if (!s || s.revoked || s.expires_at <= this.now()) return null;
    const user = await this.getUser(s.user_id);
    if (!user || user.status !== 'active') return null;
    return { user, tokenHash, expiresAt: s.expires_at };
  }

  async logout(token, ip) {
    const tokenHash = sha256Hex(token || '');
    const s = await this.db.get('SELECT user_id FROM sessions WHERE token_hash = ?', [tokenHash]);
    if (!s) return;
    await this.db.run('UPDATE sessions SET revoked = 1 WHERE token_hash = ?', [tokenHash]);
    await this.audit.log(s.user_id, 'auth.logout', { ip });
    this.emit('session_revoked', { tokenHash, userId: s.user_id });
  }

  async getUser(userId) {
    const u = await this.db.get('SELECT id, username, status, locale, created_at FROM users WHERE id = ?', [userId]);
    if (!u) return null;
    return { id: u.id, username: u.username, status: u.status, locale: u.locale, createdAt: u.created_at, handle: publicHandle(u.id) };
  }

  async setLocale(userId, locale) {
    await this.db.run('UPDATE users SET locale = ? WHERE id = ?', [locale === 'bn' ? 'bn' : 'en', userId]);
  }
}

module.exports = { AuthService, hashPassword, verifyPassword, publicHandle, maskName };
