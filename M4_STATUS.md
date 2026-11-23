> **Historical.** This describes the original scaffold. Several claims here were corrected or superseded; see [STATUS.md](STATUS.md).

# M4 Conversion (Sandbox) — Status

**Status:** Implemented (sandbox). Live ZAR↔USDC remains **awaiting regulatory approval (G1)**.

## Delivered

| Capability | Status | Notes |
|------------|--------|-------|
| Quotes (ZAR ↔ USDC / USDT) | `simulated` | Fixed sandbox rates + 30 bps fee |
| Quote expiry | `implemented` | 60 seconds |
| Accept quote → conversion | `implemented` | Idempotent |
| Multi-asset ledger journal | `implemented` | Source + target legs balanced independently |
| Fee revenue account | `implemented` | `FEE-REVENUE-{ASSET}` |
| Sandbox pre-fund | `simulated` | Auto top-up liability so demos work without prior deposit |
| Immediate settle in sandbox | `simulated` | No external liquidity provider |

## Endpoints

| Method | Path | Scope |
|--------|------|-------|
| POST | `/v1/quotes` | conversions:write |
| GET | `/v1/quotes/:id` | conversions:read |
| POST | `/v1/conversions` | conversions:write |
| GET | `/v1/conversions` | conversions:read |
| GET | `/v1/conversions/:id` | conversions:read |

## Example

```bash
# Quote: 10,000 ZAR → USDC
curl -s -X POST http://localhost:3000/v1/quotes \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"sourceAsset":"ZAR","targetAsset":"USDC","sourceAmount":"10000"}' | jq

# Accept (settle in sandbox)
curl -s -X POST http://localhost:3000/v1/conversions \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: conv-001' \
  -d '{"quoteId":"'"$QUOTE_ID"'"}' | jq
```

## State machine

```
quote: open → accepted | expired | cancelled
conversion: accepted → processing → settlement_pending → settled
            ↘ failed | expired
```

Sandbox path collapses to **accepted → settled** in one step.

## Regulatory gate G1

Live conversion endpoints must remain labelled **`awaiting_regulatory_approval`** until counsel clears the ZAR↔USDC operating model. Sandbox rates are explicitly not market data.

## Smallest viable path (M0–M4) complete

An institution can now:

1. Create an organisation + API key (M1)
2. Hold ledger balances (M2)
3. Accept simulated stablecoin payments (M3)
4. Execute a sandbox ZAR↔USDC conversion (M4)

## Next

**M5 — Wallets & Layer 1 port** (address orchestration, deposit monitoring stubs, withdrawal requests)
