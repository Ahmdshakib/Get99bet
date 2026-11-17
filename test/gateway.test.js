'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, makeUser, silent, ref } = require('./helpers/env');
const { Gateway } = require('../src/ws/gateway');
const { timeToReachMs } = require('../src/fair/engine');

class FakeSocket {
  constructor() {
    this.sent = [];
    this.readyState = 1;
    this.closed = null;
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  last(type) {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

async function setup() {
  const env = await createEnv();
  const gw = new Gateway({ game: env.game, auth: env.auth, wallet: env.wallet, config: env.config, logger: silent, now: () => env.clock.now() });
  return { env, gw };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

async function connect(gw, user, ip = '1.1.1.1') {
  const ws = new FakeSocket();
  const client = gw.connect(ws, { user, tokenHash: user ? 'th-' + user.id : null, expiresAt: Date.now() + 3600_000, ip });
  await tick();
  return { ws, client };
}

test('hello carries the authoritative balance, wallet mode and currency; anonymous has no balance', async () => {
  const { env, gw } = await setup();
  const u = await makeUser(env);
  await env.game.openBetting();
  const a = await connect(gw, u);
  const hello = a.ws.last('hello');
  assert.equal(hello.me.balance, 100000);
  assert.equal(hello.wallet.mode, 'test');
  assert.equal(hello.wallet.currency.real, false);
  assert.equal(hello.snapshot.round.status, 'betting');
  const anon = await connect(gw, null, '2.2.2.2');
  assert.equal(anon.ws.last('hello').me, null);
});

test('bet over the socket debits the wallet and pushes the new balance', async () => {
  const { env, gw } = await setup();
  const u = await makeUser(env);
  await env.game.openBetting();
  const { ws, client } = await connect(gw, u);
  await gw.handleMessage(client, JSON.stringify({ id: 'r1', type: 'bet', amount: 5000, clientRef: ref() }));
  const reply = ws.last('reply');
  assert.equal(reply.ok, true);
  assert.equal(reply.id, 'r1');
  assert.equal(reply.balance, 95000);
  await tick();
  assert.equal(ws.last('balance').balance, 95000);
  assert.equal(await env.wallet.getBalance(u.id), 95000);
});

test('client-supplied balance / user fields are ignored', async () => {
  const { env, gw } = await setup();
  const u = await makeUser(env);
  const victim = await makeUser(env);
  await env.game.openBetting();
  const { ws, client } = await connect(gw, u);
  await gw.handleMessage(client, JSON.stringify({ id: 'x', type: 'bet', amount: 1000, clientRef: ref(), balance: 9999999, userId: victim.id, user: { id: victim.id } }));
  assert.equal(ws.last('reply').ok, true);
  assert.equal(await env.wallet.getBalance(victim.id), 100000);
  assert.equal(await env.wallet.getBalance(u.id), 99000);
});

test('anonymous sockets cannot bet or cash out', async () => {
  const { env, gw } = await setup();
  await env.game.openBetting();
  const { ws, client } = await connect(gw, null);
  await gw.handleMessage(client, JSON.stringify({ id: 'a', type: 'bet', amount: 1000, clientRef: ref() }));
  assert.equal(ws.last('reply').error, 'unauthorized');
  await gw.handleMessage(client, JSON.stringify({ id: 'b', type: 'cashout' }));
  assert.equal(ws.last('reply').error, 'unauthorized');
});

test('cash-out over the socket credits winnings, broadcasts, and pushes the balance', async () => {
  const { env, gw } = await setup();
  const u = await makeUser(env);
  await env.game.openBetting();
  env.game.round.crashX100 = 5000;
  env.game.round.crashElapsedMs = timeToReachMs(5000, env.config.game.growthRate);
  const watcher = await connect(gw, null, '3.3.3.3');
  const { ws, client } = await connect(gw, u);
  await gw.handleMessage(client, JSON.stringify({ id: '1', type: 'bet', amount: 10000, clientRef: ref() }));
  env.clock.advance(env.config.game.bettingMs + 1);
  await env.game.startRunning();
  env.clock.advance(timeToReachMs(200, env.config.game.growthRate) + 5);
  await gw.handleMessage(client, JSON.stringify({ id: '2', type: 'cashout' }));
  const r = ws.last('reply');
  assert.equal(r.ok, true);
  assert.ok(r.x100 >= 200);
  assert.equal(r.balance, 90000 + r.payout);
  await tick();
  assert.equal(ws.last('balance').balance, 90000 + r.payout);
  assert.ok(watcher.ws.sent.some((m) => m.type === 'cashout' && m.bet.payout === r.payout));
  // Public feed masks the username.
  const pub = watcher.ws.sent.find((m) => m.type === 'bet').bet;
  assert.ok(pub.name.includes('***'));
  assert.notEqual(pub.name, u.username);
});

test('malformed input is rejected safely: bad JSON, wrong types, oversized frames, unknown types', async () => {
  const { env, gw } = await setup();
  const u = await makeUser(env);
  await env.game.openBetting();
  const { ws, client } = await connect(gw, u);
  await gw.handleMessage(client, '{not json');
  assert.equal(ws.last('reply').error, 'bad_json');
  await gw.handleMessage(client, '[1,2]');
  assert.equal(ws.last('reply').error, 'bad_message');
  await gw.handleMessage(client, JSON.stringify({ id: 'q', type: 'bet', amount: '1000', clientRef: ref() }));
  assert.equal(ws.last('reply').error, 'bad_amount');
  await gw.handleMessage(client, JSON.stringify({ id: 'q', type: 'bet', amount: -5, clientRef: ref() }));
  assert.equal(ws.last('reply').error, 'bad_amount');
  await gw.handleMessage(client, JSON.stringify({ id: 'q', type: 'nope' }));
  assert.equal(ws.last('reply').error, 'unknown_type');
  assert.equal(await env.wallet.getBalance(u.id), 100000);
  await gw.handleMessage(client, 'x'.repeat(5000));
  assert.equal(ws.closed.code, 1009);
});

test('per-connection message rate limit', async () => {
  const { env, gw } = await setup();
  const u = await makeUser(env);
  const { ws, client } = await connect(gw, u);
  for (let i = 0; i < 40; i++) await gw.handleMessage(client, JSON.stringify({ type: 'ping' }));
  assert.ok(ws.sent.some((m) => m.error === 'rate_limited'));
});

test('expired session cannot act even on an open socket', async () => {
  const { env, gw } = await setup();
  const u = await makeUser(env);
  await env.game.openBetting();
  const ws = new FakeSocket();
  const client = gw.connect(ws, { user: u, tokenHash: 't', expiresAt: env.clock.now() - 1, ip: '4.4.4.4' });
  await tick();
  await gw.handleMessage(client, JSON.stringify({ id: 'e', type: 'bet', amount: 1000, clientRef: ref() }));
  assert.equal(ws.last('reply').error, 'session_expired');
});

test('logging out closes that session\'s sockets', async () => {
  const { env, gw } = await setup();
  const out = await env.auth.register({ username: 'closer_user', password: 'correct-horse-battery', ageConfirmed: true });
  const ws = new FakeSocket();
  const s = await env.auth.resolveSession(out.token);
  gw.connect(ws, { user: s.user, tokenHash: s.tokenHash, expiresAt: s.expiresAt, ip: '5.5.5.5' });
  await env.auth.logout(out.token);
  assert.equal(ws.closed.code, 4001);
});

test('balance poll picks up wallet changes made outside the game (e.g. website deposit)', async () => {
  const { env, gw } = await setup();
  const u = await makeUser(env);
  const { ws } = await connect(gw, u);
  await env.wallet.credit(u.id, 12345, 'external:deposit-1'); // simulates the website crediting the wallet
  await gw._pollBalances();
  assert.equal(ws.last('balance').balance, 112345);
});

test('connection cap per IP', async () => {
  const { env, gw } = await setup();
  let refused = 0;
  for (let i = 0; i < 25; i++) {
    const ws = new FakeSocket();
    const c = gw.connect(ws, { user: null, tokenHash: null, expiresAt: null, ip: '6.6.6.6' });
    if (!c) refused++;
  }
  assert.equal(refused, 5);
  assert.ok(env);
});
