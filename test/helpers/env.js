'use strict';

const { loadConfig } = require('../../src/config');
const { SqliteDb } = require('../../src/db/sqlite');
const { migrate } = require('../../src/db');
const { TestWalletAdapter } = require('../../src/wallet/TestWalletAdapter');
const { Audit } = require('../../src/services/audit');
const { AuthService } = require('../../src/services/auth');
const { LimitsService } = require('../../src/services/limits');
const { ChainStore } = require('../../src/fair/chainStore');
const { Game } = require('../../src/services/game');

const silent = { error() {}, warn() {}, info() {}, log() {} };

/** A manually advanced clock so game timing is fully deterministic in tests. */
class FakeClock {
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  advance(ms) {
    this.t += ms;
  }
}

async function createEnv(overrides = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    CHAIN_LENGTH: '50',
    SESSION_TTL_HOURS: '24',
    TEST_TOPUP_COOLDOWN_SEC: '60',
    ...overrides,
  });
  const clock = new FakeClock();
  const db = new SqliteDb(':memory:');
  await migrate(db);
  const wallet = new TestWalletAdapter({ db, config, now: () => clock.now() });
  const audit = new Audit({ db, now: () => clock.now(), logger: silent });
  await audit.init();
  const auth = new AuthService({ db, wallet, audit, config, now: () => clock.now() });
  const limits = new LimitsService({ db, audit, config, now: () => clock.now() });
  const chains = new ChainStore({ db, config, now: () => clock.now() });
  const game = new Game({ db, wallet, audit, limits, chains, config, clock, logger: silent });
  await game.init();
  return { config, clock, db, wallet, audit, auth, limits, chains, game };
}

let counter = 0;
async function makeUser(env, name) {
  counter += 1;
  const username = name || `player${counter}`;
  const { user } = await env.auth.register({
    username,
    password: 'correct-horse-battery',
    ageConfirmed: true,
    ip: '127.0.0.1',
  });
  return user;
}

let refCounter = 0;
const ref = () => `ref-${Date.now()}-${++refCounter}-abcdefgh`;

module.exports = { createEnv, makeUser, FakeClock, silent, ref };
