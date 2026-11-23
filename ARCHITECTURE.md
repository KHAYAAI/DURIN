# ARCHITECTURE.md — DURIN

**Status:** Approved 2026-11-20  
**Stack position:** Layer 3 of the FORGE stack  
**Style:** Modular monolith

## 1. Purpose

DURIN is the institutional orchestration and financial control platform. It provides a unified API for payments, fiat↔stablecoin conversion, wallet orchestration, compliance, and settlement while enforcing hard boundaries:

- No fiat deposits on DURIN’s books (Layer 2 = FORGE Mutual)
- No private key material (Layer 1 = openfireblocks / open-privy)
- Double-entry ledger is the only source of truth for value inside DURIN

## 2. High-level architecture

```
Client Applications
        │  REST /v1 + Webhooks + SDKs
        ▼
┌───────────────────────────────────────┐
│         API Gateway (NestJS)          │
│  Auth · API Keys · Idempotency ·      │
│  Rate limits · Validation · Tenancy   │
└───────────────────┬───────────────────┘
                    │
     ┌──────────────┼──────────────┐
     │              │              │
┌────▼────┐   ┌─────▼─────┐  ┌─────▼─────┐
│Payments │   │Conversion │  │  Wallets  │
│ Domain  │   │  Domain   │  │  Domain   │
└────┬────┘   └─────┬─────┘  └─────┬─────┘
     │              │              │
     └──────────────┼──────────────┘
                    │
┌───────────────────▼───────────────────┐
│     Financial Ledger (packages/ledger) │
│  Double-entry · Invariants · Audit     │
└───────────────────┬───────────────────┘
                    │
┌───────────────────▼───────────────────┐
│  Provider Ports (adapters)            │
│  Layer1Port · Layer2Port ·            │
│  LiquidityPort · CompliancePort       │
│  (Sandbox + Live implementations)     │
└───────────────────────────────────────┘
```

Cross-cutting:
- Compliance & Risk (limits, screening results, approval workflows)
- Outbox + BullMQ workers (webhooks, monitoring, settlement jobs)
- Institutional Dashboard (Next.js)

## 3. Core invariants (enforced in code)

1. **Conservation** — Every journal entry is balanced (sum of debits = sum of credits) within a single database transaction.
2. **No negative available balance** — An account’s available balance cannot go below zero unless explicitly allowed by account type (e.g. system clearing).
3. **Idempotency** — Financial operations identified by `(organisation_id, idempotency_key)` return the original result on replay; concurrent in-progress requests are handled safely.
4. **Tenant isolation** — All queries are scoped by `organisation_id`. Row-level security or equivalent application enforcement is mandatory.
5. **No key material** — DURIN never stores, logs, or transmits private keys or seed phrases.
6. **No fiat on books** — Fiat balances are references to Layer 2 settlement accounts; DURIN records obligations and movements, not customer deposits.

## 4. Module map

| Module | Responsibility | Package / location |
|--------|----------------|--------------------|
| Identity & Organisations | Orgs, users, memberships, RBAC | `apps/api` |
| Developer Platform | API keys, webhooks, idempotency store | `apps/api` |
| Ledger | Accounts, balances, journals, postings | `packages/ledger` |
| Payments | Intents, links, checkout, subscriptions | `apps/api` |
| Conversion | Quotes, FX, routing, conversion state machine | `apps/api` |
| Wallets | Address metadata, deposit monitoring, withdrawal requests | `apps/api` |
| Compliance | Verification status, screening, limits, approvals | `apps/api` |
| Providers | Adapter registry, health, routing rules | `apps/api` |
| Settlement | Coordination of legs, reconciliation | `apps/api` |
| Dashboard | Institutional UI | `apps/dashboard` |

## 5. Technology decisions (locked)

| Concern | Choice |
|---------|--------|
| Runtime | Node.js ≥ 20 |
| Language | TypeScript (strict) |
| Framework | NestJS |
| Database | PostgreSQL 16 |
| ORM / migrations | Prisma + reviewed SQL migrations |
| Cache / queues | Redis + BullMQ |
| API | REST, OpenAPI 3.1, `/v1` |
| Tests | Vitest + Testcontainers |
| Monorepo | pnpm workspaces |
| Money | Decimal strings in API; `numeric` / precise types in DB; no floating-point |

## 6. Provider port pattern

All external systems are accessed through ports:

```typescript
interface Layer1Port {
  createDepositAddress(params: CreateAddressParams): Promise<DepositAddress>;
  getBalance(addressId: string): Promise<AssetBalance>;
  requestWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult>;
  // ...
}

interface Layer2Port {
  initiateFiatDeposit(params: FiatDepositParams): Promise<FiatInstruction>;
  initiateFiatPayout(params: FiatPayoutParams): Promise<PayoutResult>;
  // ...
}
```

- **Sandbox adapters** are the default in development and CI.
- **Live adapters** are activated only when credentials and commercial agreements exist.
- Status labels on every module: `implemented | simulated | awaiting credentials | awaiting commercial agreement | awaiting regulatory approval | production-ready`.

## 7. Transaction state machines (summary)

**Payment:** `created → pending → requires_action → processing → confirmed → settled | failed | cancelled | expired | reversed`

**Conversion:** `quoted → accepted → processing → settlement_pending → settled | failed | expired`

**Withdrawal:** `requested → pending_approval → approved → processing → submitted → confirmed | failed | cancelled`

Exact transitions and guards are defined in domain services and tested.

## 8. Pending decisions log

| ID | Decision | Status |
|----|----------|--------|
| D1 | NestJS modular monolith | Approved |
| D2 | PostgreSQL + Prisma | Approved |
| D3 | REST + OpenAPI | Approved |
| D4 | Outbox + BullMQ | Approved |
| D5 | Hybrid reuse of FiatDesk shapes/contracts only | Approved |
| D6 | Live ZAR↔USDC gate (G1) | Blocked pending legal counsel |

## 9. Relationship to other layers

- **Layer 1 (openfireblocks / open-privy):** Custody and signing. DURIN calls via `Layer1Port`.
- **Layer 2 (FORGE Mutual):** Regulated fiat accounts and ZAR settlement. DURIN calls via `Layer2Port`.
- **Layer 4 (A-CARD):** Spend policy and agent controls may sit in front of DURIN APIs.