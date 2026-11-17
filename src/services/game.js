'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Mutex } = require('../lib/mutex');
const { DomainError } = require('../lib/errors');
const { isValidAmount, payoutFor } = require('../lib/money');
const { crashPointX100, multiplierX100At, timeToReachMs } = require('../fair/engine');
const { maskName } = require('./auth');

/**
 * Round manager - the single authority for game state.
 *
 * Phases:  betting -> running -> crashed -> (pause) -> betting ...
 *
 * Money safety rules implemented here:
 *  - Stake is DEBITED through the wallet adapter before the bet becomes active.
 *  - A bet is settled exactly once: the DB row is flipped with a conditional UPDATE
 *    (WHERE status='active'), and the wallet credit uses the idempotency key
 *    "win:<betId>", so retries / double clicks / crashes cannot pay twice.
 *  - Settlement (wallet credit) is tracked in bets.settlement and retried by reconcile()
 *    until it succeeds, so a wallet outage can never lose a payout or double-pay it.
 *  - The multiplier at cash-out is computed by the SERVER clock; the client only requests.
 *  - A bet that cannot be activated in time (betting closed meanwhile) is refunded.
 *  - On restart, unfinished rounds are voided and every open stake is refunded (recover()).
 *
 * All state transitions run under one mutex; wallet calls are made OUTSIDE it.
 */
class GameError extends DomainError {}

class Game extends EventEmitter {
  constructor({ db, wallet, audit, limits, chains, config, clock = { now: () => Date.now() }, logger = console }) {
    super();
    this.db = db;
    this.wallet = wallet;
    this.audit = audit;
    this.limits = limits;
    this.chains = chains;
    this.cfg = config.game;
    this.clock = clock;
    this.logger = logger;
    this.lock = new Mutex();
    this.round = null;
    this.recent = []; // last finished rounds, newest first
    this.stopped = false;
    this._timer = null;
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    await this.recover();
    const rows = await this.db.all(
      "SELECT number, crash_x100, round_hash, id FROM rounds WHERE status = 'crashed' ORDER BY number DESC LIMIT ?",
      [this.cfg.recentRounds]
    );
    this.recent = rows.map((r) => ({ id: r.id, number: r.number, crashX100: r.crash_x100, hash: r.round_hash }));
  }

  /** Void interrupted rounds and refund every unsettled stake. Safe to call repeatedly. */
  async recover() {
    const open = await this.db.all("SELECT id FROM rounds WHERE status IN ('betting','running')");
    for (const r of open) {
      await this.db.run("UPDATE rounds SET status = 'void' WHERE id = ?", [r.id]);
      await this.db.run(
        "UPDATE bets SET status = 'void', settlement = 'pending', settled_at = ? WHERE round_id = ? AND status IN ('active','pending')",
        [this.clock.now(), r.id]
      );
      await this.audit.log('system', 'round.void_on_recovery', { roundId: r.id });
    }
    // Pending bets (debit may or may not have happened) in any round: treat as void; refund is a no-op if no debit exists.
    await this.db.run(
      "UPDATE bets SET status = 'void', settlement = 'pending', settled_at = ? WHERE status = 'pending'",
      [this.clock.now()]
    );
    await this.reconcile();
  }

