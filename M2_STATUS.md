> **Historical.** This describes the original scaffold. Several claims here were corrected or superseded; see [STATUS.md](STATUS.md).

# M2 Double-Entry Ledger — Status

**Status:** Implemented (domain + API + unit tests). Requires migrate + local run to verify end-to-end.

## Delivered

| Capability | Status | Notes |
|------------|--------|-------|
| Precise decimal arithmetic | `implemented` | Scaled bigint, 18 fractional digits, no float |
| Journal validation (balanced, positive amounts, per-asset) | `implemented` | Pure functions in `@durin/ledger` |
| Ledger accounts CRUD | `implemented` | Create + list + get; unique code per org |
| Balance rows (available / pending / reserved) | `implemented` | Initialised at 0; available updated on post |
| Atomic journal posting | `implemented` | Single DB transaction; balance locks |
| Non-negative available (unless allowNegative) | `implemented` | Rejected with `NEGATIVE_BALANCE` |
| Asset consistency on lines | `implemented` | Line asset must match account asset |
| Idempotent posting via `Idempotency-Key` | `implemented` | Journal unique on (org, key) |
| Tenant isolation | `implemented` | All queries scoped by organisationId |
| Unit tests (decimal + invariants) | `implemented` | Vitest in `packages/ledger` |

## Endpoints

| Method | Path | Scope |
|--------|------|-------|
| POST | `/v1/accounts` | admin |
| GET | `/v1/accounts` | organisations:read |
| GET | `/v1/accounts/:id` | organisations:read |
| GET | `/v1/accounts/:id/balances` | organisations:read |
| POST | `/v1/journals` | admin (+ Idempotency-Key) |
| GET | `/v1/journals` | organisations:read |
| GET | `/v1/journals/:id` | organisations:read |

## Example flow

```bash
# After bootstrap org + API key from M1…

# Create cash (asset) and customer liability accounts
curl -X POST http://localhost:3000/v1/accounts \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"code":"CASH-ZAR","name":"Cash ZAR","accountType":"asset","assetCode":"ZAR"}'

curl -X POST http://localhost:3000/v1/accounts \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"code":"CUST-LIAB-ZAR","name":"Customer liability ZAR","accountType":"liability","assetCode":"ZAR"}'

# Post journal: debit cash 1000, credit liability 1000
curl -X POST http://localhost:3000/v1/journals \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: dep-001' \
  -d '{
    "reference": "customer-deposit",
    "description": "Sandbox deposit",
    "lines": [
      {"accountId":"<CASH_ID>","direction":"debit","amount":"1000.00","assetCode":"ZAR"},
      {"accountId":"<LIAB_ID>","direction":"credit","amount":"1000.00","assetCode":"ZAR"}
    ]
  }'
```

## Invariants enforced

1. **Balanced journal** — Σ debits = Σ credits per asset  
2. **Non-negative available** — unless `allowNegative`  
3. **Idempotent posting** — same key returns original journal  
4. **Asset consistency** — line asset matches account asset  
5. **Tenant isolation** — accounts/journals never cross organisations  

## Not yet in M2

- Pending / reserved balance transitions (hooks ready; used by payments/conversion later)
- Reversals / adjusting entries as first-class operations
- Property-based concurrency tests against real Postgres (Testcontainers) — planned when install works
- Multi-currency revaluation journals

## Next

**M3 — Payments (sandbox)** — payment intents, links, simulated stablecoin acceptance, ledger integration
