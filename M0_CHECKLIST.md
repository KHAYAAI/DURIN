# M0 Foundations — Checklist

- [x] Monorepo (pnpm workspaces)
- [x] Root README + .env.example + .gitignore
- [x] Docker Compose (PostgreSQL 16 + Redis)
- [x] packages/shared
- [x] packages/ledger (scaffold)
- [x] apps/api NestJS skeleton
- [x] Health endpoint `GET /health`
- [x] Prisma initialised (Organisation model only)
- [x] Vitest + sample health test
- [x] Six architecture documents in docs/
- [ ] `pnpm install` (run locally)
- [ ] `docker compose up -d`
- [ ] `pnpm db:generate` + first migration
- [ ] CI workflow (GitHub Actions)
- [ ] ESLint + Prettier config

**Next:** M1 Developer platform (organisations, API keys, idempotency store)
