# DURIN engineering readiness (target: high on product axes)

| Dimension | Target | Engineering status |
|-----------|--------|-------------------|
| API surface | High | OpenAPI 3.1 at `apps/api/openapi/openapi.yaml`, served at `/v1/openapi.yaml`; version at `/v1/version` |
| Auth / tenancy | High | scrypt API keys, scopes, rate limits, production fail-closed, dashboard MFA policy encoded |
| Payments / conversion / wallets | High *sandbox completeness* | Full happy paths + webhook delivery; live rails still partner-gated |
| Compliance | High *program scaffold* | Verifications, screening, limits, approvals, audit + regulatory docs |
| Dashboard | High *ops shell* | All primary pages load live API tables when configured |
| Hardening / ops | High *engineering* | Headers, rate limit, production safety, reconcile script, load test, checklist |
| Runnable | High *on developer machine* | `./scripts/bootstrap-local.sh` (Docker + pnpm required) |
| Regulatory / commercial | High *preparedness* | G1 gate + operating model docs — **not licensed** |

**Money movement remains sandbox until G1 + live adapters.**
