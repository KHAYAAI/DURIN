> **Historical.** This describes the original scaffold. Several claims here were corrected or superseded; see [STATUS.md](STATUS.md).

# M8 Hardening — Status (updated)

| Item | Status |
|------|--------|
| Security headers | implemented |
| Rate limiting (in-memory, per API key) | implemented |
| API key hashing | **scrypt** (memory-hard, Node built-in); legacy SHA-256 still verified |
| Production checklist | documented |
| Load test script | `scripts/load-test-health.mjs` |
| Layer2Port (FORGE Mutual) | sandbox adapter + contract docs |
| Live adapters | awaiting credentials |
| G1 regulatory gate | still open |

Not production-ready until checklist + G1 cleared and Redis-backed rate limit preferred in prod.
