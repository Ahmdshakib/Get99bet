# Provably fair

**Commitment (hash chain).** At start the server draws a random secret seed and computes `chain[i] = SHA256(chain[i-1])`.
The final value `chain[N]` (the *terminal hash*) is published (Fair page / `GET /api/fair`). Round *k* uses `chain[N-1-k]`.
After a round ends its hash is revealed, so anyone can check `SHA256(revealed hash) == previously revealed hash`
(or the terminal hash for the first round). The seed is never exposed by any API.

**Crash point.** `mac = HMAC_SHA256(key = roundHash, message = clientSeed)`; `h` = first 52 bits;
`crash = floor(100 · (1 − edge) · 2^52 / (2^52 − h)) / 100`, minimum 1.00×, capped at `MAX_MULTIPLIER_X100`.
All integer BigInt maths, identical in `src/fair/engine.js` and `public/js/fair-verify.js` (runs in the player's browser).

**Properties (tested by simulation).** `P(crash ≥ m) = (1 − edge)/m`, so any fixed cash-out target returns 99% (edge 1%).
P(1.00×) ≈ 1.98% (edge + flooring). The cap and `MAX_PAYOUT` are operator risk controls; they slightly alter the tail.

**Client seed.** `FAIR_CLIENT_SEED` defaults to a fixed test value. For stronger guarantees: publish the terminal hash first, *then*
choose a seed nobody controls (e.g. a later public block hash) and set it before play, and keep it fixed for the chain.

**Chain rotation.** When a chain is exhausted a new one is generated; publish each new terminal hash before using it.
