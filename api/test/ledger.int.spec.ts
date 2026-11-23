import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { createTestApp, type TestApp } from './helpers/app';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The ledger's correctness guarantees, tested against a real PostgreSQL database and the real
 * migrations, connecting as the least-privilege runtime role (never as the table owner).
 */
let t: TestApp;
let ledger: LedgerService;
let prisma: PrismaService;
let owner: PrismaClient; // table owner: used only to prove the triggers fire even for privileged roles
let orgA: string;
let orgB: string;
let cashA: string; // asset USDC
let liabA: string; // liability USDC
let zarCashA: string;
let zarLiabA: string;
let acctB: string;

const post = (org: string, lines: any[], key?: string, reference = 'test') =>
  ledger.postJournal(org, { reference, lines }, key);
const line = (accountId: string, direction: 'debit' | 'credit', amount: string, assetCode = 'USDC') => ({ accountId, direction, amount, assetCode });
const avail = async (accountId: string) => (await prisma.balance.findUniqueOrThrow({ where: { accountId } })).available.toFixed();
const code = (e: unknown) => ((e as BadRequestException).getResponse() as { code: string }).code;

beforeAll(async () => {
  t = await createTestApp();
  ledger = t.app.get(LedgerService);
  prisma = t.app.get(PrismaService);
  owner = new PrismaClient({ datasources: { db: { url: process.env.DURIN_TEST_ADMIN_URL } } });

  orgA = (await prisma.organisation.create({ data: { name: 'A' } })).id;
  orgB = (await prisma.organisation.create({ data: { name: 'B' } })).id;
  cashA = (await ledger.createAccount(orgA, { code: 'CASH-USDC', name: 'Cash', accountType: 'asset', assetCode: 'USDC' })).id;
  liabA = (await ledger.createAccount(orgA, { code: 'LIAB-USDC', name: 'Customer', accountType: 'liability', assetCode: 'USDC' })).id;
  zarCashA = (await ledger.createAccount(orgA, { code: 'CASH-ZAR', name: 'Cash', accountType: 'asset', assetCode: 'ZAR' })).id;
  zarLiabA = (await ledger.createAccount(orgA, { code: 'LIAB-ZAR', name: 'Customer', accountType: 'liability', assetCode: 'ZAR' })).id;
  acctB = (await ledger.createAccount(orgB, { code: 'CASH-USDC', name: 'Cash', accountType: 'asset', assetCode: 'USDC' })).id;
});

afterAll(async () => {
  await owner?.$disconnect();
  await t?.close();
});

describe('accounts and balances', () => {
  it('creates a zero balance row with every account, in the database', async () => {
    expect(await avail(cashA)).toBe('0');
    const row = await prisma.balance.findUniqueOrThrow({ where: { accountId: cashA } });
    expect(row.organisationId).toBe(orgA);
    expect(row.assetCode).toBe('USDC');
  });

  it('posts with exact decimals and the correct normal-side sign', async () => {
    await post(orgA, [line(cashA, 'debit', '0.1'), line(liabA, 'credit', '0.1')], 'dec-1');
    await post(orgA, [line(cashA, 'debit', '0.2'), line(liabA, 'credit', '0.2')], 'dec-2');
    expect(await avail(cashA)).toBe('0.3'); // asset: debit increases
    expect(await avail(liabA)).toBe('0.3'); // liability: credit increases
  });

  it('keeps 18 decimal places of precision', async () => {
    await post(orgA, [line(cashA, 'debit', '0.000000000000000001'), line(liabA, 'credit', '0.000000000000000001')], 'dec-3');
    expect(await avail(liabA)).toBe('0.300000000000000001');
  });
});

