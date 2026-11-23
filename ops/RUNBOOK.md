# DURIN operations runbook

Status: **draft, untested in production.** Targets below are proposals for the business to approve, not commitments.

## Objectives (proposed — set and sign off before launch)
| Item | Proposal | Measured so far |
|---|---|---|
| RPO (data loss tolerated) | ≤ 5 min (continuous WAL archiving / PITR) | Not configured here — requires managed Postgres PITR |
| RTO (time to restore service) | ≤ 1 h | Restore drill on a 176 KB test dataset took < 1 s; **meaningless for production size** — re-measure on a production-size copy |

## Backups
- Use managed Postgres with point-in-time recovery and cross-region copies; retain ≥ 35 days. Encrypt at rest; restrict restore access.
- `scripts/backup-restore-drill.sh` restores a logical dump into a scratch database and re-checks ledger invariants (balanced journals, balances == derived, no illegal negatives, triggers present, lines immutable). **Run weekly and after every migration; alert on failure.** Last run (test data, local): PASSED.
- Never restore over production directly. Restore to a new instance, run the drill checks, then cut over.
- After any restore: run `POST /v1/reconciliation/runs` for every organisation before re-opening traffic. A restored ledger that is *behind* the custodians will show breaks — that is the signal to replay provider events, not to edit balances.

## Alerts (ops/alerts.rules.yml)

### Unknown provider outcome
A liquidity/custody call timed out or errored; funds are **reserved** and the order must not be re-sent.
1. `GET /v1/conversions?…` find `providerUnknown: true`.
2. `POST /v1/conversions/{id}/resolve` — asks the provider; settles or fails automatically if it answers.
3. If the provider has *no record* after it confirms in writing the order never executed: `POST …/resolve {"confirmNotExecuted": true}` (requires `conversions:resolve` and MFA). Record the provider's confirmation in the incident.
4. Never "fix" by re-posting a conversion or editing balances.

### Reconciliation break
1. `GET /v1/reconciliation/breaks?status=open`. Kinds: `custody_mismatch`, `insolvent`, `provider_error`.
2. `provider_error` — the custodian could not be queried: check credentials/outage; it is never treated as a match.
3. `custody_mismatch` — compare the custodian statement with the ledger journals for the asset around `createdAt`; find the missing/extra event. Fix by posting a **correcting journal** with a reference to the incident, never by editing rows (they are immutable).
4. `insolvent` — custody + LP clearing < customer balances + in-transit: **stop withdrawals and conversions** for the asset (see Kill switches) until explained. Escalate to the MLRO/finance lead.
5. Acknowledge only after a correcting entry or documented explanation; acknowledgement changes no balance.

### Stuck withdrawal
Withdrawal `requested`/`processing` > 10 min. The ledger debit is already posted. Query the custodian by `clientReference` (= withdrawal id); if confirmed, update status; if the custodian rejects, the reversal journal posts automatically; if unknown, treat as *unknown outcome* above.

## Kill switches
- `CONVERSION_LIVE_ENABLED` unset/false → all live conversion stops (restart required). Revoke G1: `POST /v1/compliance/gates/g1/{id}/revoke` closes it immediately without restart.
- Suspend an organisation: set `organisations.status != 'active'` (WorkOS users are refused; revoke API keys with `DELETE /v1/api_keys/{id}`).
- Disable a chain: remove it from `ENABLED_CHAINS` and restart.

## Secrets
Rotate on suspected exposure and at least annually: Didit API key / webhook secret (use `DIDIT_WEBHOOK_SECRET_PREVIOUS` for overlap), WorkOS API key, `METRICS_TOKEN`, database passwords. `DURIN_ENCRYPTION_KEY` rotation is **not implemented** (would require re-encrypting webhook secrets).

## Incident basics
Severity, comms and post-incident review process are an organisational decision and are not defined here.
