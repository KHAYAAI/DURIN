import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { PrismaService } from '../src/prisma/prisma.service';
import { WORKOS_KEYS, WORKOS_PORT, type WorkosPort } from '../src/auth/workos.port';
import { LIQUIDITY_PORT } from '../src/providers/liquidity/liquidity.module';
import type { LiquidityPort } from '../src/providers/liquidity/liquidity.port';

process.env.WORKOS_CLIENT_ID = 'client_test';

class FakeWorkos implements WorkosPort {
  configured = true;
  factors = new Map<string, string[]>();
  async listTotpFactorIds(u: string) { return this.factors.get(u) ?? []; }
  async enrollTotp(u: string) { this.factors.set(u, [`f_${u}`]); return { factorId: `f_${u}` }; }
  async challenge(f: string) { return { challengeId: `c_${f}_${Math.random()}` }; }
  async verify(_i: string, code: string) { return code === '123456'; }
  async portalLink() { return 'https://example.test'; }
}

/** A "live"-mode liquidity provider so the KYB and G1 gates engage. */
const liveLp: LiquidityPort = {
  name: 'fake-live-lp', mode: 'live',
  async getQuote(p) { return { rate: '18', targetAmount: '1', feeAmount: '0', feeAsset: p.sourceAsset, expiresInSeconds: 60, providerQuoteId: 'q1' }; },
  async execute() { return { status: 'filled', providerRef: 'x' }; },
  async getOrder() { return { status: 'not_found' }; },
};

let t: TestApp;
let prisma: PrismaService;
let pk: CryptoKey;
let orgId: string;
let apiKey: string;
const jwt = (sub: string, sid: string, role = 'admin') =>
  new SignJWT({ sid, org_id: 'org_G1', role, permissions: [] }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(sub).setIssuer('https://api.workos.com/').setIssuedAt().setExpirationTime('10m').sign(pk);
const sha = 'a'.repeat(64);

async function withMfa(sub: string, sid: string) {
  const tk = await jwt(sub, sid);
  await client(t, tk).post('/v1/auth/mfa/enroll');
  const ch = (await client(t, tk).post('/v1/auth/mfa/challenge', {})).body;
  await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' });
  return tk;
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  pk = pair.privateKey;
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
  t = await createTestApp((b) => b.overrideProvider(WORKOS_KEYS).useValue(keys).overrideProvider(WORKOS_PORT).useValue(new FakeWorkos()).overrideProvider(LIQUIDITY_PORT).useValue(liveLp));
  prisma = t.app.get(PrismaService);
  const o = await bootstrapOrg(t, 'G1 Org');
  orgId = o.orgId; apiKey = o.key;
  await prisma.organisation.update({ where: { id: orgId }, data: { workosOrganizationId: 'org_G1' } });
});
afterAll(async () => { await t?.close(); });

const quote = (tk: string, target = 'USDC') => client(t, tk).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: target, sourceAmount: '1000' });
const record = (tk: string, over: Record<string, unknown> = {}) =>
  client(t, tk).post('/v1/compliance/gates/g1', { counselReference: 'Opinion 2026/114', documentSha256: sha, assets: ['ZAR', 'USDC'], jurisdictions: ['ZA'], validDays: 30, ...over });

describe('Gate G1', () => {
  it('cannot be recorded by an API key, or by a user who has not completed MFA', async () => {
    expect((await record(apiKey)).status).toBe(403);
    const noMfa = await jwt('user_nomfa', 'sess_n');
    const res = await record(noMfa);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('MFA_REQUIRED');
  });

  it('live conversion is refused without KYB, then without G1, then allowed with a covering sign-off', async () => {
    const human = await withMfa('user_g1', 'sess_g1');
    const noKyb = await quote(apiKey);
    expect(noKyb.status).toBe(403);
    expect(JSON.stringify(noKyb.body)).toContain('KYB_REQUIRED');

    await prisma.verificationRecord.create({ data: { organisationId: orgId, subjectType: 'organisation', subjectId: orgId, provider: 'didit', status: 'approved', level: 'kyb_basic' } });
    const noG1 = await quote(apiKey);
    expect(noG1.status).toBe(403);
    expect(JSON.stringify(noG1.body)).toContain('AWAITING_REGULATORY_APPROVAL');

    const rec = await record(human);
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ gate: 'G1', active: true, approvedBy: 'user:user_g1' });
    expect((await quote(apiKey)).status).toBe(201);
    // Scope matters: the sign-off covers ZAR and USDC only.
    const uncovered = await quote(apiKey, 'USDT');
    expect(uncovered.status).toBe(403);

    // Revocation closes the gate immediately.
    const revoked = await client(t, human).post(`/v1/compliance/gates/g1/${rec.body.id}/revoke`);
    expect(revoked.status).toBe(201);
    expect((await quote(apiKey)).status).toBe(403);
    expect((await prisma.auditLog.findMany({ where: { organisationId: orgId, action: { startsWith: 'gate.g1' } } })).map((a) => a.action).sort()).toEqual(['gate.g1_recorded', 'gate.g1_revoked']);
  });

  it('an expired sign-off does not open the gate; inputs are validated', async () => {
    const human = await withMfa('user_g1b', 'sess_g1b');
    const rec = await record(human);
    expect(rec.status).toBe(201);
    await prisma.gateApproval.update({ where: { id: rec.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await quote(apiKey)).status).toBe(403);
    expect((await record(human, { documentSha256: 'xyz' })).status).toBe(400);
    expect((await record(human, { validDays: 9999 })).status).toBe(400);
    expect((await record(human, { assets: [] })).status).toBe(400);
  });
});
