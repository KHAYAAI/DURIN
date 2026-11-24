import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { PrismaService } from '../src/prisma/prisma.service';
import { LIQUIDITY_PORT } from '../src/providers/liquidity/liquidity.module';
import { SandboxLiquidityAdapter } from '../src/providers/liquidity/sandbox.liquidity';
import { CUSTODY_TRANSFER_PORT } from '../src/providers/transfer/custody-transfer.port';
import { SandboxCustodyTransferAdapter } from '../src/providers/transfer/sandbox.custody-transfer';
import { NettingService } from '../src/conversions/netting.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { WORKOS_KEYS, WORKOS_PORT, type WorkosPort } from '../src/auth/workos.port';
import { sandboxCustody } from '../src/providers/sandbox-custody';

process.env.WORKOS_CLIENT_ID = 'client_test';
class FakeWorkos implements WorkosPort {
  configured = true; factors = new Map<string, string[]>();
  async listTotpFactorIds(u: string) { return this.factors.get(u) ?? []; }
  async enrollTotp(u: string) { this.factors.set(u, [`f_${u}`]); return { factorId: `f_${u}` }; }
  async challenge(f: string) { return { challengeId: `c_${f}_${Math.random()}` }; }
  async verify(_i: string, code: string) { return code === '123456'; }
  async portalLink() { return 'https://example.test'; }
}
class CountingLp extends SandboxLiquidityAdapter {
  executes = 0;
  async execute(p: Parameters<SandboxLiquidityAdapter['execute']>[0]) { this.executes++; return super.execute(p); }
}

const lp = new CountingLp();
const xfer = new SandboxCustodyTransferAdapter();
let t: TestApp; let prisma: PrismaService; let netting: NettingService; let ledger: LedgerService; let pk: CryptoKey;
let house: { orgId: string; key: string };
const assets = { assets: ['ZAR', 'USDC'], jurisdictions: ['ZA'] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256'); pk = pair.privateKey;
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
  t = await createTestApp((b) => b.overrideProvider(LIQUIDITY_PORT).useValue(lp).overrideProvider(CUSTODY_TRANSFER_PORT).useValue(xfer)
    .overrideProvider(WORKOS_KEYS).useValue(keys).overrideProvider(WORKOS_PORT).useValue(new FakeWorkos()));
  prisma = t.app.get(PrismaService); netting = t.app.get(NettingService); ledger = t.app.get(LedgerService);
  const res = await request(t.server).post('/v1/organisations').send({ name: 'DURIN House', house: true });
  house = { orgId: res.body.organisation.id, key: res.body.apiKey.secret };
});
afterAll(async () => { await t?.close(); });
beforeEach(() => { process.env.HOUSE_DEALING = 'off'; delete process.env.HOUSE_LIMITS; xfer.injectFault(undefined); lp.injectFault(undefined); });

async function openGate(gate: 'G2' | 'G3') {
  await prisma.gateApproval.create({ data: { organisationId: house.orgId, gate, counselReference: 'test', documentSha256: 'a'.repeat(64), scope: assets, approvedBy: 'user:test', expiresAt: new Date(Date.now() + 86_400_000) } });
}
async function closeGates() { await prisma.gateApproval.updateMany({ where: { organisationId: house.orgId }, data: { revokedAt: new Date() } }); }
const bal = async (orgId: string, code: string) => (await prisma.ledgerAccount.findUnique({ where: { organisationId_code: { organisationId: orgId, code } }, include: { balances: true } }))?.balances[0]?.available.toFixed() ?? 'none';
const quote = async (key: string, s: string, tg: string, amt: string) => (await client(t, key).post('/v1/quotes', { sourceAsset: s, targetAsset: tg, sourceAmount: amt })).body;
const accept = (key: string, q: { id: string }, idem?: string) => client(t, key).post('/v1/conversions', { quoteId: q.id }, idem);
const dueNow = (id: string) => prisma.conversion.update({ where: { id }, data: { matchingUntil: new Date(Date.now() - 1000) } });
async function customer(name: string) { const o = await bootstrapOrg(t, name); return o; }
async function allClean(...orgs: string[]) {
  for (const o of orgs) {
    const key = o === house.orgId ? house.key : (await prisma.apiKey.findFirstOrThrow({ where: { organisationId: o } })) && undefined;
    void key;
  }
}
async function recon(key: string) { return (await client(t, key).post('/v1/reconciliation/runs')).body; }
void allClean; void ledger; void sandboxCustody;

