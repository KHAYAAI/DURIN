#!/usr/bin/env node
/**
 * Applies database migrations with a privileged (schema-owner) role, kept separate from the
 * least-privilege role the API runs as.
 *
 *   MIGRATION_DATABASE_URL=postgresql://<owner>:<pw>@host/db \
 *   DURIN_RUNTIME_ROLE=durin_app \
 *   node scripts/migrate.mjs
 *
 * The API connects with DATABASE_URL as `DURIN_RUNTIME_ROLE`, a member of `durin_runtime`, which
 * cannot write balances or alter posted ledger entries (migration 20261123000000_ledger_invariants).
 */
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set MIGRATION_DATABASE_URL (or DATABASE_URL) to a role that owns the schema.');
  process.exit(2);
}
if (!process.env.MIGRATION_DATABASE_URL) {
  console.warn('MIGRATION_DATABASE_URL not set; migrating with DATABASE_URL. Use a separate owner role in production.');
}

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
if (result.status !== 0) process.exit(result.status ?? 1);

const role = process.env.DURIN_RUNTIME_ROLE;
if (role) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) {
    console.error(`Unsafe DURIN_RUNTIME_ROLE: ${role}`);
    process.exit(2);
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$executeRawUnsafe(`GRANT durin_runtime TO "${role}"`);
    console.log(`Granted durin_runtime to ${role}`);
  } finally {
    await prisma.$disconnect();
  }
} else {
  console.warn('DURIN_RUNTIME_ROLE not set: remember to GRANT durin_runtime TO <your API login role>.');
}
