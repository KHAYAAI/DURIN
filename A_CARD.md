# A-CARD (Layer 4) integration notes

A-CARD is the spend-policy / agent control plane. It may sit **in front of** DURIN APIs:

- Enforce department limits before calling DURIN payment/conversion endpoints
- Use DURIN API keys scoped per agent budget
- Feed risk signals into DURIN compliance limits via `/v1/compliance/limits`

DURIN does not embed A-CARD source. Integrate over HTTP using scoped API keys.
