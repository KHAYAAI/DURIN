import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { LIQUIDITY_PORT } from '../src/providers/liquidity/liquidity.module';
import { SandboxLiquidityAdapter } from '../src/providers/liquidity/sandbox.liquidity';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { sandboxCustody } from '../src/providers/sandbox-custody';

class CountingLp extends SandboxLiquidityAdapter {
  executes = 0;
  async execute(p: Parameters<SandboxLiquidityAdapter['execute']>[0]) {
    this.executes++;
    return super.execute(p);
  }
}

let t: TestApp;
let prisma: PrismaService;
let ledger: LedgerService;
const lp = new CountingLp();

beforeAll(async () => {
  t = await createTestApp((b) => b.overrideProvider(LIQUIDITY_PORT).useValue(lp));
  prisma = t.app.get(PrismaService);
  ledger = t.app.get(LedgerService);
});
afterAll(async () => { await t?.close(); });

const bal = async (orgId: string, code: string) => {
  const a = await prisma.ledgerAccount.findUnique({ where: { organisationId_code: { organisationId: orgId, code } }, include: { balances: true } });
  return a?.balances[0]?.available.toFixed() ?? 'none';
};

async function quoteAndAccept(key: string, amount = '1000', idem?: string) {
  const q = (await client(t, key).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: amount })).body;
  const res = await client(t, key).post('/v1/conversions', { quoteId: q.id }, idem);
  return { q, res };
}

describe('conversion state machine (custody-reference ledger)', () => {
  it('settles with customer credited on delivery, fee booked, custody mirrors the provider', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Chart Org');
    const { q, res } = await quoteAndAccept(key);
    expect(res.body.status).toBe('settled');
    expect(await bal(orgId, 'CUST-LIAB-USDC')).toBe(q.targetAmount);
    expect(await bal(orgId, 'CONV-INTRANSIT-ZAR')).toBe('0');
    expect(await bal(orgId, 'LP-CLEARING-ZAR')).toBe('0');
    expect(await bal(orgId, 'LP-CLEARING-USDC')).toBe('0');
    expect(await bal(orgId, 'CUSTODY-REF-USDC')).toBe(q.targetAmount);
    const accounts = await prisma.ledgerAccount.findMany({ where: { organisationId: orgId } });
    expect(accounts.find((a) => a.code === 'CUSTODY-REF-ZAR')).toMatchObject({ role: 'custody_ref', custodian: 'layer2' });
    expect(accounts.find((a) => a.code === 'CUSTODY-REF-USDC')).toMatchObject({ role: 'custody_ref', custodian: 'layer1' });
    expect((await ledger.integrityReport(orgId)).healthy).toBe(true);
  });

  it('a rejected order releases the reservation and is recorded as failed', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Reject Org');
    lp.injectFault('reject');
    const { res } = await quoteAndAccept(key, '2000');
    expect(res.body).toMatchObject({ status: 'failed', failureReason: 'LP_REJECTED' });
    expect(await bal(orgId, 'CONV-INTRANSIT-ZAR')).toBe('0');
    expect(await bal(orgId, 'CUST-LIAB-ZAR')).toBe('2000');
    expect((await ledger.integrityReport(orgId)).healthy).toBe(true);
  });

  it('an unknown outcome keeps funds reserved, is never re-sent, and resolves by asking the provider (executed)', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Unknown Executed Org');
    lp.injectFault('throw_after');
    const before = lp.executes;
    const { q, res } = await quoteAndAccept(key, '3000', 'unk-1');
    expect(res.body).toMatchObject({ status: 'processing', providerUnknown: true });
    expect(await bal(orgId, 'CONV-INTRANSIT-ZAR')).toBe('3000');
    expect(await bal(orgId, 'CUST-LIAB-USDC')).toBe('0');

    // Replays and a resolve attempt never call execute() again.
    const replay = await client(t, key).post('/v1/conversions', { quoteId: q.id }, 'unk-1');
    expect(replay.body.id).toBe(res.body.id);
    expect(lp.executes).toBe(before + 1);

    const resolved = await client(t, key).post(`/v1/conversions/${res.body.id}/resolve`, {});
    expect(resolved.body).toMatchObject({ status: 'settled', providerUnknown: false });
    expect(lp.executes).toBe(before + 1);
    expect(await bal(orgId, 'CONV-INTRANSIT-ZAR')).toBe('0');
    expect(await bal(orgId, 'CUST-LIAB-USDC')).toBe(q.targetAmount);
    expect((await ledger.integrityReport(orgId)).healthy).toBe(true);
  });

  it('an unknown outcome where the provider has no order stays unresolved until an operator confirms', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Unknown NotExecuted Org');
    lp.injectFault('throw_before');
    const { res } = await quoteAndAccept(key, '1500');
    expect(res.body).toMatchObject({ status: 'processing', providerUnknown: true });

    const still = await client(t, key).post(`/v1/conversions/${res.body.id}/resolve`, {});
    expect(still.body.status).toBe('processing');
    expect(still.body.providerStatus).toBe('not_found');
    expect(await bal(orgId, 'CONV-INTRANSIT-ZAR')).toBe('1500');

    const recon = await client(t, key).post('/v1/reconciliation/runs');
    expect(recon.body.status).toBe('breaks');
    expect(recon.body.summary.unresolvedProviderOutcomes).toBe(1);

    const done = await client(t, key).post(`/v1/conversions/${res.body.id}/resolve`, { confirmNotExecuted: true });
    expect(done.body).toMatchObject({ status: 'failed', failureReason: 'LP_NOT_EXECUTED' });
    expect(await bal(orgId, 'CONV-INTRANSIT-ZAR')).toBe('0');
    expect(await bal(orgId, 'CUST-LIAB-ZAR')).toBe('1500');
  });

  it('resolve requires the dedicated scope', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Scope Org');
    const limited = (await client(t, key).post('/v1/api_keys', { name: 'rw', scopes: ['conversions:read', 'conversions:write'] })).body.secret;
    expect(orgId).toBeTruthy();
    const res = await client(t, limited).post('/v1/conversions/00000000-0000-4000-8000-000000000000/resolve', {});
    expect(res.status).toBe(403);
  });
});

