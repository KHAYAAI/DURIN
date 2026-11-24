import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletsService } from '../src/wallets/wallets.service';
import { WORKOS_KEYS, WORKOS_PORT, type WorkosPort } from '../src/auth/workos.port';
import { CHAIN_REGISTRY } from '../src/chains/chain-policy';

process.env.WORKOS_CLIENT_ID = 'client_test';
class FakeWorkos implements WorkosPort {
  configured = true; factors = new Map<string, string[]>();
  async listTotpFactorIds(u: string) { return this.factors.get(u) ?? []; }
  async enrollTotp(u: string) { this.factors.set(u, [`f_${u}`]); return { factorId: `f_${u}` }; }
  async challenge(f: string) { return { challengeId: `c_${f}_${Math.random()}` }; }
  async verify(_i: string, code: string) { return code === '123456'; }
  async portalLink() { return 'https://example.test'; }
}
let t: TestApp; let prisma: PrismaService; let pk: CryptoKey; let wallets: WalletsService;
let orgId: string; let apiKey: string; let addrId: string;
const usdc = CHAIN_REGISTRY.find((e) => e.assetCode === 'USDC' && e.chain === 'ethereum-sepolia')!;
const jwt = (sub: string, sid: string) => new SignJWT({ sid, org_id: 'org_RD', role: 'admin', permissions: [] }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(sub).setIssuer('https://api.workos.com/').setIssuedAt().setExpirationTime('10m').sign(pk);
async function human(sub: string) {
  const tk = await jwt(sub, `s_${sub}`);
  await client(t, tk).post('/v1/auth/mfa/enroll');
  const ch = (await client(t, tk).post('/v1/auth/mfa/challenge', {})).body;
  await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' });
  return tk;
}
beforeAll(async () => {
  const pair = await generateKeyPair('RS256'); pk = pair.privateKey;
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
  t = await createTestApp((b) => b.overrideProvider(WORKOS_KEYS).useValue(keys).overrideProvider(WORKOS_PORT).useValue(new FakeWorkos()));
  prisma = t.app.get(PrismaService); wallets = t.app.get(WalletsService);
  const o = await bootstrapOrg(t, 'Returns Org'); orgId = o.orgId; apiKey = o.key;
  await prisma.organisation.update({ where: { id: orgId }, data: { workosOrganizationId: 'org_RD' } });
  const w = (await client(t, apiKey).post('/v1/wallets', { label: 'w' })).body;
  addrId = (await client(t, apiKey).post(`/v1/wallets/${w.id}/addresses`, { assetCode: 'USDC', chain: 'ethereum-sepolia' })).body.id;
});
afterAll(async () => { await t?.close(); });

async function reject(txHash: string, sender: string | null = '0x00000000000000000000000000000000000000cc') {
  await wallets.recordDetectedDeposit(orgId, addrId, { txHash, amount: '12.5', tokenContract: '0x0000000000000000000000000000000000000bad', confirmations: 99, sender: sender ?? undefined, baseUnits: '12500000' });
  return prisma.rejectedDeposit.findFirstOrThrow({ where: { depositAddressId: addrId, txHash } });
}

describe('wrong-token deposits: recording', () => {
  it('records a rejected deposit once (idempotent) with the sender, and never credits it', async () => {
    const r = await reject('0xr1');
    await reject('0xr1');
    expect(await prisma.rejectedDeposit.count({ where: { depositAddressId: addrId, txHash: '0xr1' } })).toBe(1);
    expect(r).toMatchObject({ status: 'detected', reason: 'WRONG_TOKEN', sender: '0x00000000000000000000000000000000000000cc' });
    expect((await client(t, apiKey).get('/v1/accounts')).body.some((a: { code: string }) => a.code === 'CUST-LIAB-USDC')).toBe(false);
  });
  it('is visible to the owner only', async () => {
    await reject('0xr2');
    expect((await client(t, apiKey).get('/v1/compliance/rejected-deposits')).body.length).toBeGreaterThan(0);
    const other = await bootstrapOrg(t, 'Other Returns Org');
    expect((await client(t, other.key).get('/v1/compliance/rejected-deposits')).body).toEqual([]);
  });
});

describe('return process', () => {
  it('API keys cannot decide on returns; users need MFA', async () => {
    const r = await reject('0xr3');
    expect((await client(t, apiKey).post(`/v1/compliance/rejected-deposits/${r.id}/review`, { decision: 'hold' })).status).toBe(403);
    const noMfa = await jwt('user_nomfa_rd', 's_nm');
    expect((await client(t, noMfa).post(`/v1/compliance/rejected-deposits/${r.id}/review`, { decision: 'hold' })).status).toBe(403);
  });

  it('review → approval by a DIFFERENT person → recorded return evidence', async () => {
    const r = await reject('0xr4');
    const alice = await human('user_alice'); const bob = await human('user_bob');
    const base = `/v1/compliance/rejected-deposits/${r.id}`;
    // screening reference is mandatory
    expect((await client(t, alice).post(`${base}/review`, { decision: 'return' })).status).toBe(400);
    const rev = await client(t, alice).post(`${base}/review`, { decision: 'return', screeningRef: 'KYT-8841' });
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ status: 'under_review', returnAddress: '0x00000000000000000000000000000000000000cc', reviewedBy: 'user:user_alice' });
    // four-eyes: the reviewer cannot approve
    expect((await client(t, alice).post(`${base}/approve`)).status).toBe(403);
    // cannot complete before approval
    expect((await client(t, alice).post(`${base}/complete`, { returnTxHash: '0xreturn1234' })).status).toBe(409);
    expect((await client(t, bob).post(`${base}/approve`)).body).toMatchObject({ status: 'approved', approvedBy: 'user:user_bob' });
    // evidence must be a different transaction
    expect((await client(t, bob).post(`${base}/complete`, { returnTxHash: '0xr4' })).status).toBe(400);
    const done = await client(t, bob).post(`${base}/complete`, { returnTxHash: '0xreturn1234' });
    expect(done.body).toMatchObject({ status: 'returned', returnTxHash: '0xreturn1234' });
    expect((await client(t, bob).post(`${base}/complete`, { returnTxHash: '0xreturn5678' })).status).toBe(409);
    const actions = (await prisma.auditLog.findMany({ where: { organisationId: orgId, resourceId: r.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['deposit.rejected', 'rejected_deposit.review_return', 'rejected_deposit.approved', 'rejected_deposit.returned']));
  });

  it('a return to a different address needs an override reason; an unknown sender needs one too', async () => {
    const r = await reject('0xr5'); const u = await reject('0xr6', null);
    const alice = await human('user_alice2');
    const other = '0x00000000000000000000000000000000000000dd';
    expect((await client(t, alice).post(`/v1/compliance/rejected-deposits/${r.id}/review`, { decision: 'return', screeningRef: 'KYT-1', returnAddress: other })).status).toBe(400);
    expect((await client(t, alice).post(`/v1/compliance/rejected-deposits/${r.id}/review`, { decision: 'return', screeningRef: 'KYT-1', returnAddress: other, overrideReason: 'Customer proved ownership by signed message' })).status).toBe(201);
    expect((await client(t, alice).post(`/v1/compliance/rejected-deposits/${u.id}/review`, { decision: 'return', screeningRef: 'KYT-2' })).status).toBe(400);
  });

  it('a held deposit stays held and cannot be approved; concurrent approvals produce one winner', async () => {
    const h = await reject('0xr7'); const c = await reject('0xr8');
    const alice = await human('user_alice3'); const bob = await human('user_bob3'); const carol = await human('user_carol3');
    await client(t, alice).post(`/v1/compliance/rejected-deposits/${h.id}/review`, { decision: 'hold', note: 'Possible sanctions exposure' });
    expect((await client(t, bob).post(`/v1/compliance/rejected-deposits/${h.id}/approve`)).status).toBe(409);
    await client(t, alice).post(`/v1/compliance/rejected-deposits/${c.id}/review`, { decision: 'return', screeningRef: 'KYT-3' });
    const res = await Promise.all([bob, carol, bob, carol].map((k) => client(t, k).post(`/v1/compliance/rejected-deposits/${c.id}/approve`)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
  });
});
void usdc;
