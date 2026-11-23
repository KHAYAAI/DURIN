# Brief for counsel — DURIN gate G1 (live conversion) and the draft SARB crypto manual

**Purpose.** Ask counsel to (1) review the SARB/Treasury *draft* Crypto Asset Manual for Cross-Border Activities against DURIN's flows and (2) decide whether to issue the written sign-off that opens **gate G1**. This brief is a technical summary prepared by engineering; it is **not legal advice and not a conclusion**. Regulatory facts below come from secondary summaries and should be checked against the primary texts.

## What DURIN does (technical facts)
- API platform for institutions: payments, ZAR ↔ stablecoin conversion, wallets and withdrawals, double-entry ledger.
- **No custody by DURIN.** Crypto is held by a Layer 1 custodian; fiat by a regulated Layer 2 entity (FORGE Mutual). DURIN's ledger *mirrors* what they report and reconciles to it; it does not hold customer fiat deposits or private keys.
- Conversions execute through a third-party **liquidity provider** (not yet selected/contracted). Customer is credited on delivery. An unknown provider outcome keeps funds reserved and is never retried automatically.
- Planned assets/chains: USDC on Ethereum and Solana first; USDT (possibly on Tron) only if compliance approves. Only natively issued tokens are accepted.
- KYC/KYB through Didit; dashboard access through WorkOS (SSO + MFA).
- Customers are **institutions** (KYB), not retail.

## The regulatory material
- National Treasury and SARB published a draft *Crypto Asset Manual for Cross-Border Activities* on 3 Aug 2026, comments due 30 Sep 2026 (a redraft was expected later — confirm current status). [SARB draft (PDF)](https://www.resbank.co.za/content/dam/sarb/what-we-do/financial-surveillance/financial-surveillance-documents/draft-circulars-and-documents-for-comments/Draft%20Crypto%20Assets%20Manual%202026-07-31.pdf).
- Secondary summary: [Baker McKenzie, Aug 2026](https://www.bakermckenzie.com/en/insight/publications/2026/08/south-africa-proposed-framework-for-cross-border-crypto-asset-transactions) — providers facilitating cross-border crypto transfers would need SARB Financial Surveillance approval, on top of an FSCA licence and FIC registration, with FinSurv reporting alongside Travel Rule and CARF reporting; transfers between an authorised SA provider and a foreign provider or self-hosted wallet would be cross-border; stablecoin payment models may need redesign.
- Current position per the same firm: the 2025 *Standard Bank* High Court ruling (subject to appeal; status unconfirmed) and [FinSurv Circular 3/2026](https://www.bakermckenzie.com/en/insight/publications/2026/03/south-africa-crypto-assets-likely-to-enter-exchange-control-regime) that crypto transfers did not, for now, need exchange-control approval.

## Questions for counsel
1. **Licensing perimeter.** Does DURIN, given it does not custody and uses a custodian, liquidity provider and regulated fiat entity, itself need an FSCA licence (FAIS / CASP), FIC registration, and (under the draft) SARB authorisation? Which of its partners must hold which licences?
2. **Conversion.** Is ZAR ↔ stablecoin conversion for institutional clients a regulated activity for DURIN, for the liquidity provider, or both? Does the structure (fiat via FORGE Mutual, crypto via custodian) satisfy the "no customer fiat deposits" boundary in the approved architecture?
3. **Cross-border.** Which withdrawals count as cross-border under the draft (e.g. to self-hosted or foreign-VASP addresses)? Must DURIN block, limit or report them? Should self-hosted-wallet withdrawals be disabled at launch?
4. **Travel Rule.** What must DURIN collect and transmit, and who is the obligated party (DURIN vs custodian)?
5. **Stablecoin specifics.** Any restriction on USDC vs USDT, or on specific chains (Tron)? Issuer freeze risk and sanctions exposure for USDT?
6. **Customer eligibility.** Acceptable jurisdictions and entity types; what KYB depth (UBO threshold, registry + documents + screening) is required; ongoing monitoring cadence.
7. **Reporting.** FinSurv, FIC (STR/CTR), SARS CARF — what DURIN must produce, in what form, and by when.
8. **Gate G1 scope and wording.** Which assets and jurisdictions the sign-off covers, its validity period (the system caps it at 365 days and requires an expiry), conditions that must trigger revocation, and who may record it.

## What engineering will record if counsel signs
`POST /v1/compliance/gates/g1` (signed-in admin with MFA) with: counsel reference, SHA-256 of the signed opinion, assets, jurisdictions, validity days. The system refuses live conversion without this record, without an approved Didit KYB, and unless operators also set `CONVERSION_LIVE_ENABLED=true`. Revocation closes the gate immediately.

## Open items counsel should know are not decided
Liquidity provider and custodian identities/agreements; final chain list; limits and approval thresholds; data-retention and POPIA treatment of KYC data held by Didit; incident and complaint handling.
