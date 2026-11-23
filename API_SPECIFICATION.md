# API_SPECIFICATION.md — DURIN

**Status:** Approved 2026-11-20  
**Style:** REST, OpenAPI 3.1, versioned under `/v1`

## 1. Conventions

- Base path: `/v1`
- Authentication: `Authorization: Bearer <api_key>` (or organisation-scoped key)
- Idempotency: `Idempotency-Key` header on all mutating financial endpoints
- Amounts: decimal strings (e.g. `"1000.50"`), never numbers
- Errors: RFC 9457 Problem Details
- Webhooks: signed (`DURIN-Signature`), at-least-once delivery with retries

### Idempotency semantics

| Situation | Behaviour |
|-----------|-----------|
| First request | Process and store result under key |
| Replay of completed request | Return original response (same status + body) |
| Concurrent in-progress | Second request waits or receives `409` / `425` according to policy |
| Key reused with different body | `409 Conflict` |

## 2. Core resource groups

### Organisations & keys
- `POST /v1/organisations`
- `GET /v1/organisations/:id`
- `POST /v1/organisations/:id/api_keys`
- `GET /v1/organisations/:id/api_keys`
- `DELETE /v1/organisations/:id/api_keys/:keyId`

### Accounts & balances (ledger)
- `GET /v1/accounts`
- `POST /v1/accounts`
- `GET /v1/accounts/:id`
- `GET /v1/accounts/:id/balances`
- `GET /v1/journals`
- `GET /v1/journals/:id`

### Payments
- `POST /v1/payment_intents`
- `GET /v1/payment_intents/:id`
- `POST /v1/payment_intents/:id/confirm`
- `POST /v1/payment_links`
- `GET /v1/payment_links/:id`

### Quotes & conversions
- `POST /v1/quotes` — request ZAR↔USDC (or other supported) quote
- `GET /v1/quotes/:id`
- `POST /v1/conversions` — accept quote and start conversion (idempotent)
- `GET /v1/conversions/:id`

### Wallets (orchestration)
- `POST /v1/wallets`
- `GET /v1/wallets/:id`
- `POST /v1/wallets/:id/addresses`
- `POST /v1/withdrawals`
- `GET /v1/withdrawals/:id`

### Webhooks
- `POST /v1/webhook_endpoints`
- `GET /v1/webhook_endpoints`
- `POST /v1/webhook_endpoints/:id/rotate_secret`

## 3. Critical flows (contracts)

### Quote → Convert (sandbox)

1. `POST /v1/quotes`  
   Body: `{ "source_asset": "ZAR", "target_asset": "USDC", "source_amount": "10000.00" }`  
   → returns quote with rate, fees, expiry, `quote_id`

2. `POST /v1/conversions`  
   Headers: `Idempotency-Key: ...`  
   Body: `{ "quote_id": "..." }`  
   → returns conversion in `processing` / `settlement_pending` / `settled` (sandbox may complete synchronously or via worker)

3. Webhook: `conversion.settled` or `conversion.failed`

### Stablecoin payment acceptance

1. `POST /v1/payment_intents` with amount + asset + success/cancel URLs or confirmation method
2. Customer pays on-chain to the address / intent instructions provided
3. Monitoring (via Layer 1 port or chain adapter) detects payment
4. Intent moves to `confirmed` → ledger posting → `settled`
5. Webhook: `payment_intent.settled`

### Gated withdrawal

1. `POST /v1/withdrawals` (may require approval according to policy)
2. If approval required → `pending_approval`
3. Approver acts via dashboard or API
4. On approval → Layer 1 withdrawal request
5. On chain confirmation → ledger update + webhook

## 4. Status labels

Every endpoint and module carries an explicit status in documentation and runtime metadata where useful:

- `implemented`
- `simulated`
- `awaiting credentials`
- `awaiting commercial agreement`
- `awaiting regulatory approval`
- `production-ready`

Live ZAR↔USDC conversion endpoints remain `awaiting regulatory approval` until gate G1 is cleared.