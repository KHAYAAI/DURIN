import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * Creates a fresh database, applies the real migrations as the owner role, and makes the
 * runtime login a member of `durin_runtime`. Credentials come from the environment:
 *
 *   DURIN_TEST_ADMIN_URL  superuser/owner URL for the test database (e.g. .../durin_test)
 *   DURIN_TEST_APP_URL    runtime login URL (member of durin_runtime) for the same database
 */
export default async function setup() {
  const adminUrl = process.env.DURIN_TEST_ADMIN_URL;
  const appUrl = process.env.DURIN_TEST_APP_URL;
  if (!adminUrl || !appUrl) {
    throw new Error('Set DURIN_TEST_ADMIN_URL and DURIN_TEST_APP_URL to run integration tests (see .env.example)');
  }

  const dbName = new URL(adminUrl).pathname.slice(1);
  const appRole = decodeURIComponent(new URL(appUrl).username);
  const ident = (v: string) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) throw new Error(`Unsafe identifier: ${v}`);
    return `"${v}"`;
  };

  const maintenance = new URL(adminUrl);
  maintenance.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: maintenance.toString() } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${ident(dbName)} WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE ${ident(dbName)}`);
  } finally {
    await admin.$disconnect();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: adminUrl },
    stdio: 'pipe',
  });

  const owner = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    await owner.$executeRawUnsafe(`GRANT durin_runtime TO ${ident(appRole)}`);
  } finally {
    await owner.$disconnect();
  }
}