describe('reconciliation', () => {
  it('is clean when ledger and custodians agree, and says it is simulated', async () => {
    const { key } = await bootstrapOrg(t, 'Recon Clean Org');
    await quoteAndAccept(key, '4000');
    const run = (await client(t, key).post('/v1/reconciliation/runs')).body;
    expect(run.status).toBe('clean');
    expect(run.source).toBe('simulated');
    expect(run.note).toMatch(/SIMULATED/);
    expect(run.summary.assets.length).toBeGreaterThan(0);
  });

  it('reports custody drift as a break, raises it, and breaks must be acknowledged by an operator', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Recon Drift Org');
    await quoteAndAccept(key, '4000');
    sandboxCustody.setRaw(orgId, 'USDC', '1');
    const run = (await client(t, key).post('/v1/reconciliation/runs')).body;
    expect(run.status).toBe('breaks');
    const brk = run.breaks.find((b: { kind: string; assetCode: string }) => b.kind === 'custody_mismatch' && b.assetCode === 'USDC');
    expect(brk).toBeTruthy();
    expect(brk.reportedAmount).toBe('1');
    // Reported custody (1) is below customer entitlements: also an insolvency break.
    expect(run.breaks.some((b: { kind: string }) => b.kind === 'insolvent')).toBe(true);

    const open = (await client(t, key).get('/v1/reconciliation/breaks?status=open')).body;
    expect(open.length).toBeGreaterThanOrEqual(2);
    const ack = await client(t, key).post(`/v1/reconciliation/breaks/${brk.id}/acknowledge`, { note: 'investigating' });
    expect(ack.body.status).toBe('acknowledged');
    expect((await client(t, key).post(`/v1/reconciliation/breaks/${brk.id}/acknowledge`, {})).status).toBe(404);
    // Acknowledging never changes a balance.
    expect(await bal(orgId, 'CUSTODY-REF-USDC')).not.toBe('1');
  });

  it('another organisation cannot see or acknowledge breaks', async () => {
    const a = await bootstrapOrg(t, 'Recon A');
    const b = await bootstrapOrg(t, 'Recon B');
    await quoteAndAccept(a.key, '1000');
    sandboxCustody.setRaw(a.orgId, 'USDC', '2');
    const run = (await client(t, a.key).post('/v1/reconciliation/runs')).body;
    expect((await client(t, b.key).get('/v1/reconciliation/breaks')).body).toEqual([]);
    expect((await client(t, b.key).post(`/v1/reconciliation/breaks/${run.breaks[0].id}/acknowledge`, {})).status).toBe(404);
  });
});
