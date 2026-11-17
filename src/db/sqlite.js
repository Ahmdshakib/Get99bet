'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Mutex } = require('../lib/mutex');

/**
 * SQLite adapter (Node's built-in node:sqlite) used for local development and tests.
 *
 * The connection is synchronous, so we serialise access with a mutex: a tx() holds
 * the lock for its whole duration. IMPORTANT: inside a tx() callback use ONLY the
 * handle `t` that is passed in - calling db.get/run from inside would deadlock.
 */
class SqliteDb {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL');
    this.lock = new Mutex();
    this.dialect = 'sqlite';
    this._handle = {
      get: async (sql, p) => this._get(sql, p),
      all: async (sql, p) => this._all(sql, p),
      run: async (sql, p) => this._run(sql, p),
    };
  }

  static norm(params) {
    return (params || []).map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }

  _get(sql, p) {
    const row = this.db.prepare(sql).get(...SqliteDb.norm(p));
    return row ? { ...row } : undefined;
  }

  _all(sql, p) {
    return this.db
      .prepare(sql)
      .all(...SqliteDb.norm(p))
      .map((r) => ({ ...r }));
  }

  _run(sql, p) {
    const r = this.db.prepare(sql).run(...SqliteDb.norm(p));
    return { changes: Number(r.changes) };
  }

  get(sql, p) {
    return this.lock.run(() => this._get(sql, p));
  }
  all(sql, p) {
    return this.lock.run(() => this._all(sql, p));
  }
  run(sql, p) {
    return this.lock.run(() => this._run(sql, p));
  }

  tx(fn) {
    return this.lock.run(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this._handle);
        this.db.exec('COMMIT');
        return result;
      } catch (e) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      }
    });
  }

  async exec(sql) {
    return this.lock.run(() => this.db.exec(sql));
  }

  isUniqueViolation(err) {
    return !!err && /UNIQUE constraint failed|constraint failed: .*UNIQUE/i.test(String(err.message));
  }

  async close() {
    this.db.close();
  }
}

module.exports = { SqliteDb };
