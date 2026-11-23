import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { verifyWebhookSignature } from '@durin/shared';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { PrismaService } from '../src/prisma/prisma.service';
import { WebhookWorker, MAX_ATTEMPTS } from '../src/webhooks/webhook.worker';
import { isPublicAddress } from '../src/webhooks/safe-fetch';
import { decryptSecret } from '../src/common/crypto-secrets';

/** A real HTTP receiver whose behaviour we control. */
function startReceiver() {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const state = { status: 200 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = state.status;
      res.end('ok');
    });
  });
  return new Promise<{ url: string; received: typeof received; state: typeof state; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/hook`, received, state, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let t: TestApp;
let prisma: PrismaService;
let worker: WebhookWorker;
let receiver: Awaited<ReturnType<typeof startReceiver>>;

beforeAll(async () => {
  t = await createTestApp();
  prisma = t.app.get(PrismaService);
  worker = t.app.get(WebhookWorker);
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver?.close();
  await t?.close();
});
beforeEach(async () => {
  receiver.received.length = 0;
  receiver.state.status = 200;
  process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = 'true';
  // The worker serves every organisation, so deliveries left pending by earlier tests would
  // otherwise reach this test's receiver. Retire them to keep each test isolated.
  await prisma.$executeRaw`UPDATE webhook_deliveries SET status = 'failed' WHERE status = 'pending'`;
});

async function org(name: string, events: string[] = ['*']) {
  const o = await bootstrapOrg(t, name);
  const ep = await client(t, o.key).post('/v1/webhook_endpoints', { url: receiver.url, events });
  expect(ep.status).toBe(201);
  return { ...o, endpointId: ep.body.id as string, secret: ep.body.secret as string };
}
async function settlePayment(o: { key: string }, amount = '10') {
  const intent = (await client(t, o.key).post('/v1/payment_intents', { amount, assetCode: 'USDC' })).body;
  await client(t, o.key).post(`/v1/payment_intents/${intent.id}/simulate_confirm`);
  return intent.id as string;
}
const makeDue = (id: string) => prisma.$executeRaw`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}::uuid`;

describe('signed delivery', () => {
  it('delivers the event with a signature the customer can verify, outside the request path', async () => {
    const o = await org('Hook Org');
    const intentId = await settlePayment(o);

    // Nothing was sent during the request: the event is queued.
    expect(receiver.received).toHaveLength(0);
    const queued = await prisma.webhookDelivery.findMany({ where: { organisationId: o.orgId } });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('pending');

    expect(await worker.runOnce()).toBe(1);
    expect(receiver.received).toHaveLength(1);
    const { headers, body } = receiver.received[0]!;
    expect(verifyWebhookSignature(o.secret, headers['durin-signature'] as string, body)).toEqual({ valid: true });
    expect(verifyWebhookSignature('whsec_wrong', headers['durin-signature'] as string, body)).toMatchObject({ valid: false });
    const event = JSON.parse(body);
    expect(event).toMatchObject({ object: 'event', type: 'payment_intent.settled', livemode: false });
    expect(event.data.object.id).toBe(intentId);
    expect(event.id).toBe(headers['durin-event-id']);

    const done = await prisma.webhookDelivery.findFirstOrThrow({ where: { organisationId: o.orgId } });
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(1);
    expect(done.deliveredAt).not.toBeNull();
  });

  it('respects event subscriptions', async () => {
    const o = await org('Subscription Org', ['conversion.settled']);
    await settlePayment(o);
    expect(await prisma.webhookDelivery.count({ where: { organisationId: o.orgId } })).toBe(0);
    const quote = (await client(t, o.key).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '1000' })).body;
    await client(t, o.key).post('/v1/conversions', { quoteId: quote.id });
    const rows = await prisma.webhookDelivery.findMany({ where: { organisationId: o.orgId } });
    expect(rows.map((r) => r.eventType)).toEqual(['conversion.settled']);
  });

  it('a webhook problem never fails or slows the API request', async () => {
    const o = await org('Slow Hook Org');
    receiver.state.status = 500;
    const started = Date.now();
    const res = await client(t, o.key).post('/v1/payment_intents', { amount: '5', assetCode: 'USDC' });
    const intentId = res.body.id;
    const confirm = await client(t, o.key).post(`/v1/payment_intents/${intentId}/simulate_confirm`);
    expect(confirm.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('the signing secret is stored encrypted and never listed', async () => {
    const o = await org('Secret Org');
    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: o.endpointId } });
    expect(row.secretEnc).not.toContain(o.secret);
    expect(row.secretEnc.startsWith('v1.')).toBe(true);
    expect(decryptSecret(row.secretEnc)).toBe(o.secret);
    const list = await client(t, o.key).get('/v1/webhook_endpoints');
    expect(JSON.stringify(list.body)).not.toContain(o.secret);
    expect(JSON.stringify(list.body)).not.toContain('secretEnc');
  });

  it('rotating the secret makes new deliveries verify only with the new secret', async () => {
    const o = await org('Rotate Org');
    const rotated = await client(t, o.key).post(`/v1/webhook_endpoints/${o.endpointId}/rotate_secret`);
    expect(rotated.status).toBe(201);
    await settlePayment(o);
    await worker.runOnce();
    const { headers, body } = receiver.received[0]!;
    expect(verifyWebhookSignature(rotated.body.secret, headers['durin-signature'] as string, body).valid).toBe(true);
    expect(verifyWebhookSignature(o.secret, headers['durin-signature'] as string, body).valid).toBe(false);
  });
});

describe('retries', () => {
  it('a failing endpoint is retried later with backoff, then succeeds', async () => {
    const o = await org('Retry Org');
    receiver.state.status = 500;
    await settlePayment(o);
    await worker.runOnce();

    let d = await prisma.webhookDelivery.findFirstOrThrow({ where: { organisationId: o.orgId } });
    expect(d).toMatchObject({ status: 'pending', attempts: 1, lastStatus: 500 });
    expect(d.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // backed off, not hammered
    expect(await worker.runOnce()).toBe(0); // not due yet

    receiver.state.status = 200;
    await makeDue(d.id);
    expect(await worker.runOnce()).toBe(1);
    d = await prisma.webhookDelivery.findFirstOrThrow({ where: { organisationId: o.orgId } });
    expect(d).toMatchObject({ status: 'succeeded', attempts: 2 });
    // Same event id on every attempt, so receivers can de-duplicate.
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[0]!.headers['durin-event-id']).toBe(receiver.received[1]!.headers['durin-event-id']);
  });

  it('gives up after the maximum number of attempts', async () => {
    const o = await org('Give Up Org');
    receiver.state.status = 503;
    await settlePayment(o);
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { organisationId: o.orgId } });
    await prisma.$executeRaw`UPDATE webhook_deliveries SET attempts = ${MAX_ATTEMPTS - 1} WHERE id = ${d.id}::uuid`;
    await worker.runOnce();
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, lastStatus: 503 });
  });

  it('two workers running at once deliver each event exactly once', async () => {
    const o = await org('Concurrent Workers Org');
    for (let i = 0; i < 6; i++) await settlePayment(o, String(i + 1));
    const counts = await Promise.all([worker.runOnce(), worker.runOnce(), worker.runOnce()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
    expect(receiver.received).toHaveLength(6);
    expect(new Set(receiver.received.map((r) => r.headers['durin-event-id'])).size).toBe(6);
  });

  it('a delivery to a removed endpoint is marked failed, not retried forever', async () => {
    const o = await org('Removed Org');
    await settlePayment(o);
    await prisma.webhookEndpoint.update({ where: { id: o.endpointId }, data: { status: 'disabled' } });
    await worker.runOnce();
    expect(await prisma.webhookDelivery.findFirstOrThrow({ where: { organisationId: o.orgId } })).toMatchObject({ status: 'failed' });
  });

  it('exposes the delivery log to the owner only', async () => {
    const o = await org('Log Org');
    await settlePayment(o);
    await worker.runOnce();
    const log = await client(t, o.key).get(`/v1/webhook_endpoints/${o.endpointId}/deliveries`);
    expect(log.status).toBe(200);
    expect(log.body[0]).toMatchObject({ eventType: 'payment_intent.settled', status: 'succeeded' });
    expect(log.body[0]).not.toHaveProperty('payload');
    const other = await bootstrapOrg(t, 'Log Other Org');
    expect((await client(t, other.key).get(`/v1/webhook_endpoints/${o.endpointId}/deliveries`)).status).toBe(404);
  });
});

describe('SSRF protection', () => {
  it('classifies addresses correctly', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:7f00:1', '::FFFF:7F00:1', '2001:db8::1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('refuses to register internal, metadata, non-https and credentialed URLs', async () => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = 'false';
    const { key } = await bootstrapOrg(t, 'Ssrf Org');
    for (const url of [
      'http://example.com/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/hook', 'https://10.0.0.1/hook', 'https://192.168.0.10:8443/hook', 'https://user:pass@example.com/hook',
      'https://metadata.internal/', 'https://db.local/', 'ftp://example.com/', 'javascript:alert(1)', 'not a url', 'file:///etc/passwd',
    ]) {
      const res = await client(t, key).post('/v1/webhook_endpoints', { url, events: ['*'] });
      expect(res.status, url).toBe(400);
      expect(res.body.code, url).toBe('UNSAFE_WEBHOOK_URL');
    }
  });

  it('refuses to deliver to an internal address even if one was stored directly (defence in depth)', async () => {
    const o = await org('Ssrf Delivery Org');
    await settlePayment(o);
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = 'false';
    await worker.runOnce();
    expect(receiver.received).toHaveLength(0);
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { organisationId: o.orgId } });
    expect(d.lastError).toMatch(/https|non-public|not allowed/i);
  });

  it('ignores the private-target override in production', async () => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = 'true';
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { assertWebhookUrlAllowed } = await import('../src/webhooks/safe-fetch');
      await expect(assertWebhookUrlAllowed('https://127.0.0.1/hook')).rejects.toThrow();
      await expect(assertWebhookUrlAllowed('http://example.com')).rejects.toThrow();
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it('validates event types and limits the number of endpoints', async () => {
    const { key } = await bootstrapOrg(t, 'Events Org');
    expect((await client(t, key).post('/v1/webhook_endpoints', { url: receiver.url, events: ['bogus.event'] })).status).toBe(400);
    for (let i = 0; i < 20; i++) expect((await client(t, key).post('/v1/webhook_endpoints', { url: receiver.url, events: ['*'] })).status).toBe(201);
    expect((await client(t, key).post('/v1/webhook_endpoints', { url: receiver.url, events: ['*'] })).status).toBe(400);
  });
});
