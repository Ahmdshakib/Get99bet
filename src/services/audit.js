'use strict';

const { sha256Hex } = require('../lib/security');
const { Mutex } = require('../lib/mutex');

const GENESIS = '0'.repeat(64);

/**
 * Append-only audit log. Each row stores hash = SHA256(prev_hash | seq | ts | actor | event | data),
 * so editing or deleting any historical row breaks the chain and verify() reports it.
 *
 * Never put secrets (passwords, session tokens, chain seeds) in `data`.
 * NOTE: call audit.log() OUTSIDE of db.tx() callbacks (see SqliteDb notes).
 * The in-process sequence counter assumes a single application instance.
 */
class Audit {
  constructor({ db, now = () => Date.now(), logger = console }) {
    this.db = db;
    this.now = now;
    this.logger = logger;
    this.lock = new Mutex();
    this.last = null; // { seq, hash }
  }

  async init() {
    const row = await this.db.get('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    this.last = row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: GENESIS };
  }

  static digest(prevHash, seq, ts, actor, event, data) {
    return sha256Hex([prevHash, seq, ts, actor, event, data].join('|'));
  }

  /** actor: user id, or 'system'. Never throws into callers: audit failure is logged loudly. */
  log(actor, event, data = {}) {
    return this.lock.run(async () => {
      if (!this.last) await this.init();
      const seq = this.last.seq + 1;
      const ts = this.now();
      const json = JSON.stringify(data);
      const hash = Audit.digest(this.last.hash, seq, ts, actor, event, json);
      try {
        await this.db.run(
          'INSERT INTO audit_log (seq, ts, actor, event, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?)',
          [seq, ts, actor, event, json, this.last.hash, hash]
        );
        this.last = { seq, hash };
        return seq;
      } catch (e) {
        this.logger.error('[audit] FAILED TO WRITE', event, e);
        this.last = null; // force reload of the chain head on next write
        return null;
      }
    });
  }

  /** Walk the whole chain. Returns { ok, checked, brokenAt? }. */
  async verify() {
    const rows = await this.db.all('SELECT * FROM audit_log ORDER BY seq ASC');
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const r of rows) {
      const good =
        r.seq === expectedSeq &&
        r.prev_hash === prev &&
        r.hash === Audit.digest(prev, r.seq, r.ts, r.actor, r.event, r.data);
      if (!good) return { ok: false, checked: expectedSeq - 1, brokenAt: r.seq };
      prev = r.hash;
      expectedSeq += 1;
    }
    return { ok: true, checked: rows.length };
  }

  /** A user's own recent activity (safe fields only). */
  async listForActor(actor, { limit = 50, offset = 0 } = {}) {
    const rows = await this.db.all(
      'SELECT seq, ts, event, data FROM audit_log WHERE actor = ? ORDER BY seq DESC LIMIT ? OFFSET ?',
      [actor, limit, offset]
    );
    return rows.map((r) => ({ seq: r.seq, ts: r.ts, event: r.event, data: safeParse(r.data) }));
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

module.exports = { Audit, GENESIS };
