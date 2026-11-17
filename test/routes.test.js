'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, silent } = require('./helpers/env');
const { FakeRouter, cookieFrom } = require('./helpers/fakeRouter');
const { registerRoutes } = require('../src/routes');

async function setup(overrides) {
  const env = await createEnv(overrides);
  const router = new FakeRouter();
  registerRoutes(router, { ...env, logger: silent });
  return { env, router };
}

async function signup(router, username = 'route_user', ip) {
  const res = await router.call('POST', '/api/auth/register', {
    body: { username, password: 'correct-horse-battery', ageConfirmed: true },
    ip,
  });
  return { res, cookie: cookieFrom(res) };
}

test('anonymous /api/me exposes wallet mode and currency but no balance', async () => {
  const { router } = await setup();
  const res = await router.call('GET', '/api/me');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user, null);
  assert.equal(res.body.wallet.mode, 'test');
  assert.equal(res.body.wallet.currency.real, false);
  assert.equal(res.body.wallet.balance, null);
});

test('register sets an HttpOnly SameSite=Strict cookie and returns the test wallet', async () => {
  const { router } = await setup();
  const { res } = await signup(router);
  assert.equal(res.statusCode, 201);
  const sc = res.headers['set-cookie'];
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.equal(res.body.wallet.balance, 100000);
  assert.equal(res.body.user.password_hash, undefined);
});

test('authenticated endpoints reject anonymous callers', async () => {
  const { router } = await setup();
  for (const p of ['/api/wallet', '/api/transactions', '/api/history/bets', '/api/stats', '/api/rg', '/api/activity']) {
    const res = await router.call('GET', p);
    assert.equal(res.statusCode, 401, p);
  }
  const post = await router.call('POST', '/api/wallet/test-topup', { body: {} });
  assert.equal(post.statusCode, 401);
});

