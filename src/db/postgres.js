'use strict';

/**
 * PostgreSQL adapter (pool of node-pg connections). Exposes the same async
 * interface as SqliteDb so services are database agnostic.
 *
 * SQL in this project uses "?" placeholders; they are rewritten to $1, $2, ...
 */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function normParams(params) {
  return (params || []).map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

class PostgresDb {
  constructor(connectionString) {
    const pg = require('pg');
    // BIGINT (oid 20) arrives as a string by default; all our values are < 2^53.
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.dialect = 'postgres';
  }

  static handleFor(client) {
    return {
      get: async (sql, p) => (await client.query(toPg(sql), normParams(p))).rows[0],
      all: async (sql, p) => (await client.query(toPg(sql), normParams(p))).rows,
      run: async (sql, p) => ({ changes: (await client.query(toPg(sql), normParams(p))).rowCount }),
    };
  }

  async get(sql, p) {
    return (await this.pool.query(toPg(sql), normParams(p))).rows[0];
  }
  async all(sql, p) {
    return (await this.pool.query(toPg(sql), normParams(p))).rows;
  }
  async run(sql, p) {
    return { changes: (await this.pool.query(toPg(sql), normParams(p))).rowCount };
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(PostgresDb.handleFor(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async exec(sql) {
    await this.pool.query(sql);
  }

  isUniqueViolation(err) {
    return !!err && err.code === '23505';
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PostgresDb };
