import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { PrismaService } from '../src/prisma/prisma.service';
import { WORKOS_KEYS, WORKOS_PORT, type WorkosPort } from '../src/auth/workos.port';

process.env.WORKOS_CLIENT_ID = 'client_test';

class FakeWorkos implements WorkosPort {
  configured = true;
  factors = new Map<string, string[]>();
  verifyCalls = 0;
  async listTotpFactorIds(u: string) { return this.factors.get(u) ?? []; }
  async enrollTotp(u: string) { const id = `factor_${u}`; this.factors.set(u, [id]); return { factorId: id, secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/DURIN' }; }
  async challenge(f: string) { return { challengeId: `wch_${f}_${Math.random()}`, expiresAt: new Date(Date.now() + 300_000) }; }
  async verify(_id: string, code: string) { this.verifyCalls++; return code === '123456'; }
  async portalLink(org: string, intent: string) { return `https://id.workos.com/portal/launch?org=${org}&intent=${intent}`; }
}

let t: TestApp;
let prisma: PrismaService;
const fake = new FakeWorkos();
let privateKey: CryptoKey;
let otherKey: CryptoKey;
const ISS = 'https://api.workos.com/';

const token = (claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; iss?: string; exp?: string } = {}) =>
  new SignJWT({ sid: 'session_1', org_id: 'org_WORKOS1', role: 'admin', permissions: [], ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject((claims.sub as string) ?? 'user_1')
    .setIssuer(opts.iss ?? ISS).setIssuedAt().setExpirationTime(opts.exp ?? '10m').sign(opts.key ?? privateKey);

let orgId: string;
let apiKey: string;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  t = await createTestApp((b) => b.overrideProvider(WORKOS_KEYS).useValue(keys).overrideProvider(WORKOS_PORT).useValue(fake));
  prisma = t.app.get(PrismaService);
  const boot = await bootstrapOrg(t, 'WorkOS Org');
  orgId = boot.orgId; apiKey = boot.key;
  await prisma.organisation.update({ where: { id: orgId }, data: { workosOrganizationId: 'org_WORKOS1' } });
});
afterAll(async () => { await t?.close(); });

describe('WorkOS access tokens', () => {
  it('authenticates a valid token and maps the WorkOS organization to a DURIN organisation', async () => {
    const res = await client(t, await token()).get('/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ organisationId: orgId, authMethod: 'workos', userId: 'user_1' });
    expect(res.body.scopes).toContain('admin');
  });

  it('rejects forged, expired, wrong-issuer, org-less and unsigned tokens', async () => {
    expect((await client(t, await token({}, { key: otherKey })).get('/v1/auth/me')).status).toBe(401);
    expect((await client(t, await token({}, { exp: '-10m' })).get('/v1/auth/me')).status).toBe(401);
    expect((await client(t, await token({}, { iss: 'https://evil.example/' })).get('/v1/auth/me')).status).toBe(401);
    expect((await client(t, await token({ org_id: undefined })).get('/v1/auth/me')).status).toBe(401);
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'u', sid: 's', org_id: 'org_WORKOS1', iss: ISS })).toString('base64url')}.`;
    expect((await client(t, unsigned).get('/v1/auth/me')).status).toBe(401);
    expect((await client(t, 'a.b.c').get('/v1/auth/me')).status).toBe(401);
  });

  it('refuses a token for a WorkOS organization that is not linked to any DURIN organisation', async () => {
    expect((await client(t, await token({ org_id: 'org_UNLINKED' })).get('/v1/auth/me')).status).toBe(403);
  });

  it('derives scopes from the role/permissions; a member with read-only permissions cannot write', async () => {
    const member = await token({ role: 'member', permissions: ['payments:read', 'organisations:read'] }, {});
    expect((await client(t, member).get('/v1/payment_intents')).status).toBe(200);
    expect((await client(t, member).post('/v1/payment_intents', { amount: '10', assetCode: 'USDC' })).status).toBe(403);
    const me = await client(t, member).get('/v1/auth/me');
    expect(me.body.scopes).toEqual(['payments:read', 'organisations:read']);
    // `admin` is never obtainable through a permission claim.
    const sneaky = await token({ role: 'member', permissions: ['admin', 'organisations:read'] });
    expect((await client(t, sneaky).get('/v1/auth/me')).body.scopes).toEqual(['organisations:read']);
  });
});

describe('MFA step-up (session-bound)', () => {
  const user = 'user_mfa';
  const mk = (sid = 'sess_a', sub = user) => token({ sub, sid });

  it('blocks sensitive actions until the session completes a TOTP challenge', async () => {
    const tk = await mk();
    const blocked = await client(t, tk).post('/v1/api_keys', { name: 'k', scopes: ['organisations:read'] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code ?? blocked.body.message?.code).toBe('MFA_REQUIRED');

    expect((await client(t, tk).post('/v1/auth/mfa/challenge', {})).status).toBe(403); // not enrolled
    const enrol = await client(t, tk).post('/v1/auth/mfa/enroll');
    expect(enrol.status).toBe(201);
    expect((await client(t, tk).post('/v1/auth/mfa/enroll')).status).toBe(400); // already enrolled

    const ch = (await client(t, tk).post('/v1/auth/mfa/challenge', {})).body;
    const wrong = await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '000000' });
    expect(wrong.status).toBe(403);
    expect((await client(t, tk).get('/v1/auth/mfa/status')).body.verified).toBe(false);

    const ok = await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' });
    expect(ok.status).toBe(201);
    expect(ok.body.verified).toBe(true);
    expect((await client(t, tk).post('/v1/api_keys', { name: 'k', scopes: ['organisations:read'] })).status).toBe(201);

    // A challenge is single-use.
    expect((await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' })).status).toBe(403);
  });

  it('verification is bound to the session: another session of the same user must re-verify', async () => {
    const other = await mk('sess_b');
    expect((await client(t, other).post('/v1/api_keys', { name: 'k2', scopes: ['organisations:read'] })).status).toBe(403);
  });

  it('a challenge cannot be completed by a different user or session', async () => {
    const a = await mk('sess_c', 'user_c');
    await client(t, a).post('/v1/auth/mfa/enroll');
    const ch = (await client(t, a).post('/v1/auth/mfa/challenge', {})).body;
    const intruder = await mk('sess_c', 'user_d');
    expect((await client(t, intruder).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' })).status).toBe(404);
    const otherSession = await mk('sess_x', 'user_c');
    expect((await client(t, otherSession).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' })).status).toBe(404);
  });

  it('locks a challenge after 5 wrong codes, even if the right code follows', async () => {
    const tk = await mk('sess_lock', 'user_lock');
    await client(t, tk).post('/v1/auth/mfa/enroll');
    const ch = (await client(t, tk).post('/v1/auth/mfa/challenge', {})).body;
    for (let i = 0; i < 5; i++) await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '000000' });
    const calls = fake.verifyCalls;
    expect((await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' })).status).toBe(403);
    expect(fake.verifyCalls).toBe(calls); // WorkOS is not even asked once locked
  });

  it('validates input and refuses a factor that is not the user’s own', async () => {
    const tk = await mk('sess_v', 'user_v');
    await client(t, tk).post('/v1/auth/mfa/enroll');
    expect((await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: 'x', code: 'abc' })).status).toBe(400);
    expect((await client(t, tk).post('/v1/auth/mfa/challenge', { factorId: 'factor_someone_else' })).status).toBe(404);
  });

  it('API keys are not user sessions: MFA endpoints refuse them, but they are not blocked by MFA', async () => {
    expect((await client(t, apiKey).post('/v1/auth/mfa/enroll')).status).toBe(403);
    expect((await client(t, apiKey).post('/v1/api_keys', { name: 'machine', scopes: ['organisations:read'] })).status).toBe(201);
  });

  it('SSO Admin Portal link needs admin + MFA and a linked WorkOS organization', async () => {
    const tk = await mk('sess_p', 'user_p');
    expect((await client(t, tk).post('/v1/auth/sso/portal-link', { intent: 'sso' })).status).toBe(403);
    await client(t, tk).post('/v1/auth/mfa/enroll');
    const ch = (await client(t, tk).post('/v1/auth/mfa/challenge', {})).body;
    await client(t, tk).post('/v1/auth/mfa/verify', { challengeId: ch.challengeId, code: '123456' });
    const res = await client(t, tk).post('/v1/auth/sso/portal-link', { intent: 'sso' });
    expect(res.status).toBe(201);
    expect(res.body.link).toContain('org=org_WORKOS1');
    expect((await client(t, tk).post('/v1/auth/sso/portal-link', { intent: 'bogus' })).status).toBe(400);
  });

  it('linking a WorkOS organization is an operator action (bootstrap token), not a tenant action', async () => {
    const other = await bootstrapOrg(t, 'Squatter');
    process.env.BOOTSTRAP_TOKEN = 'b'.repeat(32);
    try {
      const noToken = await client(t, other.key).put('/v1/auth/workos/organisation', { workosOrganizationId: 'org_VICTIM' });
      expect(noToken.status).toBe(403);
      // Dashboard users can never use it, even admins.
      const adminUser = await token({ sub: 'user_admin_link', sid: 's_link' });
      expect((await client(t, adminUser).put('/v1/auth/workos/organisation', { workosOrganizationId: 'org_VICTIM' })).status).toBe(403);
    } finally {
      delete process.env.BOOTSTRAP_TOKEN;
    }
  });
});
