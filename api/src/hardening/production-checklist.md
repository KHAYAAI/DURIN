# M8 Production checklist (engineering)

- [ ] argon2id for API key hashing (replace SHA-256)
- [ ] Rate limiting per API key (Redis)
- [ ] Helmet / full security headers in production profile
- [ ] Secrets via secret manager only
- [ ] PITR backups for Postgres
- [ ] Reconciliation jobs: ledger vs Layer1 vs Layer2
- [ ] No sandbox adapters bound in production config (fail closed)
- [ ] Load test journal posting under concurrency
- [ ] Penetration test + dependency audit
- [ ] G1 legal sign-off before live ZAR↔USDC
- [ ] Incident runbooks
- [ ] Status labels audited — no simulated path marked production-ready
