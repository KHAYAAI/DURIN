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
| **Gate G1 record** — a human-recorded, MFA-protected, revocable, expiring counsel sign-off scoped to assets/jurisdictions; live conversion needs it *and* `CONVERSION_LIVE_ENABLED=true` *and* an approved Didit KYB. Records can never be created by an API key | Implemented (the sign-off itself is **not** recorded: that is counsel's decision) | `g1.int.spec.ts` |
| **Chain policy** — enabled-chain allow-list, native-only tokens (bridged/look-alike rejected), confirmation depth, address validation, deposit-detection entry point | Implemented; token identifiers need verification against issuers | `chain-policy.spec.ts`, `chains.int.spec.ts` |
| **Monitoring** — Prometheus `/metrics` (token-protected, no tenant data), alert rules, runbook | Implemented; **not deployed or exercised against a real Prometheus/pager** | `metrics.int.spec.ts`, `ops/` |
| **Backup/restore drill** — dump → restore into scratch DB → re-verify ledger invariants and triggers | Script built and **run successfully on test data** (78 orgs, 261 journals); RPO/RTO on production-size data unmeasured | `scripts/backup-restore-drill.sh` |
| **Adapter contract suite** — idempotent withdrawals/orders, fresh custody snapshots, tenant scoping; runnable against any live adapter's vendor sandbox | Passes for sandbox adapters; it already caught a real gap (non-idempotent sandbox withdrawals) | `test/contract/` |
| **Security hardening from my own review** — secrets excluded from the idempotency store, suspended organisations refused for API keys, operator-only WorkOS linking, cooling-off before "not executed" release, snapshot-staleness check | Implemented | `api.int.spec.ts`, `workos.int.spec.ts`, `conversion-recon.int.spec.ts` |

## Account configuration performed (non-secret identifiers)
- **Didit** (organisation A-CARD, **Sandbox** application only; live application untouched): workflows created and published — *DURIN Business KYB* `65a5d74a-6905-4590-971a-e9bd65641b4e` (registry + documents[LEGAL_PRESENCE required] + key people + AML) and *DURIN Account Holder KYC* `be3877e5-9b0d-4fa2-9d68-123c25160f2a` (OCR + passive liveness + face match + AML + IP analysis). **No webhook destination and no API key were created** (needs a public API URL; secrets must not pass through this session).
- **WorkOS** (A-CARD's Project → **Staging**, client `client_01M079SBRGBJ82933Y70J1KDX2`; production untouched): organisation *DURIN* `org_01M84EDF2A94SVHR4ETQJ8PYRM`; redirect URI `http://localhost:3001/callback`; permissions matching the API scopes (`organisations:read`, `payments:read|write`, `conversions:read|write`, `wallets:read|write`, `ledger:read`, `compliance:read|write`, `reconciliation:read`); roles `durin-viewer`, `durin-operator` (the built-in `admin` role maps to full access). Environment MFA/SSO policy left unchanged.

## Remaining steps to finish configuration (need you)
1. WorkOS dashboard → copy the staging **API key** into `WORKOS_API_KEY`; set `WORKOS_CLIENT_ID=client_01M079SBRGBJ82933Y70J1KDX2`; generate `WORKOS_COOKIE_PASSWORD` (`openssl rand -base64 32`).
2. Didit console → create an API key for the sandbox app (`DIDIT_API_KEY`); set `DIDIT_WORKFLOW_KYB`/`DIDIT_WORKFLOW_KYC` to the IDs above; set `VERIFICATION_PROVIDER=didit`.
3. Once the API has a public HTTPS URL: create a Didit **v3** webhook destination for `status.updated` pointing at `<api>/v1/webhooks/didit` and set `DIDIT_WEBHOOK_SECRET` to its shared secret.
4. Link the DURIN organisation (operator action): `PUT /v1/auth/workos/organisation` with an admin key + `X-Bootstrap-Token`, body `{"workosOrganizationId":"org_01M84EDF2A94SVHR4ETQJ8PYRM"}`.
5. Assign users to the DURIN WorkOS organisation with a role; enrol TOTP on the dashboard Security page.

## Not done — requires external parties or decisions
1. **Live provider adapters** — Layer 1 custody (openfireblocks), Layer 2 fiat (FORGE Mutual), liquidity provider. Ports and sandbox adapters exist; live ones need agreements, credentials, their sandboxes and API docs. `LIQUIDITY_ADAPTER` other than `sandbox` throws until one is registered.
2. **Gate G1 — counsel sign-off** on live conversion. The recording mechanism exists; the sign-off does not. Until counsel signs and a human records it, live conversion is refused.
3. **Didit account configuration** — KYB and KYC workflows, webhook destination (v3, `status.updated`) pointing at `/v1/webhooks/didit`, secrets. Provider mapping of Didit KYB outcomes to DURIN policy needs compliance review.
4. **WorkOS environment configuration** — AuthKit redirect URI, organizations linked to DURIN organisations (`PUT /v1/auth/workos/organisation`), roles/permissions using the scope slugs, SSO connections via Admin Portal, MFA policy. MFA for SSO users is DURIN-enforced (TOTP step-up) because WorkOS Required MFA does not cover SSO sign-ins.
5. **Independent** security review and penetration test (my review above is a self-review, not a substitute), KMS-managed `DURIN_ENCRYPTION_KEY`, PITR/WAL archiving and a measured production-size restore, a real Prometheus + paging setup, load testing, on-call process.
6. **Per-chain live work** — chain-event detection in the live custody adapter, verified token identifiers, transaction monitoring / travel-rule screening (see `CHAIN_STRATEGY.md`). **Reconciliation against real custody** remains impossible until a live adapter exists: the logic, freshness check and contract suite are ready.
7. **Known gaps** — deposits are not detected from chain (sandbox simulates them); no withdrawal approvals workflow gating live sends; Redis/shared rate limiting for multi-instance; pagination; encryption-key rotation.

## Boundary check against the approved docs
The approved docs say DURIN must not hold customer fiat deposits. The ledger now records `CUSTODY-REF-*` accounts that **mirror** what Layer 1/Layer 2 report, and reconciliation fails (breaks) if they diverge or if custody + LP clearing < customer entitlements + in-transit. Whether the *legal* structure satisfies the boundary is a counsel question, not something code can establish.
