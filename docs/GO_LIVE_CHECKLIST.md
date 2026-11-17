# Before any real-money use — all items required

- [ ] Gambling licence / written legal authorization for every jurisdiction served (and for each payment method).
- [ ] Licensed wallet API documentation received; `ExternalWalletAdapter` implemented and tested in the provider's sandbox.
- [ ] Wallet adapter contract tests pass; idempotency verified against the provider (replays, timeouts, partial failures).
- [ ] KYC/AML, age verification (18+/local minimum), geo-blocking and sanctions checks per licence conditions.
- [ ] UI wording reviewed: all "test credits" text updated deliberately; real currency shown; no test top-up.
- [ ] Responsible-gambling tools reviewed against licence requirements; add local help-line links/resources to the Safer-play page and footer.
- [ ] Independent RNG / fairness certification if required; publish terminal hash *before* choosing the client seed.
- [ ] HTTPS only, `COOKIE_SECURE=true`, `ALLOWED_ORIGINS` set, DB backups + restore drill, monitoring/alerts on reconcile failures and audit-chain verification.
- [ ] Penetration test; load test of one instance (WebSocket fan-out) and capacity plan.
- [ ] Terms, privacy policy, dispute process, complaint handling, record retention.
