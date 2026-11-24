# VALR — questions for the Business demo (and what we already know)

**Why VALR.** Its API covers every leg we are missing in one place: ZAR↔USDC/USDT orders, per-customer subaccounts, crypto deposit addresses and withdrawals, ZAR deposit references and bank withdrawals, and webhooks. DURIN adapters for all three roles are built against VALR's published API collection ([docs.valr.com](https://docs.valr.com)) and tested only against a **fake** server. Nothing has touched real VALR. [VALR Business launched on 17 Nov 2026](https://unchainedcrypto.com/press-release/valr-launches-valr-business-to-power-global-payments-and-treasury-management-for-modern-enterprises/); a corporate account or guided demo is requested at valr.com/payments.

## What the published docs already tell us (so don't spend demo time on these)
- Auth: API key + HMAC-SHA512 signature per request; keys need 2FA; scoped permissions (View, Trade, Transfer, Withdraw, Link Bank Account); subaccount impersonation by header; primary-key-only operations.
- Exchange market orders accept a `customerOrderId` (usable for lookup) and `timeInForce` FOK/IOC; "Simple Buy/Sell" quote/order exists but its order call has no client reference.
- Subaccounts can be created via API (limit **50 per primary account** unless VALR raises it).
- Crypto withdrawals have **no client reference/idempotency key**; fiat withdrawals go only to linked bank accounts.
- A webhooks API exists (marked Beta).

## A. Commercial and regulatory (ask first — these decide whether to proceed)
1. Which VALR entity would contract with DURIN, and what are its **FSCA CASP licence** number and FIC registration? Is it (or will it be) an authorised provider under the SARB's draft cross-border crypto framework?
2. Does VALR permit DURIN's model: a platform that opens subaccounts **on behalf of its institutional customers** and moves ZAR/USDC for them? Under whose KYC/KYB — VALR's, DURIN's (via Didit), or both? Is a "Register Subaccount With KYC Info" flow available to us?
3. Does VALR consider DURIN a **client** or an **introducer/partner** (is there a partner or white-label programme)? Any restrictions on reselling VALR liquidity?
4. Who is the legal holder of customer ZAR and USDC in subaccounts, and how are client assets segregated and protected on VALR's insolvency? Please provide the relevant policy and the latest audit/attestation (SOC 2 or equivalent) and proof-of-reserves practice.
5. What are the contractual **SLAs, limits, fees**: trading/taker fees at our expected volume, withdrawal fees (crypto and fast ZAR), deposit fees, minimums, monthly caps, and any exclusivity or minimum-volume commitments?
6. Do you accept **cross-border** flows to/from DURIN customers (non-SA entities), and which jurisdictions are excluded? What Travel Rule messages do you require or send, and through which network?

## B. Product and API
7. Is there a **sandbox/test environment** with fake funds? If not, how do you recommend testing money movement (small funded live account)? Please share test API keys for the demo.
8. Confirm the exact **pair symbols** and limits for ZAR (e.g. `USDCZAR`, `USDTZAR`): minimum/maximum order sizes, tick/decimal rules.
9. Confirm the accepted format of `customerOrderId` (allowed characters, max length) and that a repeated `customerOrderId` is rejected rather than creating a second order.
10. Is there an **OTC/RFQ desk** for size above book depth, with firm quotes and a quote ID we can execute against? What are its minimums (we heard of ~R100k; unconfirmed) and operating hours?
11. Fee treatment on market orders: for a BUY with `baseAmount`, is the taker fee deducted from the base received? Can fees be fixed or gross-up friendly (we must deliver an exact quoted amount to our customer)?
12. **Network names** for deposits/withdrawals as returned by `/v1/public/currencies` for USDC and USDT (we assume `Solana` and `Ethereum`); confirmations required before a deposit is credited; whether **Tron** is available for USDC.
13. **Withdrawals:** is address whitelisting/address-book enrolment mandatory? Any cooling-off after adding an address? Any travel-rule fields required (`beneficiaryName`, `isCorporate`, `isSelfHosted`, `serviceProviderId`)?
14. Is there any way to make crypto and fiat **withdrawals idempotent** (a client reference), or to look one up by our reference? How should we reconcile an ambiguous (timed-out) withdrawal?
15. **Deposits:** do webhooks (beta) cover crypto deposits, fiat deposits, withdrawal status and order fills? Delivery guarantees, retries, signing scheme, and whether they are production-ready.
16. **Fiat:** how are our subaccounts' ZAR deposits identified (reference per subaccount)? Settlement times for EFT/RTC; which banks; same-day cut-off times; can DURIN receive the bank statement or collection-account details by API?
17. Can bank accounts be linked to a **subaccount** via the API with the "Link Bank Account" permission, and what verification does VALR apply? We will keep API linking off unless you confirm it is safe.
18. Rate limits (per key/IP/endpoint) and the recommended polling vs WebSocket approach for order status and balances.
19. Subaccount limits and tooling: can the 50-subaccount cap be raised in advance? Can balances for all subaccounts be fetched in one call (we use `balances/all` if it exists)?