describe('journal validity (application and database)', () => {
  it('rejects unbalanced, single-line, zero and malformed journals with 400s', async () => {
    await expect(post(orgA, [line(cashA, 'debit', '10'), line(liabA, 'credit', '9')])).rejects.toSatisfy((e) => code(e) === 'UNBALANCED_JOURNAL');
    await expect(post(orgA, [line(cashA, 'debit', '10')])).rejects.toSatisfy((e) => code(e) === 'EMPTY_JOURNAL');
    await expect(post(orgA, [line(cashA, 'debit', '0'), line(liabA, 'credit', '0')])).rejects.toSatisfy((e) => code(e) === 'INVALID_AMOUNT');
    await expect(post(orgA, [line(cashA, 'debit', '1e3'), line(liabA, 'credit', '1e3')])).rejects.toSatisfy((e) => code(e) === 'INVALID_AMOUNT');
    await expect(post(orgA, [line('not-a-uuid', 'debit', '1'), line(liabA, 'credit', '1')])).rejects.toSatisfy((e) => code(e) === 'ACCOUNT_NOT_FOUND');
  });

  it('rejects a journal that balances only across assets', async () => {
    await expect(post(orgA, [line(cashA, 'debit', '5', 'USDC'), line(zarLiabA, 'credit', '5', 'ZAR')])).rejects.toSatisfy((e) => code(e) === 'UNBALANCED_JOURNAL');
  });

  it('accepts a multi-asset journal balanced per asset', async () => {
    await post(orgA, [
      line(zarCashA, 'debit', '100', 'ZAR'), line(zarLiabA, 'credit', '100', 'ZAR'),
      line(cashA, 'debit', '5', 'USDC'), line(liabA, 'credit', '5', 'USDC'),
    ], 'multi-1');
    expect(await avail(zarLiabA)).toBe('100');
  });

  it('the DATABASE rejects an unbalanced journal even when the application is bypassed', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.journal.create({
          data: { organisationId: orgA, lines: { create: [
            { accountId: cashA, direction: 'debit', amount: '10', assetCode: 'USDC' },
            { accountId: liabA, direction: 'credit', amount: '9', assetCode: 'USDC' },
          ] } },
        });
      }),
    ).rejects.toThrow(/UNBALANCED_JOURNAL/);
  });

  it('the DATABASE rejects a line on another organisation\'s account', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.journal.create({
          data: { organisationId: orgB, lines: { create: [
            { accountId: cashA, direction: 'debit', amount: '1', assetCode: 'USDC' },
            { accountId: acctB, direction: 'credit', amount: '1', assetCode: 'USDC' },
          ] } },
        });
      }),
    ).rejects.toThrow(/TENANT_MISMATCH/);
  });

  it('the DATABASE rejects a line whose asset differs from its account', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.journal.create({
          data: { organisationId: orgA, lines: { create: [
            { accountId: cashA, direction: 'debit', amount: '1', assetCode: 'ZAR' },
            { accountId: zarLiabA, direction: 'credit', amount: '1', assetCode: 'ZAR' },
          ] } },
        });
      }),
    ).rejects.toThrow(/ASSET_MISMATCH/);
  });

  it('the DATABASE rejects zero and negative line amounts', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.journal.create({
          data: { organisationId: orgA, lines: { create: [
            { accountId: cashA, direction: 'debit', amount: '-1', assetCode: 'USDC' },
            { accountId: liabA, direction: 'credit', amount: '-1', assetCode: 'USDC' },
          ] } },
        });
      }),
    ).rejects.toThrow();
  });

  it('a tenant cannot post to another tenant\'s account through the service', async () => {
    await expect(post(orgB, [line(acctB, 'debit', '1'), line(cashA, 'credit', '1')])).rejects.toSatisfy((e) => code(e) === 'ACCOUNT_NOT_FOUND');
  });
});

