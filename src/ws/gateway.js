'use strict';

const crypto = require('node:crypto');
const { DomainError } = require('../lib/errors');
const { RateLimiter } = require('../lib/ratelimit');
const { SESSION_COOKIE, parseCookies, originAllowed } = require('../lib/security');

const OPEN = 1;
const MAX_CONN_PER_IP = 20;

/**
 * WebSocket gateway.
 *
 * Client -> server messages (JSON):  {id, type:'bet', amount, autoX100, clientRef} | {id, type:'cashout'} | {type:'sync'} | {type:'ping'}
 * Server -> client:                   hello | betting | running | tick | bet | cashout | crashed | balance | reply | pong
 *
 * Security notes:
 *  - the user is derived from the session cookie at connect time and re-validated (expiry/revocation) on every action;
 *  - the client can only ask; the server decides amounts, multipliers and balances;
 *  - messages are size-limited, schema-validated and rate limited per connection.
 */
class Gateway {
  constructor({ game, auth, wallet, config, logger = console, now = () => Date.now() }) {
    this.game = game;
    this.auth = auth;
    this.wallet = wallet;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.clients = new Set();
    this.byUser = new Map(); // userId -> Set(client)
    this.byIp = new Map();
    this.msgLimiter = new RateLimiter({ limit: 25, windowMs: 5000 });
    this.lastBalance = new Map();

    game.on('event', (e) => this._onGameEvent(e));
    auth.on('session_revoked', ({ tokenHash }) => {
      for (const c of [...this.clients]) if (c.tokenHash === tokenHash) this._close(c, 4001, 'logged out');
    });
  }

  // ------------------------------------------------------------ plumbing

