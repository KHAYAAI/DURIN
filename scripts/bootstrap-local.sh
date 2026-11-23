#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cp -n .env.example .env || true
echo "Starting Postgres + Redis (requires Docker)..."
docker compose -f infrastructure/docker-compose.yml up -d
echo "Installing dependencies..."
pnpm install
echo "Generating Prisma client + migrating..."
pnpm --filter @durin/api exec prisma generate
pnpm --filter @durin/api exec prisma migrate dev --name init
echo "Run API: pnpm dev:api"
echo "Run dashboard: pnpm --filter @durin/dashboard dev"
echo "Load test: node scripts/load-test-health.mjs"
