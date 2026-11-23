# Which chains DURIN needs

**Short answer.** Start with **one** chain per stablecoin, chosen by what your *custodian and liquidity provider* can actually receive and send — not by what is fashionable. Add chains only when a named customer or counterparty needs one. Every chain you enable multiplies custody, monitoring, travel-rule and reconciliation work.

## Recommendation (to be confirmed against your Layer 1 / LP agreements)

| Priority | Asset / chain | Why |
|---|---|---|
| 1 | **USDC on Ethereum** | Deepest institutional support; every custodian and exchange handles it. Higher fees, so best for larger, less frequent movements. |
| 1 | **USDC on Solana** | Cheap, fast; widely supported by exchanges and custodians; suits payments-style flows. |
| 2 | **USDT on Tron** (and/or Ethereum) | Tether is widely used for African and South African cross-border flows. Include only if your LP and custodian support it and compliance accepts the exposure (issuer/freezing and sanctions-screening considerations). |
| Later | USDC on Base / Polygon / Avalanche / Stellar | Add on demand. Circle lists [USDC as natively issued on dozens of networks](https://www.circle.com/multi-chain-usdc) — support is not the constraint; *your* custody, monitoring and liquidity are. |

Native USDC and bridged USDC (e.g. "USDC.e") are different assets. DURIN must only accept **natively issued** tokens; the bridged variants must be rejected at address-creation time. Circle publishes the current native list: [supported chains and domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains) (it says the API response is the most current source).

## Selection rules (apply to every chain you add)
1. The Layer 1 custodian supports deposit-address creation, withdrawal and balance reporting for it (reconciliation needs the balance).
2. The liquidity provider settles in it.
3. Transaction monitoring / travel-rule screening covers it (Didit's transaction-monitoring and travel-rule products are available; confirm chain coverage).
4. Confirmation depth and finality policy is defined per chain (reorg risk) before crediting a deposit.
5. Counsel has confirmed the asset is acceptable under SARB exchange-control and FSCA/FIC requirements.

## What the code does today
Chain is a parameter on deposit addresses and withdrawals; the sandbox defaults to `ethereum-sepolia`. **No chain-specific logic exists**: there is no confirmation-depth policy, no allow-list of enabled chains, and no native-vs-bridged check. Those belong in the live Layer 1 adapter and in a configuration of enabled `(asset, chain)` pairs — see `PRODUCTION_READINESS.md`.

## Evidence gathered (checked 2026-11-23)
- **VALR (a likely SA liquidity venue):** its support page lists [USDC deposits/withdrawals on Arbitrum, Avalanche, Solana, Base and Ethereum](https://support.valr.com/hc/en-us/articles/10810569257628-USDC-Deposits-Withdrawals-on-Solana-Avalanche-and-Ethereum), and warns that sending on the wrong network loses funds permanently. VALR's [2024 review](https://accordion-blue-yrk3.squarespace.com/blog/2024-reflecting-on-a-transformative-year) says USDT on Tron and USDT/USDC on Solana were added. I found **no current source listing Tron for USDC**. The page date is unconfirmed — check the live deposit screen. This is why the table above leads with USDC on Ethereum/Solana and treats USDT-on-Tron as conditional.
- **Circle:** USDC is natively issued on [many networks](https://www.circle.com/multi-chain-usdc); the [CCTP chain list](https://developers.circle.com/cctp/concepts/supported-chains-and-domains) is the canonical reference.

## Regulatory position (draft, in flux — for counsel)
- National Treasury and the SARB published a [draft Crypto Asset Manual for Cross-Border Activities](https://www.resbank.co.za/content/dam/sarb/what-we-do/financial-surveillance/financial-surveillance-documents/draft-circulars-and-documents-for-comments/Draft%20Crypto%20Assets%20Manual%202026-07-31.pdf) on 3 Aug 2026 (comments to 30 Sep 2026). Per [Baker McKenzie's summary](https://www.bakermckenzie.com/en/insight/publications/2026/08/south-africa-proposed-framework-for-cross-border-crypto-asset-transactions), providers facilitating cross-border crypto transfers would need SARB Financial Surveillance approval on top of an FSCA licence and FIC registration, with FinSurv reporting alongside the FIC Travel Rule and CARF reporting.
- A transfer between an authorised South African provider and a foreign provider or self-hosted wallet would count as cross-border; payment models built on stablecoin settlement [may need redesign](https://www.bakermckenzie.com/en/insight/publications/2026/08/south-africa-proposed-framework-for-cross-border-crypto-asset-transactions).
- Today's position rests on the 2025 Standard Bank ruling, confirmed in [Exchange Control Circular 3/2026](https://www.bakermckenzie.com/en/insight/publications/2026/03/south-africa-crypto-assets-likely-to-enter-exchange-control-regime); the ruling was subject to appeal and I did not confirm that appeal's status.
- **Consequence for DURIN:** the cross-border and licensing questions are exactly what gate G1 exists for. Chain selection should not be finalised before counsel has reviewed the draft manual against DURIN's flows (especially self-hosted-wallet withdrawals).

These are summaries from secondary sources and the draft text; they are inputs to counsel, not legal conclusions.
