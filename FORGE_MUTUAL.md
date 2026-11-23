# FORGE Mutual (Layer 2) integration contract

DURIN talks to FORGE Mutual **only** via `Layer2Port` (`apps/api/src/providers/layer2`).

## Sandbox

`SandboxLayer2Adapter` — simulated deposit instructions and payouts. Status: **simulated**.

## Live adapter (awaiting credentials / commercial agreement)

Implement `Layer2Port` against FORGE Mutual ledger-gateway APIs (CreateAccounts / CreateTransfers style, or the bank’s public settlement API).

### Rules
- DURIN never stores customer fiat balances as deposits it controls.
- Settlement references only; reconciliation jobs compare DURIN ledger vs Layer 2 reported balances.
- Activate with `LAYER2_ADAPTER=forge-mutual` only when credentials exist.

This package intentionally does **not** vendor the FORGE Mutual source tree.