describe('house organisation and gates', () => {
  it('there is exactly one house organisation; customers cannot use house endpoints', async () => {
    const dup = await request(t.server).post('/v1/organisations').send({ name: 'Second House', house: true });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    const c = await customer('Gate Customer');
    expect((await client(t, c.key).get('/v1/house/position')).status).toBe(403);
    expect((await client(t, house.key).get('/v1/house/position')).status).toBe(200);
  });

  it('G2/G3 can only be recorded by a signed-in admin with MFA on the HOUSE organisation', async () => {
    const mk = (sub: string, orgClaim: string) => new SignJWT({ sid: `s_${sub}`, org_id: orgClaim, role: 'admin', permissions: [] }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(sub).setIssuer('https://api.workos.com/').setIssuedAt().setExpirationTime('10m').sign(pk);
    const withMfa = async (sub: string, orgClaim: string) => { const tk = await mk(sub, orgClaim); await client(t, tk).post('/v1/auth/mfa/enroll'); const ch = (await client(t, tk).post('/v1/auth/mfa/challenge', {})).body; await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' }); return tk; };
    const cust = await customer('Gate Customer 2');
    await prisma.organisation.update({ where: { id: cust.orgId }, data: { workosOrganizationId: 'org_CUST' } });
    await prisma.organisation.update({ where: { id: house.orgId }, data: { workosOrganizationId: 'org_HOUSE' } });
    const body = { counselReference: 'Opinion 9', documentSha256: 'b'.repeat(64), assets: ['ZAR', 'USDC'], jurisdictions: ['ZA'], validDays: 30 };
    const c1 = await withMfa('user_cust', 'org_CUST'); const h1 = await withMfa('user_house', 'org_HOUSE');
    expect((await client(t, c1).post('/v1/compliance/gates/g2', body)).status).toBe(403);
    expect((await client(t, house.key).post('/v1/compliance/gates/g2', body)).status).toBe(403); // API key
    const ok = await client(t, h1).post('/v1/compliance/gates/g3', body);
    expect(ok.status).toBe(201); expect(ok.body).toMatchObject({ gate: 'G3', active: true });
    expect((await client(t, h1).post('/v1/compliance/gates/g9', body)).status).toBe(400);
    await closeGates();
  });

  it('with no gate open, every conversion goes to the provider even if HOUSE_DEALING is on', async () => {
    process.env.HOUSE_DEALING = 'both'; await closeGates();
    const c = await customer('Closed Gate Customer'); const before = lp.executes;
    const r = await accept(c.key, await quote(c.key, 'ZAR', 'USDC', '1000'));
    expect(r.body).toMatchObject({ status: 'settled', executionMode: 'provider' });
    expect(lp.executes).toBe(before + 1);
  });
});

describe('own inventory (G3)', () => {
  it('fills from house inventory with no provider call; every ledger and custody reconciles', async () => {
    process.env.HOUSE_DEALING = 'inventory'; await closeGates(); await openGate('G3');
    const cap = await client(t, house.key).post('/v1/house/capital', { assetCode: 'USDC', amount: '5000', evidenceRef: 'cap-usdc-1' });
    expect(cap.status).toBe(201);
    const c = await customer('Inventory Customer'); const before = lp.executes;
    const q = await quote(c.key, 'ZAR', 'USDC', '1850');
    const r = await accept(c.key, q);
    expect(r.body).toMatchObject({ status: 'settled', executionMode: 'house' });
    expect(lp.executes).toBe(before);
    expect(await bal(c.orgId, 'CUST-LIAB-USDC')).toBe(q.targetAmount);
    expect(await bal(house.orgId, 'CUSTODY-REF-USDC')).toBe((5000 - Number(q.targetAmount)).toString());
    expect((await recon(c.key)).status).toBe('clean');
    expect((await recon(house.key)).status).toBe('clean');
    expect((await ledger.integrityReport(house.orgId)).healthy).toBe(true);
    expect((await ledger.integrityReport(c.orgId)).healthy).toBe(true);
  });

  it('insufficient inventory or a position limit falls back to the provider', async () => {
    process.env.HOUSE_DEALING = 'inventory';
    const c = await customer('Fallback Customer'); const before = lp.executes;
    const big = await accept(c.key, await quote(c.key, 'ZAR', 'USDC', '1000000'));
    expect(big.body).toMatchObject({ status: 'settled', executionMode: 'provider' });
    expect(lp.executes).toBe(before + 1);
    process.env.HOUSE_LIMITS = JSON.stringify({ ZAR: { max: '1' } });
    const lim = await accept(c.key, await quote(c.key, 'ZAR', 'USDC', '100'));
    expect(lim.body.executionMode).toBe('provider');
  });

  it('an unknown custody-transfer outcome holds the conversion; resolve re-drives it without moving funds twice', async () => {
    process.env.HOUSE_DEALING = 'inventory';
    const c = await customer('Unknown Transfer Customer');
    xfer.injectFault('throw_after', 'in-');
    const q = await quote(c.key, 'ZAR', 'USDC', '500');
    const r = await accept(c.key, q);
    expect(r.body).toMatchObject({ status: 'processing', providerUnknown: true, executionMode: 'house' });
    const before = sandboxCustody.get(c.orgId, 'ZAR');
    const done = await client(t, c.key).post(`/v1/conversions/${r.body.id}/resolve`, {});
    expect(done.body).toMatchObject({ status: 'settled', providerUnknown: false });
    expect(sandboxCustody.get(c.orgId, 'ZAR')).toBe(before); // the retried transfer was a no-op
    expect((await recon(c.key)).status).toBe('clean');
    expect((await recon(house.key)).status).toBe('clean');
  });
});

describe('internal netting (G2)', () => {
  async function pair(nameA: string, nameB: string, buyZar: string, sellUsdc: string) {
    const a = await customer(nameA); const b = await customer(nameB);
    const ca = await accept(a.key, await quote(a.key, 'ZAR', 'USDC', buyZar));
    const cb = await accept(b.key, await quote(b.key, 'USDC', 'ZAR', sellUsdc));
    expect(ca.body).toMatchObject({ status: 'processing', executionMode: 'netted' });
    await dueNow(ca.body.id); await dueNow(cb.body.id);
    return { a, b, ca: ca.body, cb: cb.body };
  }

  it('matches opposing flows through the house and hedges ONLY the residual; everything reconciles', async () => {
    process.env.HOUSE_DEALING = 'netting'; await closeGates(); await openGate('G2');
    const { a, b, ca, cb } = await pair('Net Buyer', 'Net Seller', '1850', '40');
    const before = lp.executes; const tradeUsdcBefore = await bal(house.orgId, 'HOUSE-TRADE-USDC');
    await netting.tick();
    expect(lp.executes).toBe(before + 1); // one hedge for two customers
    for (const id of [ca.id, cb.id]) expect(await prisma.conversion.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'settled', executionMode: 'netted' });
    const batch = await prisma.nettingBatch.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(batch).toMatchObject({ status: 'settled', hedgeAction: 'buy_base' });
    expect(Number(batch.hedgeBaseAmount)).toBeGreaterThan(0);
    // the batch leaves the house's USDC position unchanged (receipts + hedge = payouts); ZAR carries the spread
    expect(await bal(house.orgId, 'HOUSE-TRADE-USDC')).toBe(tradeUsdcBefore);
    for (const k of [a.key, b.key, house.key]) expect((await recon(k)).status).toBe('clean');
    for (const o of [a.orgId, b.orgId, house.orgId]) expect((await ledger.integrityReport(o)).healthy).toBe(true);
  });

  it('a lone order has nothing to match: it is hedged in full (and still settles)', async () => {
    process.env.HOUSE_DEALING = 'netting';
    const a = await customer('Lone Buyer'); const before = lp.executes;
    const ca = await accept(a.key, await quote(a.key, 'ZAR', 'USDC', '900'));
    await dueNow(ca.body.id); await netting.tick();
    expect((await prisma.conversion.findUniqueOrThrow({ where: { id: ca.body.id } })).status).toBe('settled');
    expect(lp.executes).toBe(before + 1);
    expect((await recon(a.key)).status).toBe('clean'); expect((await recon(house.key)).status).toBe('clean');
  });

  it('a REJECTED hedge unwinds the whole batch and every customer is served by the provider instead', async () => {
    process.env.HOUSE_DEALING = 'netting';
    const { a, b, ca, cb } = await pair('Rej Buyer', 'Rej Seller', '1850', '40');
    lp.injectFault('reject'); const houseZarBefore = sandboxCustody.get(house.orgId, 'ZAR');
    await netting.tick();
    for (const id of [ca.id, cb.id]) expect(await prisma.conversion.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'settled', executionMode: 'provider' });
    expect((await prisma.nettingBatch.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).status).toBe('failed');
    expect(sandboxCustody.get(house.orgId, 'ZAR')).toBe(houseZarBefore); // nothing left behind at the house
    for (const k of [a.key, b.key, house.key]) expect((await recon(k)).status).toBe('clean');
  });

  it('an UNKNOWN hedge outcome stalls the batch with funds held; resolve learns the truth and finishes', async () => {
    process.env.HOUSE_DEALING = 'netting';
    const { a, b, ca, cb } = await pair('Unk Buyer', 'Unk Seller', '1850', '40');
    lp.injectFault('throw_after'); const before = lp.executes;
    await netting.tick();
    expect(await prisma.nettingBatch.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).toMatchObject({ status: 'stalled' });
    for (const id of [ca.id, cb.id]) expect(await prisma.conversion.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'processing', providerUnknown: true });
    expect(lp.executes).toBe(before + 1);
    const res = await client(t, a.key).post(`/v1/conversions/${ca.id}/resolve`, {});
    expect(res.body.status).toBe('settled');
    expect(lp.executes).toBe(before + 1); // the order was found, never re-sent
    expect((await prisma.conversion.findUniqueOrThrow({ where: { id: cb.id } })).status).toBe('settled');
    for (const k of [a.key, b.key, house.key]) expect((await recon(k)).status).toBe('clean');
    expect((await ledger.integrityReport(house.orgId)).healthy).toBe(true);
  });

  it('a house refusal at receipt (transfer rejected) falls back to the provider with nothing stranded', async () => {
    process.env.HOUSE_DEALING = 'netting';
    const a = await customer('Xfer Reject Buyer');
    const ca = await accept(a.key, await quote(a.key, 'ZAR', 'USDC', '700')); await dueNow(ca.body.id);
    xfer.injectFault('fail', 'in-');
    await netting.tick();
    expect(await prisma.conversion.findUniqueOrThrow({ where: { id: ca.body.id } })).toMatchObject({ status: 'settled', executionMode: 'provider' });
    expect((await recon(a.key)).status).toBe('clean');
  });
});
