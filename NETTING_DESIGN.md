# Liquidity strategy and internal netting — decision and design

**Decision (owner, 2026-11-23):** (1) launch with an external liquidity provider; (2) net opposing customer flows internally and send only the difference to the provider; (3) add a small own inventory later, once volumes, licensing and risk limits are known.

**Status:** decision recorded; the netting *calculation* is built and tested (`api/src/conversions/netting.ts`). Internal netting is **not wired into conversions** and must not be until counsel answers question 9 in `COUNSEL_BRIEF.md`. Own inventory is not built.

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
