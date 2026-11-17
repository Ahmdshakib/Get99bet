'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, makeUser, ref, silent } = require('./helpers/env');
const { timeToReachMs, multiplierX100At, verifyLink, crashPointX100 } = require('../src/fair/engine');
const { Game } = require('../src/services/game');
const { payoutFor } = require('../src/lib/money');

/** Force the secret crash point of the current round (tests only). */
function forceCrash(env, x100) {
  env.game.round.crashX100 = x100;
  env.game.round.crashElapsedMs = timeToReachMs(x100, env.config.game.growthRate);
}

async function startRound(env, crashX100) {
  await env.game.openBetting();
  if (crashX100) forceCrash(env, crashX100);
}

async function run(env) {
  env.clock.advance(env.config.game.bettingMs + 1);
  await env.game.startRunning();
}

const events = (env) => {
  const list = [];
  env.game.on('event', (e) => list.push(e));
  return list;
};

test('winning flow: bet debits stake, cash-out credits stake*multiplier, server decides the multiplier', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 1000);
  const res = await env.game.placeBet(u, { amount: 10000, clientRef: ref() });
  assert.equal(res.balance, 90000);
  assert.equal(await env.wallet.getBalance(u.id), 90000);

  await run(env);
  env.clock.advance(timeToReachMs(300, env.config.game.growthRate) + 5);
  const out = await env.game.cashOut(u);
  const expectedX = multiplierX100At(env.clock.now() - env.game.round.startedAt, env.config.game.growthRate);
  assert.equal(out.x100, expectedX);
  assert.ok(out.x100 >= 300 && out.x100 < 1000);
  assert.equal(out.payout, payoutFor(10000, out.x100));
  assert.equal(await env.wallet.getBalance(u.id), 90000 + out.payout);

  const row = await env.db.get('SELECT * FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.status, 'cashed');
  assert.equal(row.settlement, 'done');
});

test('losing flow: stake is gone, bet marked lost, nothing credited', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 150);
  await env.game.placeBet(u, { amount: 5000, clientRef: ref() });
  await run(env);
  env.clock.advance(6000);
  await env.game.tick();
  assert.equal(env.game.round.status, 'crashed');
  assert.equal(await env.wallet.getBalance(u.id), 95000);
  const row = await env.db.get('SELECT * FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.status, 'lost');
  assert.equal(row.payout, 0);
});

test('cash-out after the crash time is rejected even if tick has not run yet', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 200);
  await env.game.placeBet(u, { amount: 1000, clientRef: ref() });
  await run(env);
  env.clock.advance(timeToReachMs(200, env.config.game.growthRate) + 1);
  await assert.rejects(env.game.cashOut(u), { publicCode: 'too_late' });
  await env.game.tick();
  assert.equal(await env.wallet.getBalance(u.id), 99000);
});

test('auto cash-out pays exactly the target multiplier even when the tick is late', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 1000);
  await env.game.placeBet(u, { amount: 10000, autoX100: 200, clientRef: ref() });
  await run(env);
  env.clock.advance(timeToReachMs(200, env.config.game.growthRate) + 900); // tick arrives late (multiplier well above 2x)
  await env.game.tick();
  const row = await env.db.get('SELECT * FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.status, 'cashed');
  assert.equal(row.cashout_x100, 200);
  assert.equal(row.payout, 20000);
  assert.equal(await env.wallet.getBalance(u.id), 110000);
});

test('auto cash-out is paid at the crash sweep if the target is below the crash point', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 300);
  await env.game.placeBet(u, { amount: 1000, autoX100: 250, clientRef: ref() });
  await run(env);
  env.clock.advance(60_000); // jump far past the crash with no intermediate ticks
  await env.game.tick();
  const row = await env.db.get('SELECT * FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.status, 'cashed');
  assert.equal(row.cashout_x100, 250);
  assert.equal(await env.wallet.getBalance(u.id), 99000 + 2500);
});

test('auto cash-out above the crash point loses', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 200);
  await env.game.placeBet(u, { amount: 1000, autoX100: 201, clientRef: ref() });
  await run(env);
  env.clock.advance(60_000);
  await env.game.tick();
  const row = await env.db.get('SELECT * FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.status, 'lost');
  assert.equal(await env.wallet.getBalance(u.id), 99000);
});

