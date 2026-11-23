# M1 Developer Platform — Status

**Status:** Implemented (code complete, pending local `pnpm install` + migrate + integration test run)

## Delivered

| Capability | Status | Notes |
|------------|--------|-------|
| Organisations create + `GET /me` | `implemented` | Bootstrap returns one-time API key |
| API key create / list / revoke | `implemented` | Secret shown once; SHA-256 hash (upgrade to argon2 in M8) |
| API key auth guard + scopes | `implemented` | Bearer `dk_test_…` / scopes via `@RequireScopes` |
| Idempotency store + interceptor | `implemented` | Header `Idempotency-Key`; conflict on payload mismatch |
| Webhook endpoint registration | `implemented` | Storage only; delivery = `simulated` |
| Prisma models | `implemented` | organisations, users, members, api_keys, idempotency_records, webhook_endpoints |
| Unit tests | `implemented` | Health, key hash contract, idempotency hash stability |

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/organisations` | Public (bootstrap) |
| GET | `/v1/organisations/me` | API key |
| POST | `/v1/api_keys` | API key + `api_keys:write` |
| GET | `/v1/api_keys` | API key + `api_keys:read` |
| DELETE | `/v1/api_keys/:id` | API key + `api_keys:write` |
| POST | `/v1/webhook_endpoints` | API key + `webhooks:write` |
| GET | `/v1/webhook_endpoints` | API key + `webhooks:read` |
| DELETE | `/v1/webhook_endpoints/:id` | API key + `webhooks:write` |
| GET | `/health` | None |

## Local verification

```bash
docker compose -f infrastructure/docker-compose.yml up -d
pnpm install
pnpm db:generate
pnpm --filter @durin/api exec prisma migrate dev --name m1_developer_platform
pnpm dev:api

# Bootstrap
curl -s -X POST http://localhost:3000/v1/organisations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Acme Treasury"}' | jq

# Use returned apiKey.secret
curl -s http://localhost:3000/v1/organisations/me \
  -H "Authorization: Bearer <secret>"
```

## Known follow-ups

- Replace SHA-256 key hashing with argon2id (M8)
- Public `POST /organisations` must be gated before production
- Webhook delivery worker (later milestone)
- Integration tests with Testcontainers against real Postgres
- Rate limiting per API key

## Next

**M2 — Double-entry ledger**
