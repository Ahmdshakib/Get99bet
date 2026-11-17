# Security & money-safety design

| Risk | Control |
|---|---|
| Fake / tampered balance | The browser has **no** balance input anywhere. Balance comes only from `wallet.getBalance` (server). Tests assert client-supplied `balance`/`userId` fields are ignored. |
| Duplicate transactions | Unique `reference` per wallet effect; unique `(user, clientRef)` per bet; one bet per user per round (DB unique index); conditional `UPDATE … WHERE status='active'` makes cash-out exactly-once. |
| Overspending / race conditions | Conditional debit (`balance >= amount`) + `CHECK (balance >= 0)`; concurrency tests (30 parallel debits can never exceed the balance). |
| Client chooses payout | Multiplier computed from the **server clock**; auto cash-out pays exactly the target; late cash-outs rejected (`too_late`). |
| Wallet outage / crash mid-payout | Two-phase settlement (`bets.settlement`), idempotent retries via `reconcile()`, startup `recover()` voids unfinished rounds and refunds open stakes. |
| Predicting crash | Secret hash chain, never sent before the crash (tested); commitment published up front. |
| Account takeover | scrypt password hashes, 10+ char passwords, login lockout (5 fails → 15 min), constant-time dummy hash for unknown users, session tokens stored only as SHA-256, HttpOnly + SameSite=Strict + Secure cookies, sessions revocable, WS closed on logout. |
| CSRF / cross-site WebSocket | Custom `X-Requested-With` header + Origin check on state-changing requests; Origin check on WS upgrade; SameSite=Strict. |
| XSS | Strict CSP (`script-src 'self'`, no inline styles/scripts); all server data rendered with `textContent`; public names masked. |
| Abuse | Per-IP and per-user rate limits, per-socket message limit, 1 KB frame cap, connection cap per IP, JSON body limit 8 KB. |
| Tampering with history | Hash-chained, append-only `audit_log` (`Audit.verify()`); no secrets in logs. |

Limits to know: rate limiting, login lockout and the audit sequence are **per process** (single instance). Use Redis and
a DB sequence/advisory lock if you ever scale horizontally. Rotate/back up the DB (the hash-chain seed lives in `fair_chains`).
