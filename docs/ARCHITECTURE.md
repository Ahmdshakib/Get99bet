# Architecture

```
Browser (HTML/CSS/JS + Canvas)
  ├─ REST  /api/*      auth, wallet info, history, stats, limits, fairness      (cookie session + CSRF header)
  └─ WS    /ws         live events; client sends only {bet | cashout}
Express app (src/app.js) ── routes (src/routes) ── services
                                          │
        ┌─────────────────────────────────┼──────────────────────────────┐
   Game (round manager)             AuthService / LimitsService         Audit (hash chain)
        │  phases: betting → running → crashed
   ChainStore (hash chain) ── fair/engine
        │
   WalletAdapter  ←── TestWalletAdapter (local ledger, TEST CREDITS)
                  ←── ExternalWalletAdapter (website wallet; NOT implemented yet)
        │
   Db (SqliteDb dev | PostgresDb prod) — one portable schema (src/db/schema.sql)
```

**Round lifecycle.** `openBetting` (publish commitment) → `startRunning` (server records `startedAt`) → ticks every `TICK_MS`
(pay auto cash-outs, broadcast `tick`) → at the crash instant `_crashLocked` pays remaining auto cash-outs, marks losers, reveals the hash.
Clients draw the curve locally from `startedAt` + estimated clock offset; the server remains the only authority.

**Bet lifecycle.** reserve slot (`pending`) → wallet `debit` → activate (`active`) → `cashed` | `lost` | `void`.
Settlement of winnings/refunds is tracked separately and retried until done.

**Scaling note.** One process owns the round loop. To scale, run a single "game" instance and put read-only/API instances behind it
with Redis pub/sub; not needed for typical single-site volume.
