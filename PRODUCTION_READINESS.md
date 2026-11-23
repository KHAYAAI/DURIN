# DURIN — production readiness

**DURIN is not production-ready.** This document separates what is built and tested from what only external parties can supply. "Tests pass" is not a readiness claim.

## Built and tested in this repository
| Area | State | Evidence |
|---|---|---|
| Double-entry ledger, DB-enforced invariants | Implemented | `api/test/ledger.int.spec.ts` (property tests, concurrency) |
| **Custody-reference chart** (DURIN holds no customer funds; mirrors custodians) | Implemented | `api/src/ledger/chart.ts`; `conversion-recon.int.spec.ts` |
| **Conversion state machine** — reserve → LP call → fill → settle; customer credited on delivery; unknown LP outcome stays reserved and is never re-sent | Implemented against a *sandbox* LP | `conversion-recon.int.spec.ts` |
| **Reconciliation** — ledger custody vs custodian-reported balances, solvency check, breaks, acknowledgement, worker | Implemented; sandbox compares to *simulated* balances | `conversion-recon.int.spec.ts` |
| **Didit KYC/KYB** — session creation, `X-Signature-V2` verification (independent golden vector), event dedupe, no self-approval | Implemented against a fake Didit server | `didit.spec.ts`, `didit.int.spec.ts` |
| **WorkOS** — JWKS token verification, org mapping, scope mapping, session-bound TOTP step-up (attempt limit, single use), SSO Admin Portal link | Implemented against a local JWKS + fake WorkOS | `workos.int.spec.ts` |
| Dashboard behind AuthKit; calls API as the signed-in user; fails closed in production | Implemented; verified by build + runtime smoke | see PR |
| Gate G1 as an explicit operator flag; KYB required for live conversion | Implemented | `conversions/live-gate.ts` |

## Not done — requires external parties or decisions
1. **Live provider adapters** — Layer 1 custody (openfireblocks), Layer 2 fiat (FORGE Mutual), liquidity provider. Ports and sandbox adapters exist; live ones need agreements, credentials, their sandboxes and API docs. `LIQUIDITY_ADAPTER` other than `sandbox` throws until one is registered.
2. **Gate G1 — counsel sign-off** on live conversion. Until then `CONVERSION_LIVE_ENABLED` stays unset and production refuses conversions.
3. **Didit account configuration** — KYB and KYC workflows, webhook destination (v3, `status.updated`) pointing at `/v1/webhooks/didit`, secrets. Provider mapping of Didit KYB outcomes to DURIN policy needs compliance review.
4. **WorkOS environment configuration** — AuthKit redirect URI, organizations linked to DURIN organisations (`PUT /v1/auth/workos/organisation`), roles/permissions using the scope slugs, SSO connections via Admin Portal, MFA policy. MFA for SSO users is DURIN-enforced (TOTP step-up) because WorkOS Required MFA does not cover SSO sign-ins.
5. **Independent security review**, penetration test, key-management/KMS for `DURIN_ENCRYPTION_KEY`, backup/restore and DR drills, observability and alerting, load testing against production-like data.
6. **Per-chain policy** — enabled `(asset, chain)` allow-list, confirmation depths, native-vs-bridged checks, transaction monitoring (see `CHAIN_STRATEGY.md`).
7. **Known gaps** — deposits are not detected from chain (sandbox simulates them); no withdrawal approvals workflow gating live sends; Redis/shared rate limiting for multi-instance; pagination; encryption-key rotation.

## Boundary check against the approved docs
The approved docs say DURIN must not hold customer fiat deposits. The ledger now records `CUSTODY-REF-*` accounts that **mirror** what Layer 1/Layer 2 report, and reconciliation fails (breaks) if they diverge or if custody + LP clearing < customer entitlements + in-transit. Whether the *legal* structure satisfies the boundary is a counsel question, not something code can establish.
