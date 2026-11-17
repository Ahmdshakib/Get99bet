'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, makeUser, ref } = require('./helpers/env');
const { hashPassword, verifyPassword } = require('../src/services/auth');
const { timeToReachMs } = require('../src/fair/engine');

// ------------------------------------------------------------------ auth

test('passwords are stored as salted scrypt hashes and verify correctly', async () => {
  const h1 = await hashPassword('correct-horse-battery');
  const h2 = await hashPassword('correct-horse-battery');
  assert.notEqual(h1, h2);
  assert.ok(h1.startsWith('scrypt$'));
  assert.ok(await verifyPassword('correct-horse-battery', h1));
  assert.ok(!(await verifyPassword('wrong-password-123', h1)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
});

test('register validates input and requires the 18+ confirmation', async () => {
  const env = await createEnv();
  const base = { password: 'correct-horse-battery', ageConfirmed: true };
  await assert.rejects(env.auth.register({ ...base, username: 'a' }), { publicCode: 'bad_username' });
  await assert.rejects(env.auth.register({ ...base, username: 'bad name!' }), { publicCode: 'bad_username' });
  await assert.rejects(env.auth.register({ ...base, username: 'okname', password: 'short' }), { publicCode: 'bad_password' });
  await assert.rejects(env.auth.register({ ...base, username: 'okname', ageConfirmed: false }), { publicCode: 'age_not_confirmed' });
  await env.auth.register({ ...base, username: 'OkName' });
  await assert.rejects(env.auth.register({ ...base, username: 'okname' }), { publicCode: 'username_taken' });
});

test('session tokens are random, stored only as hashes, and expire / revoke correctly', async () => {
  const env = await createEnv();
  const out = await env.auth.register({ username: 'sess_user', password: 'correct-horse-battery', ageConfirmed: true });
  const stored = await env.db.all('SELECT token_hash FROM sessions');
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, out.token);
  assert.ok((await env.auth.resolveSession(out.token)).user.username === 'sess_user');
  assert.equal(await env.auth.resolveSession('nope'), null);

  env.clock.advance(25 * 3600 * 1000);
  assert.equal(await env.auth.resolveSession(out.token), null); // expired

  const again = await env.auth.login({ username: 'SESS_USER', password: 'correct-horse-battery' });
  assert.ok(await env.auth.resolveSession(again.token));
  await env.auth.logout(again.token);
  assert.equal(await env.auth.resolveSession(again.token), null);
});

test('login: wrong password gives a generic error and locks after repeated failures', async () => {
  const env = await createEnv();
  await makeUser(env, 'lockme');
  for (let i = 0; i < 5; i++) {
    await assert.rejects(env.auth.login({ username: 'lockme', password: 'wrong-wrong-wrong' }), { publicCode: 'invalid_credentials' });
  }
  await assert.rejects(env.auth.login({ username: 'lockme', password: 'correct-horse-battery' }), { publicCode: 'account_locked' });
  env.clock.advance(16 * 60 * 1000);
  const ok = await env.auth.login({ username: 'lockme', password: 'correct-horse-battery' });
  assert.ok(ok.token);
  // Unknown user gets the same error as a wrong password.
  await assert.rejects(env.auth.login({ username: 'ghost_user', password: 'whatever-123456' }), { publicCode: 'invalid_credentials' });
});

// ---------------------------------------------------------------- limits

async function betAndLose(env, u, amount) {
  await env.game.openBetting();
  env.game.round.crashX100 = 100;
  env.game.round.crashElapsedMs = 0;
  await env.game.placeBet(u, { amount, clientRef: ref() });
  env.clock.advance(env.config.game.bettingMs + 1);
  await env.game.startRunning();
  env.clock.advance(10);
  await env.game.tick();
}

test('player max bet limit is enforced', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.limits.update(u.id, { maxBet: 5000 });
  await env.game.openBetting();
  await assert.rejects(env.game.placeBet(u, { amount: 5001, clientRef: ref() }), { publicCode: 'over_max_bet' });
  await env.game.placeBet(u, { amount: 5000, clientRef: ref() });
  assert.equal(await env.wallet.getBalance(u.id), 95000);
});

test('daily loss limit blocks bets that would exceed it', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.limits.update(u.id, { dailyLossLimit: 10000 });
  await betAndLose(env, u, 6000);
  env.clock.advance(5000);
  await env.game.openBetting();
  await assert.rejects(env.game.placeBet(u, { amount: 5000, clientRef: ref() }), { publicCode: 'daily_loss_limit' });
  await env.game.placeBet(u, { amount: 4000, clientRef: ref() }); // exactly reaches the limit
  // After 24h the window rolls over.
  env.clock.advance(25 * 3600 * 1000);
  assert.equal(await env.limits.lossLast24h(u.id), 0);
});