describe('non-negative balances', () => {
  it('refuses to overdraw and leaves nothing behind', async () => {
    const before = await avail(liabA);
    await expect(post(orgA, [line(liabA, 'debit', '1000000'), line(cashA, 'credit', '1000000')])).rejects.toSatisfy((e) => code(e) === 'NEGATIVE_BALANCE');
    expect(await avail(liabA)).toBe(before);
    expect(await prisma.journal.count({ where: { organisationId: orgA, reference: 'overdraw' } })).toBe(0);
  });

  it('allows a negative balance only on an account that opts in', async () => {
    const clearing = await ledger.createAccount(orgA, { code: 'CLEARING', name: 'Clearing', accountType: 'system', assetCode: 'USDC', allowNegative: true });
    await post(orgA, [line(clearing.id, 'credit', '7'), line(cashA, 'debit', '7')], 'neg-ok');
    expect(await avail(clearing.id)).toBe('-7');
  });
});

describe('concurrency', () => {
  it('exactly as many concurrent debits succeed as the balance can fund', async () => {
    const wallet = await ledger.createAccount(orgA, { code: 'RACE-LIAB', name: 'Race', accountType: 'liability', assetCode: 'USDC' });
    const backing = await ledger.createAccount(orgA, { code: 'RACE-CASH', name: 'Race', accountType: 'asset', assetCode: 'USDC' });
    await post(orgA, [line(backing.id, 'debit', '100'), line(wallet.id, 'credit', '100')], 'race-fund');

    // 20 parallel withdrawals of 15 against a balance of 100: only 6 can succeed (6 * 15 = 90).
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => post(orgA, [line(wallet.id, 'debit', '15'), line(backing.id, 'credit', '15')], `race-${i}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toBe(6);
    expect(refused.every((r) => code(r.reason) === 'NEGATIVE_BALANCE')).toBe(true);
    expect(await avail(wallet.id)).toBe('10');
    expect((await ledger.integrityReport(orgA)).healthy).toBe(true);
  });

  it('opposite-direction concurrent postings do not deadlock', async () => {
    const a = await ledger.createAccount(orgA, { code: 'DL-A', name: 'A', accountType: 'system', assetCode: 'USDC', allowNegative: true });
    const b = await ledger.createAccount(orgA, { code: 'DL-B', name: 'B', accountType: 'system', assetCode: 'USDC', allowNegative: true });
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        post(orgA, i % 2 ? [line(a.id, 'debit', '1'), line(b.id, 'credit', '1')] : [line(b.id, 'debit', '1'), line(a.id, 'credit', '1')], `dl-${i}`),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await avail(a.id)).toBe('0');
  });
});

describe('idempotency', () => {
  it('ten concurrent identical posts create exactly one journal', async () => {
    const lines = [line(cashA, 'debit', '2'), line(liabA, 'credit', '2')];
    const before = await avail(liabA);
    const results = await Promise.all(Array.from({ length: 10 }, () => post(orgA, lines, 'idem-race')));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.journal.count({ where: { organisationId: orgA, idempotencyKey: 'idem-race' } })).toBe(1);
    expect(Number(await avail(liabA)) - Number(before)).toBe(2);
  });

  it('the same key with different lines is rejected with 409', async () => {
    await post(orgA, [line(cashA, 'debit', '3'), line(liabA, 'credit', '3')], 'idem-mismatch');
    await expect(post(orgA, [line(cashA, 'debit', '4'), line(liabA, 'credit', '4')], 'idem-mismatch')).rejects.toBeInstanceOf(ConflictException);
  });

  it('line order does not change the identity of a replay', async () => {
    await post(orgA, [line(cashA, 'debit', '6'), line(liabA, 'credit', '6')], 'idem-order');
    const again = await post(orgA, [line(liabA, 'credit', '6'), line(cashA, 'debit', '6')], 'idem-order');
    expect(again.id).toBeDefined();
  });

  it('keys are scoped per organisation', async () => {
    await post(orgA, [line(cashA, 'debit', '1'), line(liabA, 'credit', '1')], 'shared-key');
    const clash = await ledger.createAccount(orgB, { code: 'LIAB', name: 'L', accountType: 'liability', assetCode: 'USDC' });
    await post(orgB, [line(acctB, 'debit', '1'), line(clash.id, 'credit', '1')], 'shared-key');
  });
});

describe('immutability and least privilege', () => {
  it('the runtime role cannot update or delete posted entries, or write balances', async () => {
    const j = await post(orgA, [line(cashA, 'debit', '1'), line(liabA, 'credit', '1')], 'imm-1');
    await expect(prisma.$executeRaw`UPDATE journal_lines SET amount = 1 WHERE journal_id = ${j.id}::uuid`).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRaw`DELETE FROM journals WHERE id = ${j.id}::uuid`).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRaw`UPDATE balances SET available = 999999 WHERE account_id = ${liabA}::uuid`).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRaw`DELETE FROM ledger_accounts WHERE id = ${liabA}::uuid`).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'x'`).rejects.toThrow(/permission denied/);
  });

  it('even the table owner cannot mutate posted entries (triggers fire for every role)', async () => {
    const j = await post(orgA, [line(cashA, 'debit', '1'), line(liabA, 'credit', '1')], 'imm-2');
    await expect(owner.$executeRaw`UPDATE journal_lines SET amount = 1 WHERE journal_id = ${j.id}::uuid`).rejects.toThrow(/IMMUTABLE/);
    await expect(owner.$executeRaw`DELETE FROM journals WHERE id = ${j.id}::uuid`).rejects.toThrow(/IMMUTABLE/);
    await expect(owner.$executeRaw`TRUNCATE journal_lines`).rejects.toThrow(/IMMUTABLE/);
    await expect(owner.$executeRaw`UPDATE ledger_accounts SET asset_code = 'ZAR' WHERE id = ${cashA}::uuid`).rejects.toThrow(/IMMUTABLE/);
  });
});