## C. Security and operations
20. Key management: IP allow-listing for API keys? Separate keys per role (trading vs withdrawal)? Key rotation process and expiry?
21. Withdrawal controls: can we require **approval/limits** on withdrawals made with our API key (e.g. daily caps, a second approver)?
22. Incident and maintenance process: status page, planned-maintenance notice, how a halted market or frozen account is communicated to us.
23. Data: where our and our customers' data is stored; POPIA terms; breach-notification timelines.
24. Reporting: what statements, trade confirmations and tax/FIC reports can we pull for reconciliation and regulators?

## D. Onboarding logistics
25. Documents VALR needs from DURIN for corporate onboarding, expected timeline, and whether DURIN or its owners/UBOs need to sit in a specific jurisdiction.
26. Named commercial and technical contacts; escalation path for production issues.

---

# The same exercise for the other providers

## Rand rails — Stitch and Peach Payments
Public facts: [Stitch Payouts](https://stitch.money/payouts) (float account, bulk/one-off disbursements via API, 24/7) and [Peach Payments real-time clearance payouts](https://www.finextra.com/pressarticle/106757/peach-payments-introduces-real-time-clearance-payouts) (float top-up, API). Not verified: licensing, whether collections can be received into an account DURIN does not own, adapter-grade API access.
Ask: (1) licence/registration and who holds customer funds in transit; (2) **payout float** mechanics, minimum float, top-up methods and speed; (3) onboarding time and required documents for a platform paying out on behalf of customers; (4) per-payout fees and limits; (5) idempotency/client-reference support and payout status webhooks; (6) pay-in (collections) options — pay-by-bank, EFT reference matching, virtual accounts — and settlement account structure; (7) sandbox availability; (8) reversal/recall rules; (9) fraud and sanctions screening duties on payouts; (10) how they would treat a stablecoin business as a customer (many PSPs restrict crypto — **ask this first**).

## Custody vendors (Solana USDC test + SOC 2)
Candidates named in public sources (claims are vendors' own, unverified): Fireblocks, Dfns, Cobo, io.finnet, MPCVault.
Ask each: (1) latest **SOC 2 Type II report** (and ISO 27001 certificate) under NDA; (2) a **testnet/devnet walkthrough sending SPL USDC** with destination token-account creation, via API; (3) how deposits are detected and signalled (webhook, polling, confirmation depth); (4) idempotency on transfers and lookup by our reference; (5) policy engine and approval controls; (6) key-management model (MPC, who holds shares), recovery drills and incident history; (7) whether the vendor is a licensed custodian in SA or only technology; (8) pricing per wallet/transaction/AUM; (9) data residency and POPIA; (10) exit/portability — can we migrate keys/wallets if we leave.

---
*Prepared by engineering from public documentation as of 2026-11-24. Items marked unverified must be confirmed with the vendor in writing.*