test('tightening a limit is immediate; loosening or removing it is delayed 24h', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  let s = await env.limits.update(u.id, { maxBet: 5000 });
  assert.equal(s.maxBet, 5000);
  s = await env.limits.update(u.id, { maxBet: 2000 });
  assert.equal(s.maxBet, 2000); // lower: immediate
  s = await env.limits.update(u.id, { maxBet: 9000 });
  assert.equal(s.maxBet, 2000); // higher: not yet
  assert.equal(s.pending.maxBet, 9000);
  s = await env.limits.update(u.id, { maxBet: null });
  assert.equal(s.maxBet, 2000);
  assert.equal(s.pending.maxBet, null);
  env.clock.advance(23 * 3600 * 1000);
  assert.equal((await env.limits.get(u.id)).maxBet, 2000);
  env.clock.advance(2 * 3600 * 1000);
  assert.equal((await env.limits.get(u.id)).maxBet, null); // now applied
});

test('self-exclusion blocks betting, cannot be shortened, and expires', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.limits.selfExclude(u.id, 7);
  await env.game.openBetting();
  await assert.rejects(env.game.placeBet(u, { amount: 1000, clientRef: ref() }), { publicCode: 'self_excluded' });
  const before = (await env.limits.get(u.id)).excludedUntil;
  await env.limits.selfExclude(u.id, 1); // attempt to shorten
  assert.equal((await env.limits.get(u.id)).excludedUntil, before);
  await assert.rejects(env.limits.selfExclude(u.id, 3), { publicCode: 'bad_exclusion' });
  env.clock.advance(8 * 24 * 3600 * 1000);
  assert.equal((await env.limits.get(u.id)).excludedUntil, null);
});

test('excluded player can still cash out an already open bet (never trapped)', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.game.openBetting();
  env.game.round.crashX100 = 5000;
  env.game.round.crashElapsedMs = timeToReachMs(5000, env.config.game.growthRate);
  await env.game.placeBet(u, { amount: 1000, clientRef: ref() });
  await env.limits.selfExclude(u.id, 1);
  env.clock.advance(env.config.game.bettingMs + 1);
  await env.game.startRunning();
  env.clock.advance(1000);
  const out = await env.game.cashOut(u);
  assert.ok(out.payout >= 1000);
});

test('limit input validation', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await assert.rejects(env.limits.update(u.id, { maxBet: -1 }), { publicCode: 'bad_limit' });
  await assert.rejects(env.limits.update(u.id, { maxBet: 1.5 }), { publicCode: 'bad_limit' });
  await assert.rejects(env.limits.update(u.id, { sessionReminderMin: 1 }), { publicCode: 'bad_limit' });
  const s = await env.limits.update(u.id, { sessionReminderMin: 45 });
  assert.equal(s.sessionReminderMin, 45);
});

// ----------------------------------------------------------------- audit

test('audit log is hash chained and detects tampering', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.limits.update(u.id, { maxBet: 5000 });
  await env.audit.log(u.id, 'custom.event', { a: 1 });
  const ok = await env.audit.verify();
  assert.equal(ok.ok, true);
  assert.ok(ok.checked >= 3);

  // Edit a historical row.
  await env.db.run("UPDATE audit_log SET data = '{\"a\":999}' WHERE event = 'custom.event'");
  const bad = await env.audit.verify();
  assert.equal(bad.ok, false);
  assert.ok(bad.brokenAt >= 1);
});

test('audit log detects deleted rows', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.audit.log(u.id, 'one', {});
  await env.audit.log(u.id, 'two', {});
  await env.audit.log(u.id, 'three', {});
  await env.db.run("DELETE FROM audit_log WHERE event = 'two'");
  assert.equal((await env.audit.verify()).ok, false);
});

test('audit never stores passwords or session tokens', async () => {
  const env = await createEnv();
  const out = await env.auth.register({ username: 'secretless', password: 'super-secret-password-1', ageConfirmed: true });
  const rows = await env.db.all('SELECT data, event FROM audit_log');
  const blob = JSON.stringify(rows);
  assert.equal(blob.includes('super-secret-password-1'), false);
  assert.equal(blob.includes(out.token), false);
});

test('game actions are audited (bet placed, cashed out, round crashed)', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.game.openBetting();
  env.game.round.crashX100 = 5000;
  env.game.round.crashElapsedMs = timeToReachMs(5000, env.config.game.growthRate);
  await env.game.placeBet(u, { amount: 1000, clientRef: ref() });
  env.clock.advance(env.config.game.bettingMs + 1);
  await env.game.startRunning();
  env.clock.advance(1500);
  await env.game.cashOut(u);
  env.clock.advance(120000);
  await env.game.tick();
  await new Promise((r) => setTimeout(r, 30));
  const events = (await env.db.all('SELECT event FROM audit_log')).map((r) => r.event);
  for (const e of ['user.register', 'bet.placed', 'bet.cashed_out', 'round.crashed']) assert.ok(events.includes(e), `missing ${e}`);
  assert.equal((await env.audit.verify()).ok, true);
});