describe('integrity report', () => {
  it('is healthy after all of the above', async () => {
    const report = await ledger.integrityReport(orgA);
    expect(report.balanceDrift).toEqual([]);
    expect(report.unbalancedJournals).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('detects a balance that was changed outside the ledger, and is scoped to the organisation', async () => {
    await owner.$executeRaw`UPDATE balances SET available = available + 1 WHERE account_id = ${liabA}::uuid`;
    const report = await ledger.integrityReport(orgA);
    expect(report.healthy).toBe(false);
    expect(report.balanceDrift.map((d) => d.accountId)).toContain(liabA);
    expect((await ledger.integrityReport(orgB)).healthy).toBe(true);
    await owner.$executeRaw`UPDATE balances SET available = available - 1 WHERE account_id = ${liabA}::uuid`;
    expect((await ledger.integrityReport(orgA)).healthy).toBe(true);
  });
});

describe('random valid journals', () => {
  it('keep every balance equal to its postings and every journal balanced', async () => {
    let seed = 20261123;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const accounts = [cashA, liabA, zarCashA, zarLiabA];
    const asset = new Map([[cashA, 'USDC'], [liabA, 'USDC'], [zarCashA, 'ZAR'], [zarLiabA, 'ZAR']]);
    let posted = 0;
    for (let i = 0; i < 150; i++) {
      const a = accounts[Math.floor(rnd() * accounts.length)]!;
      const sameAsset = accounts.filter((x) => x !== a && asset.get(x) === asset.get(a));
      const b = sameAsset[Math.floor(rnd() * sameAsset.length)]!;
      const amount = (1 + Math.floor(rnd() * 100000)) / 1000 + '';
      try {
        await post(orgA, [line(a, 'debit', amount, asset.get(a)), line(b, 'credit', amount, asset.get(b))], `rnd-${i}`);
        posted++;
      } catch (e) {
        expect(code(e)).toBe('NEGATIVE_BALANCE'); // the only acceptable refusal
      }
    }
    expect(posted).toBeGreaterThan(20);
    expect((await ledger.integrityReport(orgA)).healthy).toBe(true);
  });
});