test('double / concurrent cash-out credits exactly once', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 5000);
  await env.game.placeBet(u, { amount: 10000, clientRef: ref() });
  await run(env);
  env.clock.advance(3000);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => env.game.cashOut(u)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const wins = await env.db.all("SELECT * FROM wallet_transactions WHERE user_id = ? AND reference LIKE 'win:%'", [u.id]);
  assert.equal(wins.length, 1);
  const row = await env.db.get('SELECT payout FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(await env.wallet.getBalance(u.id), 90000 + row.payout);
});

test('duplicate bet request (same clientRef) is idempotent: charged once', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env);
  const clientRef = ref();
  const a = await env.game.placeBet(u, { amount: 2000, clientRef });
  const b = await env.game.placeBet(u, { amount: 2000, clientRef });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.bet.id, b.bet.id);
  assert.equal(await env.wallet.getBalance(u.id), 98000);
  await assert.rejects(env.game.placeBet(u, { amount: 3000, clientRef }), { publicCode: 'client_ref_conflict' });
});

test('only one bet per round and no bets once the round is running', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env);
  await env.game.placeBet(u, { amount: 1000, clientRef: ref() });
  await assert.rejects(env.game.placeBet(u, { amount: 1000, clientRef: ref() }), { publicCode: 'already_bet' });
  assert.equal(await env.wallet.getBalance(u.id), 99000);
  await run(env);
  const u2 = await makeUser(env);
  await assert.rejects(env.game.placeBet(u2, { amount: 1000, clientRef: ref() }), { publicCode: 'betting_closed' });
  assert.equal(await env.wallet.getBalance(u2.id), 100000);
});

test('concurrent bets from the same user: one accepted, one debit', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => env.game.placeBet(u, { amount: 1000, clientRef: ref() })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await env.wallet.getBalance(u.id), 99000);
  const debits = await env.db.all("SELECT * FROM wallet_transactions WHERE user_id = ? AND type = 'debit'", [u.id]);
  assert.equal(debits.length, 1);
});

test('bet validation: amount bounds, auto cash-out bounds, insufficient funds', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env);
  await assert.rejects(env.game.placeBet(u, { amount: 50, clientRef: ref() }), { publicCode: 'under_min_bet' });
  await assert.rejects(env.game.placeBet(u, { amount: 100001, clientRef: ref() }), { publicCode: 'over_max_bet' });
  await assert.rejects(env.game.placeBet(u, { amount: 1000.5, clientRef: ref() }), { publicCode: 'bad_amount' });
  await assert.rejects(env.game.placeBet(u, { amount: 1000, autoX100: 100, clientRef: ref() }), { publicCode: 'bad_auto_cashout' });
  await assert.rejects(env.game.placeBet(u, { amount: 1000, autoX100: 99999999, clientRef: ref() }), { publicCode: 'bad_auto_cashout' });
  await assert.rejects(env.game.placeBet(u, { amount: 1000, clientRef: 'x' }), { publicCode: 'bad_client_ref' });
  assert.equal(await env.wallet.getBalance(u.id), 100000);

  const poor = await makeUser(env);
  await env.wallet.debit(poor.id, 99500, 'bet:drain');
  await assert.rejects(env.game.placeBet(poor, { amount: 1000, clientRef: ref() }), { publicCode: 'insufficient_funds' });
  assert.equal(await env.wallet.getBalance(poor.id), 500);
  const failed = await env.db.get("SELECT status FROM bets WHERE user_id = ?", [poor.id]);
  assert.equal(failed.status, 'failed');
});

test('cannot cash out without a bet, or someone else\'s bet', async () => {
  const env = await createEnv();
  const a = await makeUser(env);
  const b = await makeUser(env);
  await startRound(env, 5000);
  await env.game.placeBet(a, { amount: 1000, clientRef: ref() });
  await run(env);
  env.clock.advance(1000);
  await assert.rejects(env.game.cashOut(b), { publicCode: 'no_active_bet' });
  assert.equal(await env.wallet.getBalance(b.id), 100000);
});

