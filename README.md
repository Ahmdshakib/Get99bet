# Get99Bet Crash Game

An original, provably fair crash game: server-authoritative rounds, WebSocket live play, rocket animation on Canvas,
English + Bangla UI, responsible-gambling controls, hash-chained audit log and a pluggable wallet adapter.

> ## ⚠️ TEST MODE ONLY
> This build runs on **Test Credits** (currency code `TC`). They have **no monetary value**, cannot be withdrawn, and the UI
> says so on every page. Real-money mode is **intentionally blocked** in code until you provide the licensed wallet API
> documentation **and** confirm legal authorization (see `docs/WALLET_ADAPTER.md` and `docs/GO_LIVE_CHECKLIST.md`).
> All artwork, sounds (synthesised with Web Audio), UI and code are original. Nothing is copied from any third-party game.

## Quick start (local, SQLite)

```bash
npm install
cp .env.example .env          # optional
npm start                     # http://localhost:3000
npm test                      # 84 automated tests (Node's built-in runner; no extra dev deps)
```
Requires **Node 22.13+** (uses the built-in `node:sqlite` for local development).

## Production (Docker + PostgreSQL)

```bash
cp .env.example .env          # set POSTGRES_PASSWORD, ALLOWED_ORIGINS, FAIR_CLIENT_SEED
docker compose up -d --build
```
Put a TLS reverse proxy in front (`deploy/nginx.conf` is a working example, including WebSocket upgrade headers).
The app is single-instance by design (one process owns the round loop). See `docs/ARCHITECTURE.md`.

## What is included

| Area | Where |
|---|---|
| Crash engine, hash chain, verifier | `src/fair/`, `public/js/fair-verify.js` |
| Round manager (bets, cash-out, auto cash-out, settlement, recovery) | `src/services/game.js` |
| Wallet adapter interface + test-credit ledger + disabled external stub | `src/wallet/` |
| Auth (scrypt, hashed session tokens, lockout), limits, audit log | `src/services/` |
| REST API, WebSocket gateway | `src/routes/`, `src/ws/` |
| DB layer (SQLite dev / PostgreSQL prod, one schema) | `src/db/` |
| Frontend (Canvas, i18n EN/BN, dashboard, history, fair, safer play) | `public/` |
| Tests | `test/` |
| Docs | `docs/` |

## Features
- Live multiplier curve, rocket + flame particles, crash explosion, starfield, synthesised sound (mute toggle).
- Bet, manual cash-out, auto cash-out. The **server clock** decides every multiplier; the browser only requests.
- Balance shown is always the server's wallet balance, pushed over the socket and re-read on refresh / reconnect / tab focus.
- Dashboard (stats, P/L chart, wallet transactions, account activity), bet + round history, in-browser round verification.
- Responsible gambling: session reminders, max bet, rolling 24h loss limit, self-exclusion (delayed loosening, no early exit), 18+ confirmation.
- Responsive: desktop two-column, tablet single column, phone with bottom tab bar. Tested with no horizontal overflow at 390px in EN and BN.

## Configuration
All settings are environment variables; see `.env.example` (amounts are integer minor units: `100` = 1.00).

## Honest verification notes
- Verified here: engine maths (RTP/distribution simulations), wallet ledger (idempotency, concurrency, no overdraft), full game flow,
  crash recovery, limits, audit tamper detection, REST handlers and WebSocket message handling (84 tests), plus real-browser
  end-to-end runs (signup → bet → manual & auto cash-out → refresh → verify) with the production CSP, on desktop and phone viewports.
- **Not executed in the build environment** (no package installs were possible there): the thin glue that uses the `express`, `ws` and
  `pg` packages (`src/app.js`, `Gateway.attach`, `src/db/postgres.js`) and the Docker build. They are small, syntax-checked and follow
  the packages' documented APIs, but run `npm install && npm test && npm start` and a Postgres smoke test (`docker compose up`) before relying on them.