  /** Attach to a Node http.Server (uses the "ws" package). */
  attach(server) {
    const { WebSocketServer } = require('ws');
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      this._authorizeUpgrade(req)
        .then((ctx) => {
          if (!ctx) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return socket.destroy();
          }
          this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, ctx));
        })
        .catch((e) => {
          this.logger.error('[ws] upgrade failed', e);
          socket.destroy();
        });
    });
    this._heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (c.alive === false) {
          this._close(c, 4002, 'timeout');
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30000);
    this._balancePoll = setInterval(() => this._pollBalances().catch(() => {}), this.config.wallet.balancePollMs);
    for (const t of [this._heartbeat, this._balancePoll]) if (t.unref) t.unref();
  }

  async _authorizeUpgrade(req) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return null;
    if (!originAllowed(req.headers.origin, req.headers.host, this.config.allowedOrigins)) return null;
    const ip = req.socket.remoteAddress || 'unknown';
    const cookies = parseCookies(req.headers.cookie);
    const s = cookies[SESSION_COOKIE] ? await this.auth.resolveSession(cookies[SESSION_COOKIE]) : null;
    return { user: s ? s.user : null, tokenHash: s ? s.tokenHash : null, expiresAt: s ? s.expiresAt : null, ip };
  }

  /** Register a connected socket. `ws` only needs send/close/on-style methods, so tests can pass a fake. */
  connect(ws, { user, tokenHash, expiresAt, ip }) {
    const count = this.byIp.get(ip) || 0;
    if (count >= MAX_CONN_PER_IP) {
      try {
        ws.close(4008, 'too many connections');
      } catch {
        /* ignore */
      }
      return null;
    }
    const client = { id: crypto.randomUUID(), ws, user, tokenHash, expiresAt, ip, alive: true };
    this.clients.add(client);
    this.byIp.set(ip, count + 1);
    if (user) {
      if (!this.byUser.has(user.id)) this.byUser.set(user.id, new Set());
      this.byUser.get(user.id).add(client);
    }
    if (typeof ws.on === 'function') {
      ws.on('message', (data) => this.handleMessage(client, typeof data === 'string' ? data : data.toString()));
      ws.on('close', () => this._remove(client));
      ws.on('error', () => this._remove(client));
      ws.on('pong', () => (client.alive = true));
    }
    this._sendHello(client).catch((e) => this.logger.error('[ws] hello failed', e));
    return client;
  }

  _remove(client) {
    if (!this.clients.delete(client)) return;
    const c = (this.byIp.get(client.ip) || 1) - 1;
    if (c <= 0) this.byIp.delete(client.ip);
    else this.byIp.set(client.ip, c);
    if (client.user) {
      const set = this.byUser.get(client.user.id);
      if (set) {
        set.delete(client);
        if (!set.size) {
          this.byUser.delete(client.user.id);
          this.lastBalance.delete(client.user.id);
        }
      }
    }
  }

  _close(client, code, reason) {
    try {
      client.ws.close(code, reason);
    } catch {
      /* ignore */
    }
    this._remove(client);
  }

  _send(client, obj) {
    const ws = client.ws;
    if (ws.readyState !== undefined && ws.readyState !== OPEN) return;
    if (ws.bufferedAmount !== undefined && ws.bufferedAmount > 1_000_000) return this._close(client, 1013, 'slow consumer');
    try {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }

  async _sendHello(client) {
    const snapshot = this.game.snapshot(client.user && client.user.id);
    let me = null;
    if (client.user) {
      const balance = await this.wallet.getBalance(client.user.id);
      this.lastBalance.set(client.user.id, balance);
      me = { username: client.user.username, handle: client.user.handle, balance };
    }
    this._send(client, {
      type: 'hello',
      serverTime: this.now(),
      snapshot,
      me,
      wallet: { mode: this.wallet.mode, currency: this.wallet.currency },
    });
  }

  // -------------------------------------------------------- game -> clients

  _onGameEvent(event) {
    if (event.type === 'balance') return this.pushBalance(event.userId);
    const payload = JSON.stringify(event);
    for (const c of this.clients) this._send(c, payload);
  }

  /** Read the authoritative balance from the wallet and push it to the user's open sockets. */
  async pushBalance(userId) {
    const set = this.byUser.get(userId);
    if (!set || !set.size) return;
    try {
      const balance = await this.wallet.getBalance(userId);
      this.lastBalance.set(userId, balance);
      const payload = JSON.stringify({ type: 'balance', balance });
      for (const c of set) this._send(c, payload);
    } catch (e) {
      this.logger.error('[ws] balance push failed', e && e.message);
    }
  }

  /** Catches balance changes that did not originate from the game (e.g. deposits on the website). */
  async _pollBalances() {
    for (const userId of [...this.byUser.keys()]) {
      try {
        const balance = await this.wallet.getBalance(userId);
        if (this.lastBalance.get(userId) !== balance) {
          this.lastBalance.set(userId, balance);
          const payload = JSON.stringify({ type: 'balance', balance });
          for (const c of this.byUser.get(userId) || []) this._send(c, payload);
        }
      } catch {
        /* wallet hiccup: try again next interval */
      }
    }
  }

  // ------------------------------------------------------ client -> server

  async handleMessage(client, raw) {
    if (typeof raw !== 'string' || raw.length > 1024) return this._close(client, 1009, 'message too big');
    const rl = this.msgLimiter.hit(client.id);
    if (!rl.ok) {
      return this._send(client, { type: 'reply', ok: false, error: 'rate_limited', message: 'Slow down' });
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this._send(client, { type: 'reply', ok: false, error: 'bad_json' });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this._send(client, { type: 'reply', ok: false, error: 'bad_message' });
    const id = typeof msg.id === 'string' && msg.id.length <= 64 ? msg.id : null;
    const reply = (ok, data) => this._send(client, { type: 'reply', id, ok, ...data });

    try {
      switch (msg.type) {
        case 'ping':
          return this._send(client, { type: 'pong', serverTime: this.now() });
        case 'sync':
          return await this._sendHello(client);
        case 'bet': {
          const user = this._requireUser(client);
          const out = await this.game.placeBet(user, {
            amount: msg.amount,
            autoX100: msg.autoX100 === undefined ? null : msg.autoX100,
            clientRef: msg.clientRef,
          });
          return reply(true, { action: 'bet', bet: out.bet, balance: out.balance, duplicate: out.duplicate });
        }
        case 'cashout': {
          const user = this._requireUser(client);
          const out = await this.game.cashOut(user);
          return reply(true, { action: 'cashout', x100: out.x100, payout: out.payout, balance: out.balance });
        }
        default:
          return reply(false, { error: 'unknown_type' });
      }
    } catch (e) {
      if (e instanceof DomainError || (e && e.publicCode)) {
        return reply(false, { error: e.publicCode, message: e.message, ...(e.extra || {}) });
      }
      this.logger.error('[ws] handler error', e);
      return reply(false, { error: 'internal_error' });
    }
  }

  _requireUser(client) {
    if (!client.user) throw new DomainError('unauthorized', 'Please log in to play', 401);
    if (client.expiresAt && client.expiresAt <= this.now()) {
      throw new DomainError('session_expired', 'Session expired, please log in again', 401);
    }
    return client.user;
  }
}

module.exports = { Gateway };
