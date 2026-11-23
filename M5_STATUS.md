> **Historical.** This describes the original scaffold. Several claims here were corrected or superseded; see [STATUS.md](STATUS.md).

# M5 Wallets & Layer 1 Port — Status

**Status:** Implemented (sandbox adapter). Live custody = `awaiting credentials`.

## Delivered

| Capability | Status | Notes |
|------------|--------|-------|
| `Layer1Port` interface | `implemented` | createWallet, address, balances, withdrawal |
| Sandbox Layer 1 adapter | `simulated` | No keys, no broadcast |
| Wallets CRUD | `implemented` | Metadata + externalRef only |
| Deposit addresses | `implemented` | Via Layer1Port |
| Simulate deposit → ledger | `simulated` | Credits settlement accounts |
| Withdrawals | `implemented` | Ledger debit then Layer1 request |
| Key material in DURIN | **never** | Boundary enforced |

## Endpoints

| Method | Path |
|--------|------|
| POST | `/v1/wallets` |
| GET | `/v1/wallets` |
| GET | `/v1/wallets/:id` |
| POST | `/v1/wallets/:id/addresses` |
| POST | `/v1/deposit_addresses/:id/simulate_deposit` |
| POST | `/v1/withdrawals` |
| GET | `/v1/withdrawals` |
| GET | `/v1/withdrawals/:id` |

## Port boundary

```
DURIN  --Layer1Port-->  openfireblocks / open-privy / sandbox
         (no private keys cross this boundary)
```

## Next milestones (not in this package as fully built)

- M6 Compliance skeleton
- M7 Dashboard
- M8 Hardening
