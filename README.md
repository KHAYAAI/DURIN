# DURIN

**Institutional digital financial infrastructure — Layer 3 of the FORGE stack.**
One API. Multiple financial rails. A double-entry ledger as the source of truth.

> **Not launch-ready. Sandbox only.** All money movement is simulated; there are no live provider
> adapters and gate G1 (counsel sign-off on live conversion) is closed. See
> [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for what is built versus what only external
> parties can supply, and [STATUS.md](STATUS.md) for what has been verified.

## What it does today

- **Ledger**: double-entry, exact decimal arithmetic (no floats), balances maintained by database
  triggers, immutable posted entries, tenant isolation, concurrency-safe, with an integrity report.
- **Developer platform**: organisations, scoped API keys, idempotency, signed durable webhooks.
- **Custody-reference ledger**: `CUSTODY-REF-*` accounts mirror what the custodians report; DURIN
  records customer entitlements against them and **reconciles** the two (breaks, solvency check).
- **Payments, conversions (ZAR↔USDC), wallets/withdrawals, compliance (limits, approvals)** against
  *simulated* providers behind `Layer1Port` (custody), `Layer2Port` (fiat) and `LiquidityPort`.
  Conversions are a state machine (reserve → provider call → fill → settle); an unknown provider
  outcome keeps funds reserved and is never re-sent.
- **Identity (Didit)**: KYC/KYB sessions and signed webhooks (`X-Signature-V2`).
- **Auth (WorkOS)**: SSO + AuthKit sign-in for the dashboard, API tokens mapped to organisations
  and scopes, session-bound TOTP step-up for sensitive actions.
- **Dashboard**: read-only institutional console (Next.js) behind WorkOS AuthKit; fails closed in production.

Hard boundaries: DURIN holds no private keys (Layer 1) and no customer fiat deposits (Layer 2).

## Quick start

Requires Node 22.11+, pnpm, and Docker (for Postgres).

```bash
cp .env.example .env        # set POSTGRES_PASSWORD and DURIN_APP_PASSWORD
./scripts/bootstrap-local.sh
DATABASE_URL="postgresql://durin_app:<DURIN_APP_PASSWORD>@localhost:5432/durin" pnpm dev:api
node scripts/smoke.mjs http://localhost:3000     # end-to-end check against the running API
```

Create an organisation (open in development; gated by `BOOTSTRAP_TOKEN` otherwise):

```bash
curl -s -X POST localhost:3000/v1/organisations -H 'Content-Type: application/json' -d '{"name":"Acme"}'
# -> apiKey.secret is shown once. Use it as:  Authorization: Bearer dk_test_...
```

## Layout

```
api/              NestJS API (Prisma + PostgreSQL), OpenAPI at api/openapi/openapi.yaml
dashboard/        Next.js console (WorkOS AuthKit; calls the API as the signed-in user)
packages/ledger   exact decimal arithmetic + journal validation
packages/shared   shared constants and webhook signing/verification
infrastructure/   docker-compose (Postgres) and DB role init
docker/           Dockerfiles (not yet built in CI)
scripts/          bootstrap, smoke test, load test, reconciliation runner
```

## Development

```bash
pnpm typecheck && pnpm lint
pnpm test                    # unit tests
pnpm test:integration        # real PostgreSQL; needs DURIN_TEST_ADMIN_URL / DURIN_TEST_APP_URL
pnpm build
```

Integration tests create a fresh database, apply the real migrations as the schema owner, and run
the API as the least-privilege `durin_app` login (a member of `durin_runtime`), so permission and
trigger behaviour is tested exactly as deployed.

## Rules of the codebase

- Money is a decimal **string** in the API and exact decimal arithmetic in code. `parseFloat` and
  `Number(x).toFixed` are lint errors. Use `@durin/ledger`.
- Only the ledger service writes journals; balances change only via database triggers.
- Simulated behaviour must call `assertSandboxOnly` and be labelled as simulated.
- Provider calls with an unknown outcome are never retried or reversed automatically.
- Never put secrets in code, `NEXT_PUBLIC_*` variables, or the repository.

## Launch readiness

| Area | State |
|---|---|
| Ledger, idempotency, webhooks, reconciliation, conversion state machine | Built and tested (sandbox) |
| Didit KYC/KYB, WorkOS SSO/MFA | Built and tested against fakes; **accounts not yet configured** |
| Live custody / fiat / liquidity adapters | **Not built** (need agreements and credentials) |
| Gate G1 — counsel sign-off on live conversion | **Closed** |
| Chain policy (allow-list, confirmations, native-only) | **Not built**; see [CHAIN_STRATEGY.md](CHAIN_STRATEGY.md) |
| Security review, DR drills, monitoring | **Not done** |

## Docs

[PRODUCTION_READINESS](PRODUCTION_READINESS.md) · [CHAIN_STRATEGY](CHAIN_STRATEGY.md) · 
[ARCHITECTURE](ARCHITECTURE.md) · [DATABASE_SCHEMA](DATABASE_SCHEMA.md) · [API_SPECIFICATION](API_SPECIFICATION.md) ·
[IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md) · [HANDOFF](HANDOFF.md) · integration contracts:
[Layer 1](OPENFIREBLOCKS.md), [Layer 2](FORGE_MUTUAL.md), [A-CARD](A_CARD.md).
The `M*_STATUS.md` files and `READINESS.md` describe the original scaffold and are superseded by
[STATUS.md](STATUS.md).

## Licence

Proprietary — all rights reserved until otherwise stated.