  /** Start the autonomous round loop. */
  start() {
    this.stopped = false;
    this._loop().catch((e) => this.logger.error('[game] loop crashed', e));
    this._reconcileTimer = setInterval(() => this.reconcile().catch((e) => this.logger.error('[game] reconcile', e)), 15000);
    if (this._reconcileTimer.unref) this._reconcileTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._reconcileTimer) clearInterval(this._reconcileTimer);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._timer = setTimeout(resolve, ms);
    });
  }

  async _loop() {
    while (!this.stopped) {
      try {
        await this.openBetting();
        await this._sleep(this.cfg.bettingMs);
        if (this.stopped) break;
        await this.startRunning();
        while (!this.stopped && this.round.status === 'running') {
          const elapsed = this.clock.now() - this.round.startedAt;
          const untilCrash = this.round.crashElapsedMs - elapsed;
          await this._sleep(Math.max(1, Math.min(this.cfg.tickMs, Math.ceil(untilCrash))));
          await this.tick();
        }
        await this._sleep(this.cfg.crashPauseMs);
      } catch (e) {
        this.logger.error('[game] round error', e);
        await this._sleep(1000);
      }
    }
  }

  // ------------------------------------------------------------------- rounds

  openBetting() {
    return this.lock.run(async () => {
      const { chainId, index, hash, commitment } = await this.chains.next();
      const info = await this.chains.publicInfo();
      const crashX100 = crashPointX100(hash, info.clientSeed, this.cfg);
      const last = await this.db.get('SELECT MAX(number) AS n FROM rounds');
      const number = (last && last.n ? last.n : 0) + 1;
      const id = crypto.randomUUID();
      const now = this.clock.now();
      await this.db.run(
        'INSERT INTO rounds (id, number, chain_id, chain_index, status, bet_open_at) VALUES (?,?,?,?,?,?)',
        [id, number, chainId, index, 'betting', now]
      );
      this.round = {
        id,
        number,
        status: 'betting',
        hash, // secret until the round ends
        commitment,
        crashX100, // secret until the round ends
        crashElapsedMs: timeToReachMs(crashX100, this.cfg.growthRate),
        betOpenAt: now,
        bettingEndsAt: now + this.cfg.bettingMs,
        startedAt: null,
        crashedAt: null,
        bets: new Map(),
      };
      this._emit({ type: 'betting', round: this._publicRound() });
      return this._publicRound();
    });
  }

  startRunning() {
    return this.lock.run(async () => {
      const r = this.round;
      if (!r || r.status !== 'betting') throw new GameError('bad_phase', 'Round is not in betting phase');
      r.status = 'running';
      r.startedAt = this.clock.now();
      await this.db.run("UPDATE rounds SET status = 'running', started_at = ? WHERE id = ?", [r.startedAt, r.id]);
      this._emit({
        type: 'running',
        roundId: r.id,
        startedAt: r.startedAt,
        serverTime: r.startedAt,
        growthRate: this.cfg.growthRate,
      });
    });
  }

  /** Called periodically while running: pays auto cash-outs and crashes the round on time. */
  async tick() {
    let toSettle = [];
    await this.lock.run(async () => {
      const r = this.round;
      if (!r || r.status !== 'running') return;
      const elapsed = this.clock.now() - r.startedAt;
      if (elapsed >= r.crashElapsedMs) {
        toSettle = await this._crashLocked();
        return;
      }
      for (const bet of r.bets.values()) {
        if (bet.status === 'active' && bet.autoX100 && elapsed >= timeToReachMs(bet.autoX100, this.cfg.growthRate)) {
          if (await this._markCashed(bet, bet.autoX100)) toSettle.push(bet.id);
        }
      }
      this._emit({
        type: 'tick',
        roundId: r.id,
        elapsed,
        x100: multiplierX100At(elapsed, this.cfg.growthRate),
        serverTime: this.clock.now(),
      });
    });
    await this._settleMany(toSettle);
  }

  async _crashLocked() {
    const r = this.round;
    const toSettle = [];
    // Auto cash-outs whose target was reached before the crash are paid at their target.
    for (const bet of r.bets.values()) {
      if (bet.status === 'active' && bet.autoX100 && bet.autoX100 <= r.crashX100) {
        if (await this._markCashed(bet, bet.autoX100)) toSettle.push(bet.id);
      }
    }
    const now = this.clock.now();
    await this.db.run(
      "UPDATE bets SET status = 'lost', payout = 0, settlement = 'done', settled_at = ? WHERE round_id = ? AND status = 'active'",
      [now, r.id]
    );
    for (const bet of r.bets.values()) if (bet.status === 'active') bet.status = 'lost';
    await this.db.run(
      "UPDATE rounds SET status = 'crashed', crashed_at = ?, crash_x100 = ?, round_hash = ? WHERE id = ?",
      [now, r.crashX100, r.hash, r.id]
    );
    r.status = 'crashed';
    r.crashedAt = now;
    this.recent.unshift({ id: r.id, number: r.number, crashX100: r.crashX100, hash: r.hash });
    this.recent.length = Math.min(this.recent.length, this.cfg.recentRounds);
    this._emit({
      type: 'crashed',
      roundId: r.id,
      number: r.number,
      crashX100: r.crashX100,
      hash: r.hash,
      commitment: r.commitment,
      bets: [...r.bets.values()].map((b) => this._publicBet(b)),
    });
    this.audit
      .log('system', 'round.crashed', {
        roundId: r.id,
        number: r.number,
        crashX100: r.crashX100,
        bets: r.bets.size,
        wagered: [...r.bets.values()].reduce((s, b) => s + b.amount, 0),
      })
      .catch(() => {});
    return toSettle;
  }

  // --------------------------------------------------------------------- bets

  /**
   * Place a bet. Idempotent per (user, clientRef): retrying with the same clientRef
   * returns the original bet instead of charging twice.
   */
  async placeBet(user, { amount, autoX100 = null, clientRef }) {
    if (!isValidAmount(amount)) throw new GameError('bad_amount', 'Invalid bet amount');
    if (amount < this.cfg.minBet) throw new GameError('under_min_bet', 'Bet is below the minimum', 400, { minBet: this.cfg.minBet });
    if (amount > this.cfg.maxBet) throw new GameError('over_max_bet', 'Bet is above the maximum', 400, { maxBet: this.cfg.maxBet });
    if (autoX100 !== null && (!Number.isSafeInteger(autoX100) || autoX100 < 101 || autoX100 > this.cfg.maxMultiplierX100)) {
      throw new GameError('bad_auto_cashout', 'Auto cash-out must be between 1.01x and the maximum multiplier');
    }
    if (typeof clientRef !== 'string' || clientRef.length < 8 || clientRef.length > 64) {
      throw new GameError('bad_client_ref', 'clientRef must be 8-64 characters');
    }

    // Idempotent replay of an already accepted request.
    const prior = await this.db.get('SELECT * FROM bets WHERE user_id = ? AND client_ref = ?', [user.id, clientRef]);
    if (prior) {
      if (prior.amount !== amount) throw new GameError('client_ref_conflict', 'clientRef reused with different amount', 409);
      if (!['pending', 'active', 'cashed', 'lost'].includes(prior.status)) {
        throw new GameError('client_ref_used', 'clientRef was already used; send a new one', 409);
      }
      return { bet: this._publicBetFromRow(prior, user), duplicate: true, balance: await this.wallet.getBalance(user.id) };
    }

    await this.limits.assertCanBet(user.id, amount);

    // Stage 1 (locked): phase check + reserve the slot with a pending row.
    const betId = crypto.randomUUID();
    let roundId;
    await this.lock.run(async () => {
      const r = this.round;
      if (!r || r.status !== 'betting' || this.clock.now() >= r.bettingEndsAt) {
        throw new GameError('betting_closed', 'Betting is closed for this round');
      }
      if (r.bets.has(user.id)) throw new GameError('already_bet', 'You already have a bet in this round');
      try {
        await this.db.run(
          'INSERT INTO bets (id, round_id, user_id, client_ref, amount, auto_x100, status, payout, settlement, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [betId, r.id, user.id, clientRef, amount, autoX100, 'pending', 0, 'none', this.clock.now()]
        );
      } catch (e) {
        if (this.db.isUniqueViolation(e)) throw new GameError('already_bet', 'You already have a bet in this round');
        throw e;
      }
      r.bets.set(user.id, { id: betId, userId: user.id, handle: user.handle, name: maskName(user.username), amount, autoX100, status: 'pending', cashoutX100: null, payout: 0 });
      roundId = r.id;
    });

    // Stage 2 (unlocked): take the money. Idempotency key = bet:<betId>.
    let debit;
    try {
      debit = await this.wallet.debit(user.id, amount, `bet:${betId}`, { roundId, betId });
    } catch (e) {
      if (e && e.publicCode === 'insufficient_funds') {
        // Definitely no money moved.
        await this._dropPending(user.id, roundId, betId, 'failed');
      } else {
        // Ambiguous (e.g. timeout): the debit might have happened. Void the bet and let the
        // idempotent refund (a no-op when no debit exists) run now and on every reconcile pass.
        await this._refundBet(user.id, betId, amount, roundId);
      }
      throw e;
    }

    // Stage 3 (locked): activate, or refund if betting closed while we were debiting.
    let activatedBet = null;
    await this.lock.run(async () => {
      const r = this.round;
      const bet = r && r.id === roundId ? r.bets.get(user.id) : null;
      if (bet && bet.id === betId && r.status === 'betting') {
        const upd = await this.db.run("UPDATE bets SET status = 'active' WHERE id = ? AND status = 'pending'", [betId]);
        if (upd.changes === 1) {
          bet.status = 'active';
          activatedBet = bet;
          this._emit({ type: 'bet', roundId, bet: this._publicBet(bet) });
        }
      }
    });
    if (!activatedBet) {
      await this._refundBet(user.id, betId, amount, roundId);
      throw new GameError('betting_closed', 'Betting closed while your bet was processing; your stake was refunded');
    }
    await this.audit.log(user.id, 'bet.placed', { betId, roundId, amount, autoX100 });
    this._emit({ type: 'balance', userId: user.id });
    return { bet: this._publicBet(activatedBet), duplicate: false, balance: debit.balance };
  }

  async _dropPending(userId, roundId, betId, status) {
    await this.lock.run(async () => {
      await this.db.run("UPDATE bets SET status = ?, settlement = 'done', settled_at = ? WHERE id = ? AND status = 'pending'", [
        status,
        this.clock.now(),
        betId,
      ]);
      if (this.round && this.round.id === roundId) {
        const b = this.round.bets.get(userId);
        if (b && b.id === betId) this.round.bets.delete(userId);
      }
    });
  }

  async _refundBet(userId, betId, amount, roundId) {
    await this.lock.run(async () => {
      await this.db.run("UPDATE bets SET status = 'void', settlement = 'pending', settled_at = ? WHERE id = ? AND status IN ('pending','active')", [
        this.clock.now(),
        betId,
      ]);
      if (this.round && this.round.id === roundId) {
        const b = this.round.bets.get(userId);
        if (b && b.id === betId) this.round.bets.delete(userId);
      }
    });
    await this._settleMany([betId]);
  }

  /** Player asks to cash out. The multiplier is decided by the SERVER clock, never by the client. */
  async cashOut(user) {
    let betId = null;
    let result;
    await this.lock.run(async () => {
      const r = this.round;
      if (!r || r.status !== 'running') throw new GameError('not_running', 'No round in progress');
      const bet = r.bets.get(user.id);
      if (!bet || bet.status !== 'active') throw new GameError('no_active_bet', 'You have no active bet');
      const elapsed = this.clock.now() - r.startedAt;
      if (elapsed >= r.crashElapsedMs) throw new GameError('too_late', 'Too late - the round has crashed');
      const x100 = multiplierX100At(elapsed, this.cfg.growthRate);
      if (!(await this._markCashed(bet, x100))) throw new GameError('no_active_bet', 'You have no active bet');
      betId = bet.id;
      result = { x100, payout: bet.payout };
    });
    await this._settleMany([betId]);
    return { ...result, balance: await this.wallet.getBalance(user.id) };
  }

  /** Flip active -> cashed exactly once (conditional UPDATE). Must be called while holding the lock. */
  async _markCashed(bet, x100) {
    const payout = Math.min(payoutFor(bet.amount, x100), this.cfg.maxPayout);
    const upd = await this.db.run(
      "UPDATE bets SET status = 'cashed', cashout_x100 = ?, payout = ?, settlement = 'pending', settled_at = ? WHERE id = ? AND status = 'active'",
      [x100, payout, this.clock.now(), bet.id]
    );
    if (upd.changes !== 1) return false;
    bet.status = 'cashed';
    bet.cashoutX100 = x100;
    bet.payout = payout;
    this._emit({ type: 'cashout', roundId: this.round.id, bet: this._publicBet(bet) });
    return true;
  }

  // -------------------------------------------------------------- settlement

  async _settleMany(betIds) {
    for (const id of betIds) {
      try {
        await this.settleBet(id);
      } catch (e) {
        this.logger.error('[game] settlement failed, will retry', id, e && e.message);
      }
    }
  }

  /**
   * Make the wallet reflect a finished bet. Idempotent: safe to call any number of times.
   *  cashed -> credit(payout) with reference win:<id>
   *  void   -> refund(stake)  with reference refund:<id>
   */
  async settleBet(betId) {
    const bet = await this.db.get("SELECT * FROM bets WHERE id = ? AND settlement = 'pending'", [betId]);
    if (!bet) return false;
    if (bet.status === 'cashed') {
      if (bet.payout > 0) await this.wallet.credit(bet.user_id, bet.payout, `win:${bet.id}`, { betId: bet.id, roundId: bet.round_id, x100: bet.cashout_x100 });
    } else if (bet.status === 'void') {
      await this.wallet.refund(bet.user_id, bet.amount, `refund:${bet.id}`, { originalReference: `bet:${bet.id}`, betId: bet.id });
    } else {
      return false;
    }
    await this.db.run("UPDATE bets SET settlement = 'done' WHERE id = ? AND settlement = 'pending'", [betId]);
    await this.audit.log(bet.user_id, bet.status === 'cashed' ? 'bet.cashed_out' : 'bet.refunded', {
      betId: bet.id,
      roundId: bet.round_id,
      amount: bet.amount,
      payout: bet.payout,
      x100: bet.cashout_x100,
    });
    this._emit({ type: 'balance', userId: bet.user_id });
    return true;
  }

  /** Retry every settlement that has not completed (wallet outage, crash mid-settlement...). */
  async reconcile() {
    const rows = await this.db.all("SELECT id FROM bets WHERE settlement = 'pending' ORDER BY settled_at ASC LIMIT 200");
    let done = 0;
    for (const r of rows) {
      try {
        if (await this.settleBet(r.id)) done += 1;
      } catch (e) {
        this.logger.error('[game] reconcile failed for', r.id, e && e.message);
      }
    }
    return done;
  }

  // ----------------------------------------------------------------- views

  _emit(event) {
    this.emit('event', event);
  }

  _publicRound() {
    const r = this.round;
    if (!r) return null;
    const pub = {
      id: r.id,
      number: r.number,
      status: r.status,
      commitment: r.commitment,
      bettingEndsAt: r.bettingEndsAt,
      startedAt: r.startedAt,
    };
    if (r.status === 'crashed') {
      pub.crashX100 = r.crashX100;
      pub.hash = r.hash;
    }
    return pub;
  }

  _publicBet(b) {
    return {
      id: b.id,
      handle: b.handle,
      name: b.name,
      amount: b.amount,
      autoX100: b.autoX100 || null,
      status: b.status,
      cashoutX100: b.cashoutX100,
      payout: b.payout,
    };
  }

  _publicBetFromRow(row, user) {
    return {
      id: row.id,
      handle: user.handle,
      name: maskName(user.username),
      amount: row.amount,
      autoX100: row.auto_x100,
      status: row.status,
      cashoutX100: row.cashout_x100,
      payout: row.payout,
    };
  }

  /** Full state for a newly connected client. Secrets (hash, crash point) are never included before the crash. */
  snapshot(userId) {
    const r = this.round;
    const now = this.clock.now();
    return {
      serverTime: now,
      growthRate: this.cfg.growthRate,
      limits: { minBet: this.cfg.minBet, maxBet: this.cfg.maxBet, maxMultiplierX100: this.cfg.maxMultiplierX100 },
      round: this._publicRound(),
      elapsed: r && r.status === 'running' ? now - r.startedAt : null,
      bets: r ? [...r.bets.values()].filter((b) => b.status !== 'pending').map((b) => this._publicBet(b)) : [],
      myBet: r && userId && r.bets.get(userId) && r.bets.get(userId).status !== 'pending' ? this._publicBet(r.bets.get(userId)) : null,
      recent: this.recent.map((x) => ({ number: x.number, crashX100: x.crashX100, hash: x.hash })),
    };
  }
}

module.exports = { Game, GameError };
