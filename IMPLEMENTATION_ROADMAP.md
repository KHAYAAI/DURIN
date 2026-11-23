# IMPLEMENTATION_ROADMAP.md — DURIN

**Status:** Approved 2026-11-20  
**Approach:** Hybrid (C) — core built fresh; FiatDesk used for API shape & contract reference only

## Milestone overview

| Milestone | Name | Goal | Gate |
|-----------|------|------|------|
| **M0** | Foundations | Repo, CI, Docker, base NestJS app, health, lint, test harness | — |
| **M1** | Developer platform | Orgs, users, API keys, idempotency store, basic auth | — |
| **M2** | Double-entry ledger | Accounts, journals, balances, invariants, property tests | Ledger invariants hold under concurrency |
| **M3** | Payments (sandbox) | Payment intents, links, simulated stablecoin acceptance, ledger integration | — |
| **M4** | Conversion (sandbox) | Quotes, conversion state machine, sandbox ZAR↔USDC, webhooks | G1: legal review before any live corridor |
| **M5** | Wallets & Layer 1 port | Address orchestration, deposit monitoring, withdrawal requests (sandbox + port) | — |
| **M6** | Compliance skeleton | Verification status, limits, approval workflows, audit log | — |
| **M7** | Dashboard | Institutional UI for balances, transactions, approvals, developer tools | — |
| **M8** | Hardening | Load tests, security review prep, reconciliation jobs, production readiness checklist | Production criteria |

**Smallest viable path (thesis demonstration):** M0 → M1 → M2 → M3 → M4  
After M4 an institution can hold ledger balances, receive simulated deposits, and execute a **sandbox** ZAR↔USDC conversion end-to-end.

## M0 — Foundations (immediate)

Deliverables:
- pnpm workspace monorepo
- `apps/api` NestJS application
- `packages/ledger` (empty shell with types)
- `packages/shared`
- Docker Compose: PostgreSQL 16, Redis
- Prisma initialised
- Health endpoint `GET /health`
- ESLint + Prettier + TypeScript strict
- Vitest + Testcontainers wiring
- GitHub Actions (or equivalent) CI skeleton
- README with local run instructions
- Status labelling convention documented

## Status labelling system

Every module, adapter and critical endpoint must declare one of:

| Label | Meaning |
|-------|---------|
| `implemented` | Code complete and tested for the claimed behaviour |
| `simulated` | Behaviour is fake / deterministic sandbox |
| `awaiting credentials` | Live adapter exists but credentials not configured |
| `awaiting commercial agreement` | Integration blocked on contract |
| `awaiting regulatory approval` | Blocked on licence / legal gate |
| `production-ready` | Passed security, reconciliation, operational criteria |

## Dependency graph (simplified)

```
M0 Foundations
 └── M1 Developer platform
      └── M2 Ledger
           ├── M3 Payments
           └── M4 Conversion (sandbox)
                └── (G1 legal gate) → live corridor
           └── M5 Wallets / Layer 1
                └── M6 Compliance
                     └── M7 Dashboard
                          └── M8 Hardening
```

## Explicit non-goals until later milestones

- Live banking or liquidity credentials
- Real custody key material
- Multi-chain production support
- Card issuing
- Own stablecoin
- Kubernetes / complex infra

## Current focus

**M0 is the active milestone.**