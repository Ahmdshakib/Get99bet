'use strict';

const crypto = require('node:crypto');
const {
  WalletAdapter,
  InsufficientFundsError,
  ReferenceConflictError,
} = require('./WalletAdapter');
const { DomainError } = require('../lib/errors');
const { isValidAmount } = require('../lib/money');

const TEST_CURRENCY = Object.freeze({ code: 'TC', label: 'Test Credits', real: false, decimals: 2 });

/**
 * Local ledger wallet holding TEST CREDITS only. They have no monetary value and
 * cannot be withdrawn. This adapter exists so the game can be developed and
 * tested end-to-end before the licensed wallet API is available.
 *
 * Safety properties (verified by tests):
 *  - balance can never go negative (conditional UPDATE + CHECK constraint)
 *  - every effect is keyed by a unique reference (idempotent, duplicate-safe)
 *  - every change writes an immutable ledger row with balance_after
 */
class TestWalletAdapter extends WalletAdapter {
  constructor({ db, config, now = () => Date.now() }) {
    super();
    this.db = db;
    this.config = config;
    this.now = now;
  }

  get mode() {
    return 'test';
  }
  get currency() {
    return TEST_CURRENCY;
  }
  get supportsTopup() {
    return true;
  }

  async ensureAccount(userId) {
    const existing = await this.db.get('SELECT user_id FROM wallet_accounts WHERE user_id = ?', [userId]);
    if (existing) return;
    const start = this.config.wallet.startingBalance;
    try {
      await this.db.tx(async (t) => {
        const ts = this.now();
        await t.run('INSERT INTO wallet_accounts (user_id, currency, balance, updated_at) VALUES (?,?,?,?)', [
          userId,
          TEST_CURRENCY.code,
          0,
          ts,
        ]);
        if (start > 0) {
          await t.run('UPDATE wallet_accounts SET balance = balance + ? WHERE user_id = ?', [start, userId]);
          await t.run(
            'INSERT INTO wallet_transactions (id, user_id, type, amount, balance_after, reference, meta, created_at) VALUES (?,?,?,?,?,?,?,?)',
            [crypto.randomUUID(), userId, 'grant', start, start, `grant:${userId}`, JSON.stringify({ note: 'starting test credits' }), ts]
          );
        }
      });
    } catch (e) {
      if (!this.db.isUniqueViolation(e)) throw e; // concurrent creation is fine
    }
  }

  async getBalance(userId) {
    const row = await this.db.get('SELECT balance FROM wallet_accounts WHERE user_id = ?', [userId]);
    if (!row) throw new DomainError('wallet_not_found', 'Wallet not found', 404);
    return row.balance;
  }

  debit(userId, amount, reference, meta = {}) {
    return this._apply('debit', userId, amount, reference, meta);
  }

  credit(userId, amount, reference, meta = {}) {
    return this._apply('credit', userId, amount, reference, meta);
  }

  async refund(userId, amount, reference, meta = {}) {
    const original = meta.originalReference;
    if (!original) throw new DomainError('bad_request', 'refund requires meta.originalReference', 400);

    const existingRefund = await this.db.get('SELECT * FROM wallet_transactions WHERE reference = ?', [reference]);
    if (existingRefund) {
      if (existingRefund.user_id !== userId || existingRefund.type !== 'refund') throw new ReferenceConflictError(reference);
      return { ok: true, refunded: true, duplicate: true, balance: existingRefund.balance_after };
    }

    const debitRow = await this.db.get('SELECT * FROM wallet_transactions WHERE reference = ?', [original]);
    if (!debitRow || debitRow.type !== 'debit' || debitRow.user_id !== userId) {
      return { ok: true, refunded: false, duplicate: false, balance: await this.getBalance(userId) };
    }
    const result = await this._apply('refund', userId, debitRow.amount, reference, meta);
    return { ...result, refunded: true };
  }

  /** Test-only faucet. Rate limited by cooldown so it cannot be spammed. */
  async topup(userId) {
    const cooldownMs = this.config.wallet.topupCooldownSec * 1000;
    const last = await this.db.get(
      "SELECT created_at FROM wallet_transactions WHERE user_id = ? AND type = 'topup' ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    const t = this.now();
    if (last && t - last.created_at < cooldownMs) {
      throw new DomainError('topup_cooldown', 'Please wait before requesting more test credits', 429, {
        retryAfterMs: cooldownMs - (t - last.created_at),
      });
    }
    const ref = `topup:${userId}:${crypto.randomUUID()}`;
    return this._apply('topup', userId, this.config.wallet.topupAmount, ref, { note: 'test credits top-up' });
  }

  async listTransactions(userId, { limit = 50, offset = 0 } = {}) {
    const rows = await this.db.all(
      'SELECT id, type, amount, balance_after, reference, created_at FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      [userId, limit, offset]
    );
    return rows;
  }

  async _apply(type, userId, amount, reference, meta) {
    if (!isValidAmount(amount)) throw new DomainError('bad_amount', 'Invalid amount', 400);
    if (typeof reference !== 'string' || reference.length < 3 || reference.length > 200) {
      throw new DomainError('bad_reference', 'Invalid reference', 400);
    }
    const lookup = async () => {
      const row = await this.db.get('SELECT * FROM wallet_transactions WHERE reference = ?', [reference]);
      if (!row) return null;
      if (row.user_id !== userId || row.type !== type || row.amount !== amount) throw new ReferenceConflictError(reference);
      return { ok: true, duplicate: true, balance: row.balance_after };
    };

    const dup = await lookup();
    if (dup) return dup;

    try {
      return await this.db.tx(async (t) => {
        const ts = this.now();
        let changed;
        if (type === 'debit') {
          changed = await t.run(
            'UPDATE wallet_accounts SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND balance >= ?',
            [amount, ts, userId, amount]
          );
          if (!changed.changes) {
            const acc = await t.get('SELECT user_id FROM wallet_accounts WHERE user_id = ?', [userId]);
            if (!acc) throw new DomainError('wallet_not_found', 'Wallet not found', 404);
            throw new InsufficientFundsError();
          }
        } else {
          changed = await t.run('UPDATE wallet_accounts SET balance = balance + ?, updated_at = ? WHERE user_id = ?', [
            amount,
            ts,
            userId,
          ]);
          if (!changed.changes) throw new DomainError('wallet_not_found', 'Wallet not found', 404);
        }
        const acc = await t.get('SELECT balance FROM wallet_accounts WHERE user_id = ?', [userId]);
        await t.run(
          'INSERT INTO wallet_transactions (id, user_id, type, amount, balance_after, reference, meta, created_at) VALUES (?,?,?,?,?,?,?,?)',
          [crypto.randomUUID(), userId, type, amount, acc.balance, reference, JSON.stringify(meta || {}), ts]
        );
        return { ok: true, duplicate: false, balance: acc.balance };
      });
    } catch (e) {
      // Two concurrent calls with the same reference: the loser hits the UNIQUE index.
      if (this.db.isUniqueViolation(e)) {
        const again = await lookup();
        if (again) return again;
      }
      throw e;
    }
  }
}

module.exports = { TestWalletAdapter, TEST_CURRENCY };
