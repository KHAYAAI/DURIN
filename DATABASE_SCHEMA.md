# DATABASE_SCHEMA.md — DURIN

**Status:** Approved 2026-11-20  
**Database:** PostgreSQL 16  
**Access:** Prisma + explicit SQL migrations

## 1. Design principles

- The ledger is the source of truth for all value inside DURIN.
- All financial amounts use `numeric` (or equivalent precise type). Never `float`/`double`.
- Journal entries are immutable once posted.
- Every financial write is idempotent by `(organisation_id, idempotency_key)`.
- Tenant isolation is enforced on every table that carries customer data (`organisation_id`).

## 2. Core ledger schema

### organisations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| name | text | |
| status | text | `active`, `suspended`, … |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### accounts
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| organisation_id | uuid FK | Tenant |
| code | text | Human-readable code within org |
| name | text | |
| account_type | text | `asset`, `liability`, `equity`, `revenue`, `expense`, `system` |
| asset_code | text | `ZAR`, `USDC`, … |
| currency_or_asset | text | Normalised asset identifier |
| allow_negative | boolean | Default false |
| status | text | `active`, `closed` |
| created_at | timestamptz | |
| unique | (organisation_id, code) | |

### balances
Materialised or derived view/table maintaining:

- `available` — funds that can be spent
- `pending` — funds in flight
- `reserved` — funds held for approvals / holds

Updated only inside the same transaction as the journal posting.

### journals
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| organisation_id | uuid FK | |
| reference | text | External or internal reference |
| description | text | |
| posted_at | timestamptz | Immutable after insert |
| value_date | date | |
| status | text | `posted` (only posted journals exist) |
| idempotency_key | text | |
| unique | (organisation_id, idempotency_key) | Where key present |

### journal_lines
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| journal_id | uuid FK | |
| account_id | uuid FK | |
| direction | text | `debit` or `credit` |
| amount | numeric(36,18) | Strictly positive |
| asset_code | text | Must match account |
| metadata | jsonb | Optional |

**Invariant (enforced in transaction):**  
For every journal, `SUM(amount) WHERE direction = 'debit' = SUM(amount) WHERE direction = 'credit'`.

## 3. Supporting domains (summary)

### Identity & developer platform
- `users`, `organisation_members`, `roles`, `api_keys` (hashed), `webhook_endpoints`, `idempotency_records`

### Payments
- `payment_intents`, `payment_links`, `customers`, `subscriptions`, `payment_events`

### Conversion
- `quotes`, `conversions`, `fx_rates` (or external rate snapshots)

### Wallets (orchestration only)
- `wallets`, `deposit_addresses` (reference to Layer 1), `withdrawal_requests`

### Compliance
- `verification_records`, `screening_results`, `limits`, `approval_requests`

### Settlement & providers
- `providers`, `provider_accounts`, `settlement_instructions`, `reconciliation_runs`

### Infrastructure
- `outbox_events`, `audit_log` (append-only)

## 4. Ledger invariants (must be tested)

1. **Balanced journal** — Every posted journal has equal total debits and credits.
2. **Non-negative available** — Unless `allow_negative = true`, available balance ≥ 0 after posting.
3. **Idempotent posting** — Same `(organisation_id, idempotency_key)` never creates a second journal.
4. **Asset consistency** — Lines only post to accounts whose `asset_code` matches the line.

These are enforced both in application code (domain service) and, where practical, with database constraints / deferred triggers / application-level checks inside a single transaction.

## 5. Migration discipline

- All schema changes are explicit SQL or Prisma migrations reviewed as financial code.
- No `synchronize: true` in any non-development environment.
- Destructive changes require a written rollback plan.