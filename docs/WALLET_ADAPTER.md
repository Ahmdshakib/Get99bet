# Wallet adapter — connecting the Get99Bet website wallet

**Status: real-money mode is disabled.** Do not enable it until you have (1) the licensed wallet API documentation and
(2) written legal/regulatory authorization for every market you serve.

The game never touches balances directly. It talks only to `src/wallet/WalletAdapter.js`:

| Method | Purpose |
|---|---|
| `ensureAccount(userId)` | create/link the wallet account |
| `getBalance(userId)` | authoritative balance (integer minor units) |
| `debit(userId, amount, reference, meta)` | take a stake. Throws `InsufficientFundsError` |
| `credit(userId, amount, reference, meta)` | pay winnings |
| `refund(userId, amount, reference, {originalReference})` | reverse an earlier debit; no-op if that debit never happened |

## Rules every implementation must follow
1. **Idempotency by `reference`.** The same reference must never apply twice (`bet:<betId>`, `win:<betId>`, `refund:<betId>`). A repeat returns the original result with `duplicate: true`. Reusing a reference with different user/amount/type throws `ReferenceConflictError`. Forward the reference as the remote API's idempotency key.
2. **No negative balances.** Debits must be conditional on sufficient funds.
3. **Transient failure → `WalletUnavailableError`.** Settlement is retried (`Game.reconcile()` every 15 s and at startup) with the *same* reference, so retries are safe.
4. **Ambiguous debit outcome** (timeout after sending): the game voids the bet and runs an idempotent refund keyed to `bet:<id>`. Your `refund` must therefore handle "original debit unknown/never happened" safely.
5. **Server-to-server only**, signed (HMAC/mTLS/API key per your provider). The browser never sends or receives anything that can change a balance.
6. If your wallet can change balance outside the game (deposits, withdrawals), the gateway polls `getBalance` every `BALANCE_POLL_MS` for connected users, or call `gateway.pushBalance(userId)` from a webhook handler.

## Steps to implement
1. Implement `src/wallet/ExternalWalletAdapter.js` (currently throws on construction).
2. Replace the session mechanism if the website owns login: `AuthService.resolveSession` is the single place that maps a request to a user (e.g. validate a signed SSO token from the main site and map it to `users.id`).
3. Set `currency` to the real currency descriptor (`{ code, label, real: true, decimals }`). The UI then drops the *test* wording **only where you also update** `i18n.js` (`banner.test`, `wallet.label`, `footer.test`) — review all of these.
4. Remove/disable `supportsTopup` (it is `false` by default on any adapter except the test wallet).
5. Provide `WALLET_MODE=external` and `LEGAL_AUTHORIZATION_CONFIRMED=true` (the config loader refuses `external` without it).
6. Run the adapter contract tests: copy `test/wallet.test.js` and point it at a sandbox of your wallet API.
7. Complete `docs/GO_LIVE_CHECKLIST.md`.

Send the API documentation when you have it and the adapter can be written and tested against it.