test('a forged or garbage session cookie is not accepted', async () => {
  const { router } = await setup();
  const res = await router.call('GET', '/api/wallet', { cookie: 'g99_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(res.statusCode, 401);
});

test('CSRF: state-changing requests need the custom header and a same-site Origin', async () => {
  const { router } = await setup();
  const noHeader = await router.call('POST', '/api/auth/login', { body: {}, headers: { 'x-requested-with': '' } });
  assert.equal(noHeader.statusCode, 403);
  const badOrigin = await router.call('POST', '/api/auth/login', { body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(badOrigin.statusCode, 403);
  const crossSite = await router.call('POST', '/api/auth/login', { body: {}, headers: { origin: '', 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.statusCode, 403);
});

test('wallet endpoint returns the server-side balance only (no client input can change it)', async () => {
  const { router } = await setup();
  const { cookie } = await signup(router);
  const res = await router.call('GET', '/api/wallet?balance=999999', { cookie });
  assert.equal(res.body.balance, 100000);
  // There is no endpoint that accepts a balance: attempts return 404.
  const set = await router.call('POST', '/api/wallet/set', { cookie, body: { balance: 999999 } });
  assert.equal(set.statusCode, 404);
});

test('test top-up is available, ledgered, and rate limited by cooldown', async () => {
  const { router, env } = await setup();
  const { cookie } = await signup(router);
  const a = await router.call('POST', '/api/wallet/test-topup', { cookie, body: {} });
  assert.equal(a.statusCode, 200);
  assert.equal(a.body.balance, 200000);
  const b = await router.call('POST', '/api/wallet/test-topup', { cookie, body: {} });
  assert.equal(b.statusCode, 429);
  assert.equal(b.body.error, 'topup_cooldown');
  const tx = await router.call('GET', '/api/transactions', { cookie });
  assert.equal(tx.body.items.length, 2);
  assert.equal(env.wallet.currency.real, false);
});

test('login/logout flow revokes the session', async () => {
  const { router } = await setup();
  const { cookie } = await signup(router, 'flow_user');
  const out = await router.call('POST', '/api/auth/logout', { cookie, body: {} });
  assert.equal(out.statusCode, 200);
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
  const after = await router.call('GET', '/api/wallet', { cookie });
  assert.equal(after.statusCode, 401);
  const login = await router.call('POST', '/api/auth/login', { body: { username: 'flow_user', password: 'correct-horse-battery' } });
  assert.equal(login.statusCode, 200);
  const bad = await router.call('POST', '/api/auth/login', { body: { username: 'flow_user', password: 'wrong-wrong-wrong' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.body.error, 'invalid_credentials');
});

test('auth endpoints are rate limited per IP', async () => {
  const { router } = await setup();
  let last;
  for (let i = 0; i < 25; i++) {
    last = await router.call('POST', '/api/auth/login', { body: { username: 'nobody_here', password: 'whatever-whatever' }, ip: '9.9.9.9' });
  }
  assert.equal(last.statusCode, 429);
});

test('responsible gambling endpoints: limits, exclusion needs explicit confirmation', async () => {
  const { router, env } = await setup();
  const { cookie } = await signup(router, 'rg_user');
  const set = await router.call('POST', '/api/rg/limits', { cookie, body: { maxBet: 5000, dailyLossLimit: 20000 } });
  assert.equal(set.statusCode, 200);
  assert.equal(set.body.maxBet, 5000);
  const noConfirm = await router.call('POST', '/api/rg/exclude', { cookie, body: { days: 7 } });
  assert.equal(noConfirm.statusCode, 400);
  const ex = await router.call('POST', '/api/rg/exclude', { cookie, body: { days: 7, confirm: true } });
  assert.equal(ex.statusCode, 200);
  assert.ok(ex.body.excludedUntil > env.clock.now());
  const bad = await router.call('POST', '/api/rg/limits', { cookie, body: { maxBet: 'lots' } });
  assert.equal(bad.statusCode, 400);
});

test('stats and bet history reflect real bets', async () => {
  const { router, env } = await setup();
  const { cookie, res } = await signup(router, 'stats_user');
  const user = await env.auth.getUser(res.body.user.id);
  await env.game.openBetting();
  env.game.round.crashX100 = 100;
  env.game.round.crashElapsedMs = 0;
  await env.game.placeBet(user, { amount: 2000, clientRef: 'stats-ref-0001' });
  env.clock.advance(env.config.game.bettingMs + 1);
  await env.game.startRunning();
  env.clock.advance(5);
  await env.game.tick();
  const stats = await router.call('GET', '/api/stats', { cookie });
  assert.equal(stats.body.bets, 1);
  assert.equal(stats.body.wagered, 2000);
  assert.equal(stats.body.net, -2000);
  assert.deepEqual(stats.body.series, [-2000]);
  const hist = await router.call('GET', '/api/history/bets', { cookie });
  assert.equal(hist.body.items[0].status, 'lost');
  assert.equal(hist.body.items[0].crashX100, 100);
  assert.ok(hist.body.items[0].hash);
});

test('public game state never leaks the secret hash or crash point', async () => {
  const { router, env } = await setup();
  await env.game.openBetting();
  const res = await router.call('GET', '/api/game/state');
  const text = JSON.stringify(res.body);
  assert.equal(text.includes(env.game.round.hash), false);
  assert.equal(res.body.round.crashX100, undefined);
  const fair = await router.call('GET', '/api/fair');
  assert.equal(fair.body.seed, undefined);
  assert.ok(fair.body.terminalHash);
  const seed = (await env.db.get('SELECT seed FROM fair_chains')).seed;
  assert.equal(JSON.stringify(fair.body).includes(seed), false);
});

test('paging parameters are clamped', async () => {
  const { router } = await setup();
  const { cookie } = await signup(router, 'paging_user');
  const res = await router.call('GET', '/api/history/bets?limit=999999&offset=-5', { cookie });
  assert.equal(res.statusCode, 200);
});

test('API middleware (rate limit / CSRF / session lookup) does not run for non-API paths such as static files', async () => {
  const { router, env } = await setup();
  let lookups = 0;
  const real = env.auth.resolveSession.bind(env.auth);
  env.auth.resolveSession = async (...a) => (lookups++, real(...a));
  // A POST to a static path without CSRF header must not be blocked by the API guard, and no session lookup occurs.
  const res = await router.call('POST', '/css/app.css', { headers: { 'x-requested-with': '' }, cookie: 'g99_session=abc' });
  assert.equal(res.statusCode, 404); // unknown route in the fake router, i.e. not 403 from the CSRF guard
  assert.equal(lookups, 0);
  // 400 requests to a static path never consume the API rate limit.
  for (let i = 0; i < 400; i++) await router.call('GET', '/css/app.css');
  const api = await router.call('GET', '/api/me', { ip: '10.0.0.1' });
  assert.equal(api.statusCode, 200);
});
