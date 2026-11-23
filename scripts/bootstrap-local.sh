#!/usr/bin/env bash
# One-shot local setup: database, dependencies, migrations, build. Requires Node 20+, pnpm, Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Set POSTGRES_PASSWORD and DURIN_APP_PASSWORD, then re-run."
  exit 1
fi
set -a; . ./.env; set +a
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}"
: "${DURIN_APP_PASSWORD:?set DURIN_APP_PASSWORD in .env}"

echo "Starting Postgres..."
docker compose -f infrastructure/docker-compose.yml up -d --wait postgres

echo "Installing dependencies and building shared packages..."
pnpm install --frozen-lockfile
pnpm build:packages
pnpm --filter @durin/api prisma:generate

echo "Applying migrations (as the schema owner) and granting the runtime role..."
export MIGRATION_DATABASE_URL="postgresql://${POSTGRES_USER:-durin_owner}:${POSTGRES_PASSWORD}@localhost:5432/durin"
export DURIN_RUNTIME_ROLE=durin_app
pnpm db:migrate

cat <<MSG

Ready. Next:
  DATABASE_URL="postgresql://durin_app:${DURIN_APP_PASSWORD}@localhost:5432/durin" pnpm dev:api
  node scripts/smoke.mjs http://localhost:3000       # end-to-end check of the running API
  pnpm --filter @durin/dashboard dev                 # dashboard (set DURIN_API_KEY first)
MSG
