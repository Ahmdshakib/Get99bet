'use strict';

const { DomainError } = require('../lib/errors');

class InsufficientFundsError extends DomainError {
  constructor() {
    super('insufficient_funds', 'Insufficient balance', 400);
    this.name = 'InsufficientFundsError';
  }
}

class ReferenceConflictError extends DomainError {
  constructor(reference) {
    super('reference_conflict', `Reference ${reference} already used with different parameters`, 409);
    this.name = 'ReferenceConflictError';
  }
}

class WalletUnavailableError extends DomainError {
  constructor(message = 'Wallet temporarily unavailable') {
    super('wallet_unavailable', message, 503);
    this.name = 'WalletUnavailableError';
  }
}

class NotImplementedError extends DomainError {
  constructor(message) {
    super('not_implemented', message, 501);
    this.name = 'NotImplementedError';
  }
}

/**
 * WALLET ADAPTER CONTRACT
 * -----------------------
 * The game never touches balances directly; it only talks to this interface.
 * To connect the Get99Bet website wallet, implement ExternalWalletAdapter.
 *
 * Rules every implementation MUST follow:
 *  1. Amounts are positive integers in minor units (100 = 1.00).
 *  2. `reference` is an idempotency key. Calling debit/credit/refund again with
 *     the same reference must NOT apply the effect twice; it returns the original
 *     result with `duplicate: true`. Reusing a reference with different
 *     user/amount/type must throw ReferenceConflictError.
 *  3. debit() throws InsufficientFundsError when funds are insufficient. It must
 *     never allow a negative balance.
 *  4. refund() reverses an earlier debit identified by meta.originalReference.
 *     If that debit never happened it is a no-op ({ refunded: false }).
 *  5. Transient failures should throw WalletUnavailableError (the game retries
 *     settlement later using the same reference, so retries are safe).
 *  6. All methods are async.
 */
class WalletAdapter {
  /** 'test' | 'external' */
  get mode() {
    throw new Error('not implemented');
  }

  /** { code, label, real, decimals } - what the UI shows next to every amount. */
  get currency() {
    throw new Error('not implemented');
  }

  /** Whether the UI should offer the "get test credits" button. */
  get supportsTopup() {
    return false;
  }

  /** Create the wallet account for a new user (idempotent). */
  // eslint-disable-next-line no-unused-vars
  async ensureAccount(userId) {
    throw new Error('not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async getBalance(userId) {
    throw new Error('not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async debit(userId, amount, reference, meta) {
    throw new Error('not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async credit(userId, amount, reference, meta) {
    throw new Error('not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async refund(userId, amount, reference, meta) {
    throw new Error('not implemented');
  }
}

module.exports = {
  WalletAdapter,
  InsufficientFundsError,
  ReferenceConflictError,
  WalletUnavailableError,
  NotImplementedError,
};
