'use strict';

const { DomainError } = require('../lib/errors');

const DAY_MS = 24 * 3600 * 1000;
const EXCLUSION_DAYS = [1, 7, 30, 90, 180, 365];
const FIELDS = ['maxBet', 'dailyLossLimit', 'sessionReminderMin'];
const COLS = { maxBet: 'max_bet', dailyLossLimit: 'daily_loss_limit', sessionReminderMin: 'session_reminder_min' };

/**
 * Responsible-gambling controls.
 *  - Player-set max bet, rolling 24h loss limit, session reminder interval.
 *  - TIGHTENING a limit (lower value, or adding one) applies immediately.
 *  - LOOSENING a limit (higher value or removal) is delayed (default 24h) - a standard cooling-off rule.
 *  - Self-exclusion for a fixed period; it can be extended but never shortened or cancelled early.
 */
class LimitsService {
  constructor({ db, audit, config, now = () => Date.now() }) {
    this.db = db;
    this.audit = audit;
    this.config = config;
    this.now = now;
  }

  async _row(userId) {
    return this.db.get('SELECT * FROM rg_limits WHERE user_id = ?', [userId]);
  }

  /** Apply any pending (loosening) change whose delay has elapsed. */
  async _settlePending(userId, row) {
    if (!row || !row.pending_json || !row.pending_effective_at || row.pending_effective_at > this.now()) return row;
    const pending = JSON.parse(row.pending_json);
    const sets = [];
    const params = [];
    for (const f of FIELDS) {
      if (Object.prototype.hasOwnProperty.call(pending, f)) {
        sets.push(`${COLS[f]} = ?`);
        params.push(pending[f]);
      }
    }
    if (sets.length) {
      await this.db.run(
        `UPDATE rg_limits SET ${sets.join(', ')}, pending_json = NULL, pending_effective_at = NULL, updated_at = ? WHERE user_id = ?`,
        [...params, this.now(), userId]
      );
    }
    await this.audit.log(userId, 'rg.pending_applied', pending);
    return this._row(userId);
  }

  async get(userId) {
    let row = await this._row(userId);
    row = await this._settlePending(userId, row);
    const t = this.now();
    const pending = row && row.pending_json ? JSON.parse(row.pending_json) : null;
    return {
      maxBet: row ? row.max_bet : null,
      dailyLossLimit: row ? row.daily_loss_limit : null,
      sessionReminderMin: row && row.session_reminder_min ? row.session_reminder_min : this.config.rg.sessionReminderDefaultMin,
      excludedUntil: row && row.excluded_until && row.excluded_until > t ? row.excluded_until : null,
      pending,
      pendingEffectiveAt: pending ? row.pending_effective_at : null,
      exclusionOptionsDays: EXCLUSION_DAYS,
      raiseDelayHours: this.config.rg.raiseDelayHours,
    };
  }

  /**
   * changes: { maxBet?, dailyLossLimit?, sessionReminderMin? } - null means "no limit".
   */
  async update(userId, changes) {
    const current = await this.get(userId);
    const t = this.now();
    const immediate = {};
    const delayed = {};

    for (const f of FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(changes, f)) continue;
      const v = changes[f];
      if (v !== null && (!Number.isSafeInteger(v) || v <= 0)) {
        throw new DomainError('bad_limit', `Invalid value for ${f}`, 400);
      }
      if (f === 'sessionReminderMin' && v !== null && (v < 5 || v > 240)) {
        throw new DomainError('bad_limit', 'Session reminder must be 5-240 minutes', 400);
      }
      if (f === 'sessionReminderMin') {
        immediate[f] = v; // reminders are never a "loosening" of protection that needs a delay
        continue;
      }
      const cur = current[f];
      const isLoosening = cur !== null && (v === null || v > cur);
      if (v === cur) continue;
      if (isLoosening) delayed[f] = v;
      else immediate[f] = v;
    }

    const existing = await this._row(userId);
    if (!existing) {
      await this.db.run('INSERT INTO rg_limits (user_id, updated_at) VALUES (?, ?)', [userId, t]).catch(async (e) => {
        if (!this.db.isUniqueViolation(e)) throw e;
      });
    }

    const sets = [];
    const params = [];
    for (const [f, v] of Object.entries(immediate)) {
      sets.push(`${COLS[f]} = ?`);
      params.push(v);
    }
    if (Object.keys(delayed).length) {
      const merged = { ...(current.pending || {}), ...delayed };
      sets.push('pending_json = ?', 'pending_effective_at = ?');
      params.push(JSON.stringify(merged), t + this.config.rg.raiseDelayHours * 3600 * 1000);
    }
    if (sets.length) {
      await this.db.run(`UPDATE rg_limits SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`, [...params, t, userId]);
    }
    await this.audit.log(userId, 'rg.limits_update', { immediate, delayed });
    return this.get(userId);
  }

  async selfExclude(userId, days) {
    if (!EXCLUSION_DAYS.includes(days)) throw new DomainError('bad_exclusion', 'Invalid exclusion period', 400);
    const t = this.now();
    const until = t + days * DAY_MS;
    const row = await this._row(userId);
    if (!row) {
      await this.db.run('INSERT INTO rg_limits (user_id, updated_at) VALUES (?, ?)', [userId, t]);
    }
    // Never shorten an existing exclusion.
    const current = row && row.excluded_until ? row.excluded_until : 0;
    const finalUntil = Math.max(current, until);
    await this.db.run('UPDATE rg_limits SET excluded_until = ?, updated_at = ? WHERE user_id = ?', [finalUntil, t, userId]);
    await this.audit.log(userId, 'rg.self_exclude', { days, until: finalUntil });
    return this.get(userId);
  }

  /** Net loss over the rolling 24h window, counting open stakes as lost. */
  async lossLast24h(userId) {
    const since = this.now() - DAY_MS;
    const r = await this.db.get(
      "SELECT COALESCE(SUM(amount - payout), 0) AS loss FROM bets WHERE user_id = ? AND created_at > ? AND status IN ('active','cashed','lost')",
      [userId, since]
    );
    return Math.max(0, Number(r.loss));
  }

  /** Throws a DomainError if the player may not place this bet. */
  async assertCanBet(userId, amount) {
    const s = await this.get(userId);
    if (s.excludedUntil) {
      throw new DomainError('self_excluded', 'You are self-excluded', 403, { until: s.excludedUntil });
    }
    const maxBet = Math.min(this.config.game.maxBet, s.maxBet ?? Infinity);
    if (amount > maxBet) {
      throw new DomainError('over_max_bet', 'Bet exceeds your maximum bet', 400, { maxBet });
    }
    if (s.dailyLossLimit !== null) {
      const loss = await this.lossLast24h(userId);
      if (loss + amount > s.dailyLossLimit) {
        throw new DomainError('daily_loss_limit', 'This bet would exceed your daily loss limit', 403, {
          limit: s.dailyLossLimit,
          lossSoFar: loss,
        });
      }
    }
  }
}

module.exports = { LimitsService, EXCLUSION_DAYS };
