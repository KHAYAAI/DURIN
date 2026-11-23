# openfireblocks / open-privy (Layer 1) integration contract

DURIN talks to custody **only** via `Layer1Port` (`apps/api/src/providers/layer1`).

## Sandbox

`SandboxLayer1Adapter` — fake addresses and tx hashes. Status: **simulated**.

## Live

- Prefer **openfireblocks** for institutional threshold custody.
- **open-privy** for embedded custodial UX (if product requires).
- Map: createWallet → externalRef; createDepositAddress; requestWithdrawal; never receive private keys.

Set `LAYER1_ADAPTER=openfireblocks` when credentials and network access are available.

This package does **not** include the openfireblocks or open-privy repositories.
