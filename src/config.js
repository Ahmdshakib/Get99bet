'use strict';

/**
 * Central configuration. Everything comes from environment variables so the
 * same build runs in development (SQLite) and production (PostgreSQL).
 */

function intEnv(env, name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

function numEnv(env, name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return n;
}

function boolEnv(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';

  const walletMode = (env.WALLET_MODE || 'test').toLowerCase();
  if (!['test', 'external'].includes(walletMode)) {
    throw new Error('WALLET_MODE must be "test" or "external"');
  }
  const legalConfirmed = boolEnv(env, 'LEGAL_AUTHORIZATION_CONFIRMED', false);
  if (walletMode === 'external' && !legalConfirmed) {
    throw new Error(
      'WALLET_MODE=external requires LEGAL_AUTHORIZATION_CONFIRMED=true. ' +
        'Real-money mode must not be enabled until the licensed wallet API is integrated and legal authorization is confirmed.'
    );
  }

  const cfg = {
    nodeEnv,
    production,
    port: intEnv(env, 'PORT', 3000, { min: 1, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    databaseUrl: env.DATABASE_URL || '',
    sqlitePath: env.SQLITE_PATH || './data/get99bet.sqlite',
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    cookieSecure: boolEnv(env, 'COOKIE_SECURE', production),
    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sessionTtlHours: intEnv(env, 'SESSION_TTL_HOURS', 24 * 7, { min: 1, max: 24 * 90 }),

    wallet: {
      mode: walletMode,
      legalConfirmed,
      // Test-credit settings (all amounts are integer minor units: 100 = 1.00)
      startingBalance: intEnv(env, 'TEST_STARTING_BALANCE', 100000, { min: 0 }),
      topupAmount: intEnv(env, 'TEST_TOPUP_AMOUNT', 100000, { min: 1 }),
      topupCooldownSec: intEnv(env, 'TEST_TOPUP_COOLDOWN_SEC', 60, { min: 0 }),
      balancePollMs: intEnv(env, 'BALANCE_POLL_MS', 15000, { min: 1000 }),
    },

    game: {
      minBet: intEnv(env, 'MIN_BET', 100, { min: 1 }),
      maxBet: intEnv(env, 'MAX_BET', 100000, { min: 1 }),
      maxPayout: intEnv(env, 'MAX_PAYOUT', 100000000, { min: 1 }),
      maxMultiplierX100: intEnv(env, 'MAX_MULTIPLIER_X100', 1000000, { min: 101 }),
      houseEdgeBp: intEnv(env, 'HOUSE_EDGE_BP', 100, { min: 0, max: 2000 }), // basis points: 100 = 1%
      growthRate: numEnv(env, 'GROWTH_RATE', 0.00008, { min: 0.000001, max: 0.01 }), // per millisecond
      bettingMs: intEnv(env, 'BETTING_MS', 8000, { min: 10 }),
      crashPauseMs: intEnv(env, 'CRASH_PAUSE_MS', 4000, { min: 0 }),
      tickMs: intEnv(env, 'TICK_MS', 100, { min: 10 }),
      recentRounds: 30,
    },

    fair: {
      chainLength: intEnv(env, 'CHAIN_LENGTH', 10000, { min: 10, max: 1000000 }),
      clientSeed: env.FAIR_CLIENT_SEED || 'get99bet-test-client-seed',
    },

    rg: {
      sessionReminderDefaultMin: intEnv(env, 'SESSION_REMINDER_DEFAULT_MIN', 30, { min: 5 }),
      raiseDelayHours: intEnv(env, 'RG_RAISE_DELAY_HOURS', 24, { min: 0 }),
    },
  };

  if (cfg.game.maxBet < cfg.game.minBet) throw new Error('MAX_BET must be >= MIN_BET');
  return Object.freeze(cfg);
}

module.exports = { loadConfig };
