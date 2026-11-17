'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, makeUser } = require('./helpers/env');
const { TEST_CURRENCY } = require('../src/wallet/TestWalletAdapter');

test('test wallet is clearly labelled as non-real money', async () => {
  const env = await createEnv();
  assert.equal(env.wallet.mode, 'test');
  assert.equal(env.wallet.currency.real, false);
  assert.equal(TEST_CURRENCY.label, 'Test Credits');
});

test('new accounts receive the starting test credits through a ledger entry', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  assert.equal(await env.wallet.getBalance(u.id), 100000);
  const tx = await env.wallet.listTransactions(u.id);
  assert.equal(tx.length, 1);
  assert.equal(tx[0].type, 'grant');
  assert.equal(tx[0].balance_after, 100000);
});

test('debit and credit move the balance exactly and write balance_after', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  const d = await env.wallet.debit(u.id, 2500, 'bet:one');
  assert.equal(d.balance, 97500);
  const c = await env.wallet.credit(u.id, 5000, 'win:one');
  assert.equal(c.balance, 102500);
  assert.equal(await env.wallet.getBalance(u.id), 102500);
});

test('balance can never go negative', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await assert.rejects(env.wallet.debit(u.id, 100001, 'bet:big'), { publicCode: 'insufficient_funds' });
  assert.equal(await env.wallet.getBalance(u.id), 100000);
  await env.wallet.debit(u.id, 100000, 'bet:all');
  await assert.rejects(env.wallet.debit(u.id, 1, 'bet:more'), { publicCode: 'insufficient_funds' });
  assert.equal(await env.wallet.getBalance(u.id), 0);
});

test('duplicate reference is idempotent: effect applied once', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  const a = await env.wallet.debit(u.id, 1000, 'bet:dup');
  const b = await env.wallet.debit(u.id, 1000, 'bet:dup');
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(await env.wallet.getBalance(u.id), 99000);
  await env.wallet.credit(u.id, 500, 'win:dup');
  await env.wallet.credit(u.id, 500, 'win:dup');
  assert.equal(await env.wallet.getBalance(u.id), 99500);
});

test('reusing a reference with different parameters is rejected', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.wallet.debit(u.id, 1000, 'bet:x');
  await assert.rejects(env.wallet.debit(u.id, 2000, 'bet:x'), { publicCode: 'reference_conflict' });
  await assert.rejects(env.wallet.credit(u.id, 1000, 'bet:x'), { publicCode: 'reference_conflict' });
  const other = await makeUser(env);
  await assert.rejects(env.wallet.debit(other.id, 1000, 'bet:x'), { publicCode: 'reference_conflict' });
});

test('concurrent identical debits (same reference) apply exactly once', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  const results = await Promise.all(Array.from({ length: 20 }, () => env.wallet.debit(u.id, 1000, 'bet:race')));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(await env.wallet.getBalance(u.id), 99000);
});

test('concurrent different debits cannot overspend', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  // 30 x 5,000 = 150,000 but only 100,000 available -> exactly 20 may succeed.
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => env.wallet.debit(u.id, 5000, `bet:c${i}`)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 20);
  assert.equal(await env.wallet.getBalance(u.id), 0);
});

test('ledger reconciles: balance == sum(credits) - sum(debits)', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.wallet.debit(u.id, 1234, 'bet:r1');
  await env.wallet.credit(u.id, 4321, 'win:r1');
  await env.wallet.debit(u.id, 999, 'bet:r2');
  const rows = await env.db.all('SELECT type, amount FROM wallet_transactions WHERE user_id = ?', [u.id]);
  const net = rows.reduce((s, r) => s + (r.type === 'debit' ? -r.amount : r.amount), 0);
  assert.equal(net, await env.wallet.getBalance(u.id));
});

test('refund reverses a debit once, and is a no-op when no debit exists', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.wallet.debit(u.id, 3000, 'bet:rf');
  const r1 = await env.wallet.refund(u.id, 3000, 'refund:rf', { originalReference: 'bet:rf' });
  const r2 = await env.wallet.refund(u.id, 3000, 'refund:rf', { originalReference: 'bet:rf' });
  assert.equal(r1.refunded, true);
  assert.equal(r2.duplicate, true);
  assert.equal(await env.wallet.getBalance(u.id), 100000);
  const none = await env.wallet.refund(u.id, 3000, 'refund:ghost', { originalReference: 'bet:ghost' });
  assert.equal(none.refunded, false);
  assert.equal(await env.wallet.getBalance(u.id), 100000);
});

test('refund cannot be used to credit another user', async () => {
  const env = await createEnv();
  const a = await makeUser(env);
  const b = await makeUser(env);
  await env.wallet.debit(a.id, 1000, 'bet:mine');
  const r = await env.wallet.refund(b.id, 1000, 'refund:steal', { originalReference: 'bet:mine' });
  assert.equal(r.refunded, false);
  assert.equal(await env.wallet.getBalance(b.id), 100000);
});

test('invalid amounts are rejected (zero, negative, float, NaN)', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  for (const bad of [0, -5, 1.5, NaN, Infinity, '100', null]) {
    await assert.rejects(env.wallet.debit(u.id, bad, 'bet:bad' + String(bad)), { publicCode: 'bad_amount' });
  }
  assert.equal(await env.wallet.getBalance(u.id), 100000);
});

test('test top-up works, is cooldown limited, and is ledgered', async () => {
  const env = await createEnv();
  const u = await makeUser(env);
  await env.wallet.debit(u.id, 100000, 'bet:empty');
  const t = await env.wallet.topup(u.id);
  assert.equal(t.balance, 100000);
  await assert.rejects(env.wallet.topup(u.id), { publicCode: 'topup_cooldown' });
  env.clock.advance(61_000);
  const t2 = await env.wallet.topup(u.id);
  assert.equal(t2.balance, 200000);
});

test('real-money mode is blocked: config refuses it and the adapter is not implemented', async () => {
  const { loadConfig } = require('../src/config');
  assert.throws(() => loadConfig({ WALLET_MODE: 'external' }), /LEGAL_AUTHORIZATION_CONFIRMED/);
  const cfg = loadConfig({ WALLET_MODE: 'external', LEGAL_AUTHORIZATION_CONFIRMED: 'true' });
  const { createWallet } = require('../src/wallet');
  assert.throws(() => createWallet({ db: null, config: cfg }), /intentionally NOT implemented/);
});
