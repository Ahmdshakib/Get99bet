'use strict';

const crypto = require('node:crypto');
const { buildChain, newSeed } = require('./engine');
const { Mutex } = require('../lib/mutex');

/**
 * Persists the hash chain so a restart resumes exactly where it left off, and
 * rotates to a fresh chain when the current one is exhausted.
 * The chain SEED is a secret: it is never returned by any API.
 */
class ChainStore {
  constructor({ db, config, now = () => Date.now() }) {
    this.db = db;
    this.config = config;
    this.now = now;
    this.lock = new Mutex();
    this.current = null; // { id, chain, terminal, clientSeed, nextIndex, length }
  }

  async _load() {
    const row = await this.db.get('SELECT * FROM fair_chains ORDER BY created_at DESC, id DESC LIMIT 1');
    if (row && row.next_index >= 0) {
      this.current = {
        id: row.id,
        chain: buildChain(row.seed, row.length),
        terminal: row.terminal_hash,
        clientSeed: row.client_seed,
        nextIndex: row.next_index,
        length: row.length,
      };
      return;
    }
    const length = this.config.fair.chainLength;
    const seed = newSeed();
    const chain = buildChain(seed, length);
    const id = crypto.randomUUID();
    await this.db.run(
      'INSERT INTO fair_chains (id, seed, length, terminal_hash, client_seed, next_index, created_at) VALUES (?,?,?,?,?,?,?)',
      [id, seed, length, chain[length], this.config.fair.clientSeed, length - 1, this.now()]
    );
    this.current = { id, chain, terminal: chain[length], clientSeed: this.config.fair.clientSeed, nextIndex: length - 1, length };
  }

  /**
   * Take the next hash. Returns the hash for the upcoming round, the index used,
   * and the public commitment (the hash that SHA256(hash) must equal).
   */
  next() {
    return this.lock.run(async () => {
      if (!this.current || this.current.nextIndex < 0) await this._load();
      const c = this.current;
      const index = c.nextIndex;
      await this.db.run('UPDATE fair_chains SET next_index = ? WHERE id = ?', [index - 1, c.id]);
      c.nextIndex = index - 1;
      return {
        chainId: c.id,
        index,
        hash: c.chain[index],
        commitment: c.chain[index + 1],
        clientSeed: c.clientSeed,
        terminal: c.terminal,
      };
    });
  }

  /** Look up the secret hash for a (chainId, index) pair - used for crash recovery only. */
  async hashFor(chainId, index) {
    if (!this.current) await this._load();
    if (this.current.id === chainId) return this.current.chain[index];
    const row = await this.db.get('SELECT seed, length FROM fair_chains WHERE id = ?', [chainId]);
    if (!row) return null;
    return buildChain(row.seed, row.length)[index];
  }

  async publicInfo() {
    if (!this.current) await this._load();
    const c = this.current;
    return {
      chainId: c.id,
      terminalHash: c.terminal,
      length: c.length,
      clientSeed: c.clientSeed,
      remaining: c.nextIndex + 1,
      houseEdgeBp: this.config.game.houseEdgeBp,
      maxMultiplierX100: this.config.game.maxMultiplierX100,
    };
  }
}

module.exports = { ChainStore };
