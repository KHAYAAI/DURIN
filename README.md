# DURIN

**Institutional digital financial infrastructure — Layer 3 of the FORGE stack.**
One API. Multiple financial rails. A double-entry ledger as the source of truth.

> **Sandbox only.** All money movement is simulated. Not production-ready. See [STATUS.md](STATUS.md)
> for exactly what has been verified, what is simulated, and the known gaps.

## What it does today

- **Ledger**: double-entry, exact decimal arithmetic (no floats), balances maintained by database
  triggers, immutable posted entries, tenant isolation, concurrency-safe, with an integrity report.
- **Developer platform**: organisations, scoped API keys, idempotency, signed durable webhooks.
- **Payments, conversions (ZAR↔USDC), wallets/withdrawals, compliance (limits, approvals)** against
  *simulated* providers behind `Layer1Port` (custody) and `Layer2Port` (fiat).
- **Dashboard**: read-only institutional console (Next.js), behind an access gate.

Hard boundaries: DURIN holds no private keys (Layer 1) and no customer fiat deposits (Layer 2).

## Quick start

Requires Node 20+ (tested on 22), pnpm, and Docker (for Postgres).

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
dashboard/        Next.js console (server-side API key, access-gated)
packages/ledger   exact decimal arithmetic + journal validation
packages/shared   shared constants and webhook signing/verification
infrastructure/   docker-compose (Postgres) and DB role init
docker/           Dockerfiles (not yet built in CI)
scripts/          bootstrap, smoke test, load test, reconciliation helper
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

## Docs

[ARCHITECTURE](ARCHITECTURE.md) · [DATABASE_SCHEMA](DATABASE_SCHEMA.md) · [API_SPECIFICATION](API_SPECIFICATION.md) ·
[IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md) · [HANDOFF](HANDOFF.md) · integration contracts:
[Layer 1](OPENFIREBLOCKS.md), [Layer 2](FORGE_MUTUAL.md), [A-CARD](A_CARD.md).
The `M*_STATUS.md` files and `READINESS.md` describe the original scaffold and are superseded by
[STATUS.md](STATUS.md).

## Licence

Proprietary — all rights reserved until otherwise stated.
