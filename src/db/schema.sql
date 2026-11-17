-- Portable schema: runs unchanged on SQLite and PostgreSQL.
-- Money = integer minor units. Time = epoch milliseconds. Multipliers = integer x100.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_lc TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  locale TEXT NOT NULL DEFAULT 'en',
  age_confirmed_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS wallet_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  currency TEXT NOT NULL,
  balance BIGINT NOT NULL CHECK (balance >= 0),
  updated_at BIGINT NOT NULL
);

-- Append-only ledger. "reference" is the idempotency key: one reference = one effect.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  balance_after BIGINT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  meta TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wtx_user_time ON wallet_transactions(user_id, created_at);

CREATE TABLE IF NOT EXISTS fair_chains (
  id TEXT PRIMARY KEY,
  seed TEXT NOT NULL,
  length INTEGER NOT NULL,
  terminal_hash TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  next_index INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  chain_id TEXT NOT NULL REFERENCES fair_chains(id),
  chain_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  bet_open_at BIGINT NOT NULL,
  started_at BIGINT,
  crashed_at BIGINT,
  crash_x100 BIGINT,
  round_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  client_ref TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  auto_x100 BIGINT,
  status TEXT NOT NULL,
  cashout_x100 BIGINT,
  payout BIGINT NOT NULL DEFAULT 0,
  settlement TEXT NOT NULL DEFAULT 'none',
  created_at BIGINT NOT NULL,
  settled_at BIGINT,
  UNIQUE (round_id, user_id),
  UNIQUE (user_id, client_ref)
);
CREATE INDEX IF NOT EXISTS idx_bets_user_time ON bets(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round_id);
CREATE INDEX IF NOT EXISTS idx_bets_settlement ON bets(settlement);

-- Hash-chained, append-only audit trail (tamper evident).
CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGINT PRIMARY KEY,
  ts BIGINT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, seq);

CREATE TABLE IF NOT EXISTS rg_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  max_bet BIGINT,
  daily_loss_limit BIGINT,
  session_reminder_min INTEGER,
  pending_json TEXT,
  pending_effective_at BIGINT,
  excluded_until BIGINT,
  updated_at BIGINT NOT NULL
)
