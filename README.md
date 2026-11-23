# DURIN

**Institutional digital financial infrastructure — Layer 3 of the FORGE stack.**
One API. Multiple financial rails. A double-entry ledger as the source of truth.

> **Not launch-ready.** This branch holds documents and a scaffold only; see the branch map below.

## Where things are

| Branch | Contents |
|---|---|
| `main` | Handoff documents and the original scaffold |
| `import/uploaded-handoff` | The uploaded handoff, unmodified |
| `feat/runnable-workspace` | A runnable, tested **sandbox** (ledger, API, dashboard, CI) — PR #1 |
| `feat/workos-didit-production` | Custody-reference ledger, conversion state machine, reconciliation, Didit KYC/KYB, WorkOS SSO/MFA, readiness and chain docs — PR #2 |

## Launch readiness (summary)

Built and tested in the sandbox: double-entry ledger, idempotency, signed webhooks, reconciliation,
Didit and WorkOS integrations (against fakes). **Not done:** live custody / fiat / liquidity adapters
(need agreements and credentials), counsel sign-off on live conversion (gate G1), Didit and WorkOS
account configuration, per-chain policy, security review, disaster-recovery drills.
Full assessment: `PRODUCTION_READINESS.md` and `CHAIN_STRATEGY.md` on `feat/workos-didit-production`.

## Hard boundaries
DURIN holds no private keys (Layer 1) and no customer fiat deposits (Layer 2).

## Docs
[ARCHITECTURE](ARCHITECTURE.md) · [DATABASE_SCHEMA](DATABASE_SCHEMA.md) · [API_SPECIFICATION](API_SPECIFICATION.md) · [IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md) · [HANDOFF](HANDOFF.md)

## Licence
Proprietary — all rights reserved until otherwise stated.
