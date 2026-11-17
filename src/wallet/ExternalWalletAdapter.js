'use strict';

const { WalletAdapter, NotImplementedError } = require('./WalletAdapter');

const MESSAGE =
  'ExternalWalletAdapter is intentionally NOT implemented. Real-money mode is blocked until the licensed ' +
  'Get99Bet wallet API documentation is provided and legal authorization is confirmed. See docs/WALLET_ADAPTER.md.';

/**
 * PLACEHOLDER for the Get99Bet website wallet.
 *
 * Do not enable until you have:
 *   1. the licensed wallet API documentation (endpoints, auth, idempotency semantics),
 *   2. written legal/regulatory authorization for the markets you serve.
 *
 * Implementation checklist (see docs/WALLET_ADAPTER.md for details):
 *   - getBalance -> GET  {WALLET_API}/balance           (server-to-server, signed)
 *   - debit      -> POST {WALLET_API}/debit   { userId, amount, reference }
 *   - credit     -> POST {WALLET_API}/credit  { userId, amount, reference }
 *   - refund     -> POST {WALLET_API}/refund  { userId, reference, originalReference }
 *   - map HTTP/network failures to WalletUnavailableError (settlement is retried)
 *   - map "insufficient funds" to InsufficientFundsError
 *   - the `reference` MUST be forwarded as the remote idempotency key
 *   - never trust a balance sent by the browser; the browser only ever displays
 *     what this server fetched from the wallet.
 */
class ExternalWalletAdapter extends WalletAdapter {
  constructor() {
    super();
    throw new NotImplementedError(MESSAGE);
  }
}

module.exports = { ExternalWalletAdapter };
