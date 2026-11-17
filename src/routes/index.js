'use strict';

const { AppError, wrap } = require('../lib/errors');
const { RateLimiter } = require('../lib/ratelimit');
const { serializeSessionCookie, SESSION_COOKIE } = require('../lib/security');
const { attachUser, requireAuth, csrfGuard, rateLimit, parsePaging } = require('./middleware');

/**
 * Registers every REST route on `router` (an express.Router, or the in-memory router used by tests).
 * deps: { db, config, auth, wallet, game, limits, audit, chains, logger, gateway? }
 */
function registerRoutes(router, deps) {
  const { db, config, auth, wallet, game, limits, audit, chains } = deps;
  const logger = deps.logger || console;
  const w = (fn) => wrap(fn, logger);

  const apiLimiter = new RateLimiter({ limit: 300, windowMs: 60_000 });
  const authLimiter = new RateLimiter({ limit: 20, windowMs: 60_000 });
  const actionLimiter = new RateLimiter({ limit: 60, windowMs: 60_000 });

  const walletInfo = async (userId) => ({
    mode: wallet.mode,
    currency: wallet.currency,
    supportsTopup: wallet.supportsTopup,
    balance: userId ? await wallet.getBalance(userId) : null,
  });

  const setSessionCookie = (res, token, expiresAt) => {
    const maxAgeSec = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    res.setHeader('Set-Cookie', serializeSessionCookie(token, { maxAgeSec, secure: config.cookieSecure }));
  };
  const clearSessionCookie = (res) => {
    res.setHeader('Set-Cookie', serializeSessionCookie('', { maxAgeSec: 0, secure: config.cookieSecure }));
  };

  // The router is mounted at "/" (so /healthz and /api/* share it), but the API middleware must NOT run for
  // static files that fall through to express.static - otherwise page loads would hit the rate limiter and the DB.
  const apiOnly = (mw) => (req, res, next) => (String(req.path || '').startsWith('/api') ? mw(req, res, next) : next());
  router.use(apiOnly(rateLimit(apiLimiter)));
  router.use(apiOnly(csrfGuard({ config })));
  router.use(apiOnly(attachUser({ auth, logger })));

  // ------------------------------------------------------------------ meta
  router.get('/healthz', (req, res) => res.json({ ok: true, walletMode: wallet.mode }));

  router.get(
    '/api/me',
    w(async (req, res) => {
      res.json({
        user: req.user ? { id: req.user.id, username: req.user.username, handle: req.user.handle, locale: req.user.locale } : null,
        wallet: await walletInfo(req.user && req.user.id),
        rg: req.user ? await limits.get(req.user.id) : null,
      });
    })
  );

  // ------------------------------------------------------------------ auth
  router.post(
    '/api/auth/register',
    rateLimit(authLimiter),
    w(async (req, res) => {
      const b = req.body || {};
      const out = await auth.register({
        username: b.username,
        password: b.password,
        ageConfirmed: b.ageConfirmed === true,
        locale: b.locale,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      setSessionCookie(res, out.token, out.expiresAt);
      res.status(201).json({ user: { id: out.user.id, username: out.user.username, handle: out.user.handle, locale: out.user.locale }, wallet: await walletInfo(out.user.id) });
    })
  );

  router.post(
    '/api/auth/login',
    rateLimit(authLimiter),
    w(async (req, res) => {
      const b = req.body || {};
      const out = await auth.login({ username: b.username, password: b.password, ip: req.ip, userAgent: req.headers['user-agent'] });
      setSessionCookie(res, out.token, out.expiresAt);
      res.json({ user: { id: out.user.id, username: out.user.username, handle: out.user.handle, locale: out.user.locale }, wallet: await walletInfo(out.user.id) });
    })
  );

  router.post(
    '/api/auth/logout',
    w(async (req, res) => {
      if (req.sessionToken) await auth.logout(req.sessionToken, req.ip);
      clearSessionCookie(res);
      res.json({ ok: true });
    })
  );

  router.post(
    '/api/locale',
    requireAuth,
    w(async (req, res) => {
      await auth.setLocale(req.user.id, (req.body || {}).locale);
      res.json({ ok: true });
    })
  );

  // ---------------------------------------------------------------- wallet
  router.get(
    '/api/wallet',
    requireAuth,
    w(async (req, res) => res.json(await walletInfo(req.user.id)))
  );

  router.post(
    '/api/wallet/test-topup',
    requireAuth,
    rateLimit(actionLimiter, (req) => req.user.id),
    w(async (req, res) => {
      if (!wallet.supportsTopup || typeof wallet.topup !== 'function') {
        throw new AppError('not_available', 404, 'Not available');
      }
      const r = await wallet.topup(req.user.id);
      await audit.log(req.user.id, 'wallet.test_topup', { balance: r.balance });
      if (deps.gateway) deps.gateway.pushBalance(req.user.id);
      res.json({ balance: r.balance, currency: wallet.currency });
    })
  );

  router.get(
    '/api/transactions',
    requireAuth,
    w(async (req, res) => {
      if (typeof wallet.listTransactions !== 'function') return res.json({ items: [] });
      const { limit, offset } = parsePaging(req.query);
      const rows = await wallet.listTransactions(req.user.id, { limit, offset });
      res.json({
        items: rows.map((r) => ({ id: r.id, type: r.type, amount: r.amount, balanceAfter: r.balance_after, createdAt: r.created_at })),
      });
    })
  );

  // --------------------------------------------------------------- history
  router.get(
    '/api/history/bets',
    requireAuth,
    w(async (req, res) => {
      const { limit, offset } = parsePaging(req.query);
      const rows = await db.all(
        `SELECT b.id, b.amount, b.auto_x100, b.status, b.cashout_x100, b.payout, b.created_at,
                r.number AS round_number, r.crash_x100, r.round_hash
           FROM bets b JOIN rounds r ON r.id = b.round_id
          WHERE b.user_id = ? AND b.status IN ('cashed','lost','active','void')
          ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`,
        [req.user.id, limit, offset]
      );
      res.json({
        items: rows.map((r) => ({
          id: r.id,
          roundNumber: r.round_number,
          amount: r.amount,
          autoX100: r.auto_x100,
          status: r.status,
          cashoutX100: r.cashout_x100,
          payout: r.payout,
          crashX100: r.crash_x100,
          hash: r.round_hash,
          createdAt: r.created_at,
        })),
      });
    })
  );

  router.get(
    '/api/stats',
    requireAuth,
    w(async (req, res) => {
      const s = await db.get(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS wagered, COALESCE(SUM(payout),0) AS won,
                COALESCE(SUM(CASE WHEN status = 'cashed' THEN 1 ELSE 0 END),0) AS wins,
                COALESCE(MAX(cashout_x100),0) AS best
           FROM bets WHERE user_id = ? AND status IN ('cashed','lost')`,
        [req.user.id]
      );
      const last = await db.all(
        "SELECT amount, payout FROM bets WHERE user_id = ? AND status IN ('cashed','lost') ORDER BY created_at DESC, id DESC LIMIT 50",
        [req.user.id]
      );
      let run = 0;
      const series = last
        .reverse()
        .map((b) => (run += b.payout - b.amount));
      res.json({
        bets: Number(s.n),
        wagered: Number(s.wagered),
        won: Number(s.won),
        net: Number(s.won) - Number(s.wagered),
        wins: Number(s.wins),
        winRate: Number(s.n) ? Number(s.wins) / Number(s.n) : 0,
        bestMultiplierX100: Number(s.best),
        series,
      });
    })
  );

  router.get(
    '/api/activity',
    requireAuth,
    w(async (req, res) => {
      const { limit, offset } = parsePaging(req.query);
      const items = await audit.listForActor(req.user.id, { limit, offset });
      res.json({ items });
    })
  );

  // --------------------------------------------- responsible gambling
  router.get(
    '/api/rg',
    requireAuth,
    w(async (req, res) => {
      res.json({ ...(await limits.get(req.user.id)), lossLast24h: await limits.lossLast24h(req.user.id) });
    })
  );

  router.post(
    '/api/rg/limits',
    requireAuth,
    rateLimit(actionLimiter, (req) => req.user.id),
    w(async (req, res) => {
      const b = req.body || {};
      const changes = {};
      for (const k of ['maxBet', 'dailyLossLimit', 'sessionReminderMin']) {
        if (Object.prototype.hasOwnProperty.call(b, k)) changes[k] = b[k];
      }
      res.json(await limits.update(req.user.id, changes));
    })
  );

  router.post(
    '/api/rg/exclude',
    requireAuth,
    rateLimit(actionLimiter, (req) => req.user.id),
    w(async (req, res) => {
      const days = (req.body || {}).days;
      if ((req.body || {}).confirm !== true) throw new AppError('confirm_required', 400, 'Confirmation required');
      res.json(await limits.selfExclude(req.user.id, days));
    })
  );

  // ------------------------------------------------------------------ game
  router.get(
    '/api/game/state',
    w(async (req, res) => {
      res.json(game.snapshot(req.user && req.user.id));
    })
  );

  router.get(
    '/api/history/rounds',
    w(async (req, res) => {
      const { limit, offset } = parsePaging(req.query, { defLimit: 30 });
      const rows = await db.all(
        "SELECT number, crash_x100, round_hash, crashed_at FROM rounds WHERE status = 'crashed' ORDER BY number DESC LIMIT ? OFFSET ?",
        [limit, offset]
      );
      res.json({ items: rows.map((r) => ({ number: r.number, crashX100: r.crash_x100, hash: r.round_hash, crashedAt: r.crashed_at })) });
    })
  );

  router.get(
    '/api/fair',
    w(async (req, res) => {
      res.json(await chains.publicInfo());
    })
  );
}

module.exports = { registerRoutes, SESSION_COOKIE };
