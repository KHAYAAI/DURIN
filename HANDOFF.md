# DURIN — Handoff Package

**Date:** 2026-11-20  
**Milestone reached:** M0–M8 scaffold complete (sandbox)  
**Stack position:** Layer 3 of the FORGE stack

## What this is

DURIN is an institutional API-first orchestration platform for African markets (ZAR + USDC first):

- Multi-tenant organisations + API keys
- Double-entry ledger (source of truth)
- Sandbox payments, conversions, wallets
- Hard boundaries: no fiat deposits on DURIN books, no private keys

## Milestones included

| M | Name | Status |
|---|------|--------|
| M0 | Foundations | done |
| M1 | Developer platform | done |
| M2 | Double-entry ledger | done |
| M3 | Payments (sandbox) | done |
| M4 | Conversion (sandbox) | done |
| M5 | Wallets + Layer1 port | done |
| M6 | Compliance skeleton | done (sandbox) |
| M7 | Dashboard scaffold | done |
| M8 | Hardening baseline | partial (checklist + headers) |

## Docs (read first)

1. `docs/REPOSITORY_AUDIT.md`
2. `docs/ARCHITECTURE.md`
3. `docs/DATABASE_SCHEMA.md`
4. `docs/API_SPECIFICATION.md`
5. `docs/IMPLEMENTATION_ROADMAP.md`
6. `docs/SECURITY_AND_RISK.md`
7. `docs/M1_STATUS.md` … `docs/M5_STATUS.md`

## Run locally

```bash
cp .env.example .env
docker compose -f infrastructure/docker-compose.yml up -d
pnpm install
pnpm db:generate
pnpm --filter @durin/api exec prisma migrate dev --name init
pnpm dev:api
# GET http://localhost:3000/health
```

Bootstrap:

```bash
curl -s -X POST http://localhost:3000/v1/organisations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo Org"}'
# Use returned apiKey.secret as Bearer token
```

## Important labels

- Almost all money movement is **`simulated`**
- Live ZAR↔USDC conversion is **`awaiting_regulatory_approval` (G1)**
- Layer 1 live adapters are **`awaiting credentials`**

## Layout

```
durin/
├── apps/api/           # NestJS modular monolith
├── packages/ledger/    # Decimal + journal validation
├── packages/shared/
├── infrastructure/     # docker-compose (Postgres 16, Redis)
├── docs/               # Architecture + milestone status
└── README.md
```

## For Claude / next implementer

- Do **not** put private keys or customer fiat deposits in DURIN
- Ledger invariants are non-negotiable
- Prefer extending `Layer1Port` / `Layer2Port` over coupling to vendors
- Next logical work: M6 compliance skeleton, then dashboard (M7), then hardening (M8)
- Replace SHA-256 API key hashing with argon2id before production

## Updates since first handoff

- API keys: **scrypt** hashing (legacy SHA-256 still accepted)
- Global **rate limit** guard (in-memory; Redis recommended for prod)
- **Layer2Port** + FORGE Mutual sandbox adapter + integration docs
- Dashboard **API client** wiring on Overview (env-based)
- `scripts/load-test-health.mjs` + `scripts/bootstrap-local.sh`
- Integration contracts: `docs/integrations/{FORGE_MUTUAL,OPENFIREBLOCKS,A_CARD}.md`

### Still requires your machine (network + Docker)

```bash
./scripts/bootstrap-local.sh
```

This environment could not complete `pnpm install` (npm registry 502/timeout) or run Docker.