test('wallet outage during payout: bet stays pending and reconcile pays exactly once', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 5000);
  await env.game.placeBet(u, { amount: 10000, clientRef: ref() });
  await run(env);
  env.clock.advance(3000);

  const realCredit = env.wallet.credit.bind(env.wallet);
  let down = true;
  env.wallet.credit = async (...args) => {
    if (down) throw new Error('wallet down');
    return realCredit(...args);
  };
  const out = await env.game.cashOut(u).catch((e) => e);
  // cashOut itself fails on getBalance? No - credit failure is swallowed into reconcile; result still returned.
  assert.ok(out.payout > 0);
  let row = await env.db.get('SELECT * FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.status, 'cashed');
  assert.equal(row.settlement, 'pending');
  assert.equal(await env.wallet.getBalance(u.id), 90000);

  down = false;
  assert.equal(await env.game.reconcile(), 1);
  assert.equal(await env.game.reconcile(), 0);
  row = await env.db.get('SELECT * FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.settlement, 'done');
  assert.equal(await env.wallet.getBalance(u.id), 90000 + out.payout);
});

test('debit still in flight when betting closes: stake is refunded and bet is not active', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 5000);

  const realDebit = env.wallet.debit.bind(env.wallet);
  let release;
  const gate = new Promise((r) => (release = r));
  env.wallet.debit = async (...args) => {
    const r = await realDebit(...args); // money really leaves the wallet...
    await gate; // ...but confirmation is slow
    return r;
  };
  const pending = env.game.placeBet(u, { amount: 4000, clientRef: ref() });
  await new Promise((r) => setTimeout(r, 20));
  env.clock.advance(env.config.game.bettingMs + 1);
  await env.game.startRunning(); // betting closes while the debit is in flight
  release();
  await assert.rejects(pending, { publicCode: 'betting_closed' });
  assert.equal(await env.wallet.getBalance(u.id), 100000); // refunded
  const row = await env.db.get('SELECT * FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.status, 'void');
  assert.equal(row.settlement, 'done');
});

test('ambiguous wallet failure on debit never loses the stake (void + idempotent refund)', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env);
  const realDebit = env.wallet.debit.bind(env.wallet);
  env.wallet.debit = async (...args) => {
    await realDebit(...args); // debit happened...
    throw new Error('timeout'); // ...but the caller saw a failure
  };
  await assert.rejects(env.game.placeBet(u, { amount: 4000, clientRef: ref() }), /timeout/);
  assert.equal(await env.wallet.getBalance(u.id), 100000);
});

test('crash recovery: a restart voids the in-progress round and refunds open stakes', async () => {
  const env = await createEnv();
  const a = await makeUser(env);
  const b = await makeUser(env);
  await startRound(env, 5000);
  await env.game.placeBet(a, { amount: 7000, clientRef: ref() });
  await env.game.placeBet(b, { amount: 3000, clientRef: ref() });
  await run(env);
  assert.equal(await env.wallet.getBalance(a.id), 93000);

  // "Process restarts": a brand-new Game over the same database.
  const game2 = new Game({ ...env, config: env.config, chains: env.chains, clock: env.clock, logger: silent });
  await game2.init();
  assert.equal(await env.wallet.getBalance(a.id), 100000);
  assert.equal(await env.wallet.getBalance(b.id), 100000);
  const round = await env.db.get('SELECT status FROM rounds ORDER BY number DESC LIMIT 1');
  assert.equal(round.status, 'void');
  // Running recovery again is harmless.
  await game2.recover();
  assert.equal(await env.wallet.getBalance(a.id), 100000);
});

test('balance persists across a "refresh": a new snapshot shows the same balance and the active bet', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await startRound(env, 5000);
  await env.game.placeBet(u, { amount: 2500, clientRef: ref() });
  const snap = env.game.snapshot(u.id);
  assert.equal(snap.myBet.amount, 2500);
  assert.equal(snap.myBet.status, 'active');
  assert.equal(await env.wallet.getBalance(u.id), 97500);
  // Secrets are not exposed before the crash.
  assert.equal(snap.round.hash, undefined);
  assert.equal(snap.round.crashX100, undefined);
  assert.equal(JSON.stringify(snap).includes(env.game.round.hash), false);
});

test('provably fair: revealed hash matches the commitment and reproduces the crash point', async () => {
  const env = await createEnv();
  const info = await env.chains.publicInfo();
  const seen = [];
  env.game.on('event', (e) => e.type === 'crashed' && seen.push(e));
  let previous = info.terminalHash;
  const first = await env.game.openBetting();
  assert.equal(first.commitment, previous);
  for (let i = 0; i < 5; i++) {
    if (i > 0) await env.game.openBetting();
    const commitment = env.game.round.commitment;
    assert.equal(commitment, previous, 'commitment must equal the previously revealed hash');
    await run(env);
    env.clock.advance(10 * 60 * 1000);
    await env.game.tick();
    const e = seen[seen.length - 1];
    assert.ok(verifyLink(e.hash, commitment));
    assert.equal(crashPointX100(e.hash, info.clientSeed, env.config.game), e.crashX100);
    previous = e.hash;
  }
});

