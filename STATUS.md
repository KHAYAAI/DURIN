# DURIN — Verified Status

This file states what has actually been run and what the results were. It replaces earlier
self-assessments (the old `READINESS.md` rated most areas "High"; the `M*_STATUS.md` files describe
the original scaffold and are historical). Where something has not been run, it says so.

**DURIN is a sandbox. It is not production-ready and moves no real money.**

## Verified by running it

| Check | Result |
|---|---|
| `pnpm typecheck` (api, dashboard, packages) | clean |
| `eslint` on `api/src` and `api/test` | clean |
| `@durin/ledger` unit tests (decimal arithmetic, rounding, validation; randomized property tests) | 35 pass |
| `@durin/shared` unit tests (webhook signing) | 4 pass |
| API unit tests | 18 pass |
| **Integration tests**: real PostgreSQL 16, real migrations, connecting as the least-privilege runtime role | **81 pass**, stable over repeated runs |
| Mutation check: disabling the balanced-journal trigger, line-immutability trigger and non-negative check | the 7 dependent tests fail, as they should |
| Production build of API (`nest build`) and dashboard (`next build`) | succeed |
| Pruned production bundle (`pnpm deploy`, what the Dockerfile produces), started, 12-check smoke test | 12/12 |
| Production start-up with missing secrets or sandbox adapters | refuses to start, lists every problem |
| Health endpoint under 400 concurrent requests | 400/400, p95 ≈ 21 ms |
| Dashboard: anonymous / wrong password / correct password | 401 / 401 / 200; 503 in production with no password; API key not present in client bundles |
| `migrate.mjs`: fresh database, runtime grant, idempotent rerun, rejects unsafe role names | works |
| Postgres role-init script with a hostile password | works |
| `docker compose config` | valid |

## Not verified (written, never executed)

- **Docker images and `docker compose up`**: no Docker daemon was available. The same steps were
  verified by hand outside Docker (see above).
- **GitHub Actions workflow** (`.github/workflows/ci.yml`): mirrors the verified commands, never run.
- Node 20 (all testing was on Node 22).
- Load behaviour of anything other than `/health`.
- No security review or penetration test of any kind.

## What is real, what is simulated

| Capability | Status |
|---|---|
| Double-entry ledger (balanced journals, exact decimals, non-negative balances, immutability, tenant isolation, concurrency safety, integrity report) | **implemented**, database-enforced |
| API keys, scopes, no privilege escalation, test/live key separation | **implemented** |
| Idempotency (atomic claim, scoped per organisation, request-fingerprinted, crash-safe) | **implemented** |
| Webhooks (durable queue, signed, retried with backoff, SSRF-protected, at-least-once) | **implemented** |
| Payments, wallets/custody, fiat settlement | **simulated** — no chain monitoring, banking rails or custody |
| ZAR↔USDC conversion | **simulated** — live is *awaiting regulatory approval* (gate G1) |
| KYB/KYC, sanctions screening | **simulated** — live is *awaiting commercial agreement* |
| Live custody / fiat adapters | *awaiting credentials* |
| Anything production-ready | **none** |

All simulated, balance-creating endpoints (`simulate_*`, manual journals, sandbox pre-funding,
payment intents, quotes/conversions, simulated screening and KYB approval) return
`403 AWAITING_REGULATORY_APPROVAL` when `NODE_ENV=production`.

## Defects found in the original scaffold and fixed

1. `@durin/ledger` and `@durin/shared` did not exist, so nothing installed or built.
2. The "init" migration was a comment, so a fresh database had no tables.
3. Balance updates were read-modify-write with no lock: concurrent debits could overdraw.
4. Money arithmetic used JavaScript floats in six places (quotes, journal building, liquidity top-up, limits, sandbox custody, payment validation).
5. A quote could be converted twice by concurrent accepts with different idempotency keys.
6. Withdrawals debited the ledger *before* the custody call; a provider error lost the customer's funds. Now: persist intent, idempotent debit, then provider; a provider rejection reverses; an unknown outcome holds funds and is never auto-retried or auto-reversed.
7. Webhook delivery made unrestricted HTTP calls to tenant URLs (SSRF), signed with a value receivers could not verify, and ran inside the request.
8. Any key with `api_keys:write` could mint an `admin` key; default keys included `admin`.
9. `POST /v1/journals` let an admin key mint balances; the simulate endpoints and sandbox pre-funding had no production guard.
10. A tenant could approve its own KYB and decide its own approval requests; approval decisions were not atomic.
11. Idempotency was a read-then-write (two concurrent requests both ran), hashed the route pattern instead of the URL, and kept failed requests locked.
12. The rate limiter ran before authentication (every client keyed by IP), never evicted entries, and throttled health probes.
13. Organisation creation was a public endpoint that minted an API key.
14. The dashboard had no login, used a `NEXT_PUBLIC_` API key, and turned API failures into zeros.
15. `SimulateDepositDto` had no validators, so its own field was rejected: that endpoint could never succeed.
16. `/v1/version` and the health endpoint asserted readiness ("high") that was never measured.
17. A health spec that expected a value the controller never returned; an idempotency spec that tested nothing.

## Known gaps (do not ship without addressing)

- **Conversion accounting is sandbox-only.** A live conversion needs liquidity-provider clearing accounts and receivables; the current journal is an illustrative settlement-account swap.
- **No live providers.** Payments, custody and fiat rails are simulators behind `Layer1Port` / `Layer2Port`.
- **Rate limiting is in-process.** It is per API key but not shared across instances (Redis is not used yet).
- **Dashboard login is an interim HTTP Basic gate**, not the SSO + MFA the auth policy requires. Serve over HTTPS behind your identity provider.
- **Webhook events are queued after the originating transaction commits**, not in the same transaction; a crash in between can drop an event (state remains recoverable via the API).
- **Approvals are recorded but do not gate withdrawals**; verification status does not gate any operation; daily limits cover withdrawals only.
- **No list pagination** beyond a `limit`. Idempotency records and finished webhook deliveries are never pruned.
- **Encryption-key rotation** is not implemented (`DURIN_ENCRYPTION_KEY` is a single key).
- **API-key verification uses scrypt on every request** (safe, but costs CPU; add a short-lived verified-key cache before high traffic).
- Single-region, single-database; no backup/restore or disaster-recovery procedure has been tested.
- Regulatory gate **G1** (live ZAR↔USDC) remains open and needs external counsel.
