'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Create the database adapter: PostgreSQL when DATABASE_URL is set, else SQLite. */
function createDb(config) {
  if (config.databaseUrl) {
    const { PostgresDb } = require('./postgres');
    return new PostgresDb(config.databaseUrl);
  }
  const { SqliteDb } = require('./sqlite');
  return new SqliteDb(config.sqlitePath);
}

/** Apply schema.sql (idempotent: every statement is CREATE ... IF NOT EXISTS). */
async function migrate(db) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await db.exec(stmt);
}

module.exports = { createDb, migrate };