test('chain store resumes after restart and never reuses a hash', async () => {
  const env = await createEnv();
  const used = new Set();
  for (let i = 0; i < 5; i++) {
    const n = await env.chains.next();
    assert.ok(!used.has(n.hash));
    used.add(n.hash);
  }
  const { ChainStore } = require('../src/fair/chainStore');
  const again = new ChainStore({ db: env.db, config: env.config });
  for (let i = 0; i < 5; i++) {
    const n = await again.next();
    assert.ok(!used.has(n.hash));
    used.add(n.hash);
  }
});

test('chain rotates to a new chain when exhausted', async () => {
  const env = await createEnv({ CHAIN_LENGTH: '10' });
  const ids = new Set();
  for (let i = 0; i < 25; i++) ids.add((await env.chains.next()).chainId);
  assert.ok(ids.size >= 3);
});

test('multi-player money conservation across many rounds (ledger always reconciles)', async () => {
  const env = await createEnv();
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await makeUser(env));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 25; round++) {
    await env.game.openBetting();
    for (const u of users) {
      if (rnd() < 0.8) {
        await env.game
          .placeBet(u, { amount: 100 + Math.floor(rnd() * 5000), autoX100: rnd() < 0.5 ? 101 + Math.floor(rnd() * 400) : null, clientRef: ref() })
          .catch(() => {});
      }
    }
    await run(env);
    for (const u of users) {
      if (rnd() < 0.5) {
        env.clock.advance(Math.floor(rnd() * 4000));
        await env.game.cashOut(u).catch(() => {});
      }
    }
    env.clock.advance(10 * 60 * 1000);
    await env.game.tick();
  }
  await env.game.reconcile();
  for (const u of users) {
    const rows = await env.db.all('SELECT type, amount FROM wallet_transactions WHERE user_id = ?', [u.id]);
    const net = rows.reduce((s, r) => s + (r.type === 'debit' ? -r.amount : r.amount), 0);
    assert.equal(net, await env.wallet.getBalance(u.id));
    // And against the bets table: balance = start - sum(stakes of non-void) + sum(payouts)
    const bets = await env.db.all("SELECT amount, payout, status, settlement FROM bets WHERE user_id = ?", [u.id]);
    for (const b of bets) assert.equal(b.settlement === 'pending', false);
    const expected = 100000 - bets.filter((b) => b.status !== 'void' && b.status !== 'failed').reduce((s, b) => s + b.amount, 0) + bets.reduce((s, b) => s + b.payout, 0);
    assert.equal(await env.wallet.getBalance(u.id), expected);
  }
});

test('max payout cap is enforced', async () => {
  const env = await createEnv({ MAX_PAYOUT: '15000' });
  const u = await makeUser(env);
  await startRound(env, 100000);
  await env.game.placeBet(u, { amount: 10000, autoX100: 500, clientRef: ref() });
  await run(env);
  env.clock.advance(timeToReachMs(500, env.config.game.growthRate) + 5);
  await env.game.tick();
  const row = await env.db.get('SELECT payout FROM bets WHERE user_id = ?', [u.id]);
  assert.equal(row.payout, 15000);
});

test('events: betting, running, tick, bet, cashout, crashed are emitted in order', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  const list = events(env);
  await startRound(env, 400);
  await env.game.placeBet(u, { amount: 1000, clientRef: ref() });
  await run(env);
  env.clock.advance(500);
  await env.game.tick();
  env.clock.advance(timeToReachMs(150, env.config.game.growthRate));
  await env.game.cashOut(u);
  env.clock.advance(60_000);
  await env.game.tick();
  const types = list.map((e) => e.type).filter((t) => t !== 'balance');
  assert.deepEqual(types, ['betting', 'bet', 'running', 'tick', 'cashout', 'crashed']);
  const crashed = list.find((e) => e.type === 'crashed');
  assert.equal(crashed.crashX100, 400);
});
