# M3 Payments (Sandbox) — Status

**Status:** Implemented (sandbox). No real chain monitoring or banking rails.

## Delivered

| Capability | Status | Notes |
|------------|--------|-------|
| Payment intents | `implemented` | Create, list, get, cancel |
| Simulated payment instructions | `simulated` | Fake Sepolia address / EFT reference |
| Sandbox confirm → settle | `simulated` | `POST …/simulate_confirm` |
| Ledger integration on settle | `implemented` | Debit settlement asset, credit customer liability |
| Auto-provision settlement accounts | `implemented` | Per asset, per organisation |
| Payment links | `implemented` | Metadata + slug URL (hosted checkout later) |
| Idempotency on intent create | `implemented` | Via header + unique constraint |
| Supported assets (sandbox) | USDC, USDT, ZAR | |

## Endpoints

| Method | Path | Scope |
|--------|------|-------|
| POST | `/v1/payment_intents` | payments:write |
| GET | `/v1/payment_intents` | payments:read |
| GET | `/v1/payment_intents/:id` | payments:read |
| POST | `/v1/payment_intents/:id/simulate_confirm` | payments:write |
| POST | `/v1/payment_intents/:id/cancel` | payments:write |
| POST | `/v1/payment_links` | payments:write |
| GET | `/v1/payment_links` | payments:read |
| GET | `/v1/payment_links/:id` | payments:read |

## Lifecycle

```
created / pending
    → (customer "pays" — simulated)
simulate_confirm
    → ledger journal posted
    → settled
```

Cancel is allowed only before settle.

## Example

```bash
# Create intent
curl -s -X POST http://localhost:3000/v1/payment_intents \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pi-001' \
  -d '{"amount":"250.00","assetCode":"USDC","description":"Invoice 42"}' | jq

# Simulate customer payment + ledger settle
curl -s -X POST http://localhost:3000/v1/payment_intents/$ID/simulate_confirm \
  -H "Authorization: Bearer $KEY" | jq

# Balances now reflect debit asset / credit liability
curl -s http://localhost:3000/v1/accounts -H "Authorization: Bearer $KEY" | jq
```

## Explicit non-goals (M3)

- Real blockchain monitoring
- Hosted checkout UI
- Refunds / partial capture
- Subscriptions
- Live Layer 1 deposit detection

## Next

**M4 — Conversion (sandbox)** — quotes, ZAR↔USDC conversion state machine, sandbox settlement, webhooks
