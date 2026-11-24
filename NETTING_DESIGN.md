# Liquidity strategy and internal netting — decision and design

**Decision (owner, 2026-11-23):** (1) launch with an external liquidity provider; (2) net opposing customer flows internally and send only the difference to the provider; (3) add a small own inventory later, once volumes, licensing and risk limits are known.

**Status (2026-11-24):** BUILT and tested in the sandbox, **closed by default**. Variant A (atomic matching window) and own-inventory dealing both run through a platform-owned *house organisation*, behind `HOUSE_DEALING` and human-recorded gate approvals **G2** (netting) and **G3** (inventory) on the house organisation. They cannot run in production: the physical custody transfers between customers and the house have no live adapter. **Do not open G2/G3 before counsel answers question 9 in `COUNSEL_BRIEF.md`.**

### How it works as built
- House accounts per asset: `CUSTODY-REF` (mirrors custodian balances), `HOUSE-TRADE` (trading clearing: ZAR balance = realised P&L, stablecoin balance = open position), `HOUSE-CAPITAL` (equity). No journal ever touches two tenants: each customer gets the normal fill/settle journals (the house plays the "liquidity provider"), the house gets its own mirror journals.
- Order inside a batch is fixed: **receive all → hedge the net residual → pay all**. Every step is idempotent (transfer references, journal keys and the provider reference all derive from the conversion/batch id).
- Failure handling: a definitive refusal before payouts **unwinds the batch** and sends each conversion to the external provider; an **unknown** outcome **stalls** the batch (`providerUnknown`, funds held, alert) and an operator re-drives it with `POST /v1/conversions/{id}/resolve`, which asks the provider before doing anything and honours the cooling-off rule.
- Inventory mode fills a single conversion from house holdings if inventory and `HOUSE_LIMITS` allow, else falls back to the provider.

## Why step 2 is not free of step 3's questions
Customers hold **firm quotes at different rates**. If customer A sells ZAR for USDC and customer B sells USDC for ZAR, A and B will almost never be exactly offsetting in amount or price. Delivering to both *immediately*, and hedging only the difference *later*, means DURIN is the counterparty to both customers for a short time and carries the price and amount mismatch in between. That is a small, temporary **principal position** — the same kind of exposure step 3 makes permanent. Two ways to keep step 2 clean:

| Variant | How it works | Principal risk | Cost |
|---|---|---|---|
| **A. Atomic matching** | Only net when both sides can be settled at the same instant at agreed prices; unmatched orders go to the provider at once | None beyond the instant | Lower netting rate; needs a short matching window |
| **B. Net-and-hedge** | Deliver every order immediately from custody; hedge the *net* residual with the provider every N seconds | Position between hedges, bounded by a hard limit | Higher netting rate; **needs a house inventory/credit line and counsel sign-off** |

Recommendation: build **A first** (quote validity is 60 s, so a matching window of a few seconds is compatible), keep **B** behind a position limit and counsel approval.

## Money mechanics (exact decimals; USDC/ZAR example)
Let buyers be ZAR→USDC orders and sellers USDC→ZAR orders in a window.
- `usdcNet = Σ USDC received from sellers − Σ USDC owed to buyers`
- `zarNet  = Σ ZAR received from buyers (net of fee) − Σ ZAR owed to sellers`
- If `usdcNet < 0` DURIN must **buy** `|usdcNet|` USDC from the provider; if `> 0` it must **sell** `usdcNet`. Only that residual goes to the provider.
- Internal spread = `zarNet` minus the ZAR the residual trade costs (or earns) at the provider's executed rate. It can be negative: the quoted prices are firm and the provider's price can move.

## Ledger implications (when wired)
- Matching moves value **between organisations**. The ledger enforces tenant isolation per journal, so cross-tenant netting must go through a platform-owned *house* organisation: each customer's conversion is a normal journal with the house as counterparty (`LP-CLEARING-*` becomes a house clearing account), and one house↔provider journal covers the residual. No journal ever touches two tenants.
- Reconciliation must treat house balances separately from customer balances; custody must still cover `customer + in-transit` balances **without** counting house inventory as backing.
- Each matched order records its `netting_batch_id`, the amounts matched internally, and the amount hedged, so every unit is traceable.

## Risk limits required before any wiring
- Maximum open (unhedged) position per asset and in total, hard-stop when reached (fall back to sending every order to the provider).
- Maximum age of an unhedged position.
- Behaviour on provider outage: stop quoting that pair; never widen limits automatically.
- Kill switch separate from `CONVERSION_LIVE_ENABLED`.

## What counsel must answer first
Whether matching customers' orders, and holding a transient or permanent principal position, changes DURIN's licensing perimeter, capital or reporting duties (question 9 in `COUNSEL_BRIEF.md`).

## Step 3 (own inventory) — preconditions
Counsel sign-off; capital allocated and held in DURIN's own name, segregated from customer funds; a hedging counterparty; position and loss limits approved by the business; daily P&L and position reporting; reconciliation extended to house accounts.
