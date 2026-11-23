import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { PrismaService } from '../src/prisma/prisma.service';
import { DIDIT_FETCH } from '../src/compliance/compliance.service';
import { signDiditV2 } from '../src/compliance/didit';

process.env.VERIFICATION_PROVIDER = 'didit';
process.env.DIDIT_API_KEY = 'test-key';
process.env.DIDIT_WORKFLOW_KYB = 'wf-kyb';
process.env.DIDIT_WORKFLOW_KYC = 'wf-kyc';
process.env.DIDIT_WEBHOOK_SECRET = 'whsec-test';

const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
let failNext = false;
const fakeFetch = (async (url: string, init: RequestInit) => {
  sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
  if (failNext) { failNext = false; return new Response('boom', { status: 500 }); }
  return new Response(JSON.stringify({ session_id: `sess-${sent.length}`, url: 'https://verify.didit.me/session/abc', status: 'Not Started' }), { status: 201 });
}) as unknown as typeof fetch;

let t: TestApp;
let prisma: PrismaService;
beforeAll(async () => {
  t = await createTestApp((b) => b.overrideProvider(DIDIT_FETCH).useValue(fakeFetch));
  prisma = t.app.get(PrismaService);
});
afterAll(async () => { await t?.close(); });

const deliver = (payload: Record<string, unknown>, opts: { secret?: string; ts?: number } = {}) => {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return request(t.server).post('/v1/webhooks/didit')
    .set('X-Signature-V2', signDiditV2(payload, opts.secret ?? 'whsec-test')).set('X-Timestamp', String(ts)).send(payload);
};
const event = (sessionId: string, vendor: string, status: string, id: string) => ({
  event_id: id, webhook_type: 'status.updated', timestamp: Math.floor(Date.now() / 1000), session_id: sessionId, status, vendor_data: vendor, decision: { id_verifications: [] },
});

describe('Didit KYC/KYB', () => {
  it('creates a KYB session at Didit with the record id as vendor_data and returns the hosted URL', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Didit Org');
    const res = await client(t, key).post('/v1/compliance/verifications', { subjectType: 'organisation', subjectId: orgId, level: 'kyb_basic' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ provider: 'didit', status: 'pending', mode: 'live', verificationUrl: 'https://verify.didit.me/session/abc' });
    const call = sent.at(-1)!;
    expect(call.url).toBe('https://verification.didit.me/v3/session/');
    expect(call.headers['x-api-key']).toBe('test-key');
    expect(call.body).toMatchObject({ workflow_id: 'wf-kyb', vendor_data: res.body.id });
    expect(JSON.stringify(res.body)).not.toContain('test-key');
  });

  it('uses the KYC workflow for kyc levels, and a provider error leaves no usable verification', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Didit KYC Org');
    await client(t, key).post('/v1/compliance/verifications', { subjectType: 'user', subjectId: 'u1', level: 'kyc_basic' });
    expect(sent.at(-1)!.body.workflow_id).toBe('wf-kyc');
    failNext = true;
    const bad = await client(t, key).post('/v1/compliance/verifications', { subjectType: 'organisation', subjectId: orgId, level: 'kyb_basic' });
    expect(bad.status).toBe(503);
    const rows = await prisma.verificationRecord.findMany({ where: { organisationId: orgId, level: 'kyb_basic' } });
    expect(rows.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('approves only through a correctly signed webhook; tenants cannot self-approve', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Didit Approve Org');
    const v = (await client(t, key).post('/v1/compliance/verifications', { subjectType: 'organisation', subjectId: orgId })).body;
    const sessionId = `sess-${sent.length}`;

    expect((await client(t, key).post(`/v1/compliance/verifications/${v.id}/simulate_approve`)).status).toBe(403);

    const payload = event(sessionId, v.id, 'Approved', `evt-${v.id}-1`);
    expect((await deliver(payload, { secret: 'wrong' })).status).toBe(401);
    expect((await deliver(payload, { ts: Math.floor(Date.now() / 1000) - 1000 })).status).toBe(401);
    expect((await request(t.server).post('/v1/webhooks/didit').send(payload)).status).toBe(401);
    expect((await prisma.verificationRecord.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('pending');

    const ok = await deliver(payload);
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBe('applied');
    const rec = await prisma.verificationRecord.findUniqueOrThrow({ where: { id: v.id } });
    expect(rec).toMatchObject({ status: 'approved', providerStatus: 'Approved', externalId: sessionId });

    // At-least-once delivery: the replay is acknowledged but has no further effect.
    expect((await deliver(payload)).body.result).toBe('duplicate');
    // A late "In Review" cannot downgrade a final decision.
    await deliver(event(sessionId, v.id, 'In Review', `evt-${v.id}-2`));
    expect((await prisma.verificationRecord.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('approved');
  });

  it('acknowledges events for unknown sessions without effect and ignores other event types', async () => {
    expect((await deliver(event('nope', 'nope', 'Approved', 'evt-unknown-1'))).body.result).toBe('unknown');
    expect((await deliver({ ...event('s', 'v', 'Approved', 'evt-x'), webhook_type: 'data.updated' })).body.result).toBe('ignored');
  });
});
