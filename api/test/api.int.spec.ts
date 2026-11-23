import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { LAYER1_PORT } from '../src/providers/layer1/layer1.module';
import { PaymentsService } from '../src/payments/payments.service';
import { ConversionsService } from '../src/conversions/conversions.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { Layer1Port } from '../src/providers/layer1/layer1.port';
import { SandboxLayer1Adapter } from '../src/providers/layer1/sandbox.layer1';

/** Switchable custody provider so we can test what happens when the provider misbehaves. */
class ControllableLayer1 extends SandboxLayer1Adapter {
  behaviour: 'ok' | 'throw' | 'fail' = 'ok';
  calls: string[] = [];
  async requestWithdrawal(params: Parameters<Layer1Port['requestWithdrawal']>[0]) {
    this.calls.push(params.clientReference ?? '');
    if (this.behaviour === 'throw') throw new Error('socket hang up');
    if (this.behaviour === 'fail') return { providerRef: 'fail_1', status: 'failed' as const, failureReason: 'Destination rejected' };
    return super.requestWithdrawal(params);
  }
}

let t: TestApp;
const layer1 = new ControllableLayer1();
let prisma: PrismaService;
let ledger: LedgerService;

beforeAll(async () => {
  t = await createTestApp((b) => b.overrideProvider(LAYER1_PORT).useValue(layer1));
  prisma = t.app.get(PrismaService);
  ledger = t.app.get(LedgerService);
});
afterAll(async () => {
  await t?.close();
});

const integrity = async (orgId: string) => (await ledger.integrityReport(orgId)).healthy;
const liab = async (orgId: string, asset: string) => {
  const acc = await prisma.ledgerAccount.findUnique({ where: { organisationId_code: { organisationId: orgId, code: `SETTLEMENT-LIAB-${asset}` } }, include: { balances: true } });
  return acc?.balances[0]?.available.toFixed() ?? 'none';
};

describe('health and metadata', () => {
  it('reports ok with a live database connection', async () => {
    const res = await request(t.server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up', service: 'durin-api', mode: 'sandbox' });
  });

  it('is honest about readiness', async () => {
    const res = await request(t.server).get('/v1/version');
    expect(res.body.production_ready).toBe(false);
    expect(res.body.capabilities.payments.status).toBe('simulated');
    expect(res.body.capabilities.conversions.live).toBe('awaiting regulatory approval');
    expect(JSON.stringify(res.body)).not.toMatch(/high/);
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(t.server).get('/v1/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('openapi: 3.1');
  });

  it('sets security headers and does not advertise the framework', async () => {
    const res = await request(t.server).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('authentication', () => {
  it('rejects missing, malformed, wrong-environment and unknown keys', async () => {
    expect((await request(t.server).get('/v1/organisations/me')).status).toBe(401);
    expect((await client(t, 'garbage').get('/v1/organisations/me')).status).toBe(401);
    expect((await client(t, 'dk_live_' + 'a'.repeat(32)).get('/v1/organisations/me')).status).toBe(401);
    expect((await client(t, 'dk_test_' + 'a'.repeat(32)).get('/v1/organisations/me')).status).toBe(401);
  });

  it('accepts a valid key, and stops accepting it once revoked', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Auth Org');
    const me = await client(t, key).get('/v1/organisations/me');
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(orgId);

    const second = await client(t, key).post('/v1/api_keys', { name: 'second', scopes: ['organisations:read'] });
    expect(second.status).toBe(201);
    expect((await client(t, second.body.secret).get('/v1/organisations/me')).status).toBe(200);
    expect((await client(t, key).del(`/v1/api_keys/${second.body.id}`)).status).toBe(200);
    expect((await client(t, second.body.secret).get('/v1/organisations/me')).status).toBe(401);
  });

  it('never stores or returns a key secret after creation, and stores it hashed', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Hash Org');
    const list = await client(t, key).get('/v1/api_keys');
    expect(JSON.stringify(list.body)).not.toContain(key);
    const rows = await prisma.apiKey.findMany({ where: { organisationId: orgId } });
    expect(rows[0]!.keyHash.startsWith('scrypt$')).toBe(true);
    expect(rows[0]!.keyHash).not.toContain(key);
  });
});

describe('scopes and privilege escalation', () => {
  it('a key can only do what its scopes allow', async () => {
    const { key } = await bootstrapOrg(t, 'Scope Org');
    const ro = (await client(t, key).post('/v1/api_keys', { name: 'ro', scopes: ['organisations:read'] })).body.secret;
    expect((await client(t, ro).post('/v1/payment_intents', { amount: '1', assetCode: 'USDC' })).status).toBe(403);
    expect((await client(t, ro).get('/v1/organisations/me')).status).toBe(200);
  });

  it('a key cannot mint a key with scopes it does not hold, nor an admin key', async () => {
    const { key } = await bootstrapOrg(t, 'Escalation Org');
    const keymaker = (await client(t, key).post('/v1/api_keys', { name: 'km', scopes: ['api_keys:write', 'api_keys:read'] })).body.secret;
    const admin = await client(t, keymaker).post('/v1/api_keys', { name: 'x', scopes: ['admin'] });
    expect(admin.status).toBe(403);
    expect(admin.body.code).toBe('SCOPE_ESCALATION');
    const payments = await client(t, keymaker).post('/v1/api_keys', { name: 'x', scopes: ['payments:write'] });
    expect(payments.status).toBe(403);
    const ok = await client(t, keymaker).post('/v1/api_keys', { name: 'x', scopes: ['api_keys:read'] });
    expect(ok.status).toBe(201);
  });

  it('rejects unknown scopes', async () => {
    const { key } = await bootstrapOrg(t, 'Unknown Scope Org');
    const res = await client(t, key).post('/v1/api_keys', { name: 'x', scopes: ['payments:everything'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_SCOPE');
  });
});

describe('tenant isolation', () => {
  it('one organisation cannot see or act on another\'s resources', async () => {
    const a = await bootstrapOrg(t, 'Iso A');
    const b = await bootstrapOrg(t, 'Iso B');
    const intent = (await client(t, a.key).post('/v1/payment_intents', { amount: '10', assetCode: 'USDC' })).body;
    expect((await client(t, b.key).get(`/v1/payment_intents/${intent.id}`)).status).toBe(404);
    expect((await client(t, b.key).post(`/v1/payment_intents/${intent.id}/simulate_confirm`)).status).toBe(404);
    expect((await client(t, b.key).post(`/v1/payment_intents/${intent.id}/cancel`)).status).toBe(404);
    expect((await client(t, b.key).get('/v1/payment_intents')).body).toHaveLength(0);
    expect((await client(t, a.key).get(`/v1/payment_intents/${intent.id}`)).status).toBe(200);
  });

  it('malformed ids are 4xx, never 500', async () => {
    const { key } = await bootstrapOrg(t, 'Ids Org');
    for (const path of ['/v1/payment_intents/not-a-uuid', '/v1/accounts/xyz', '/v1/accounts/xyz/balances', '/v1/journals/xyz', '/v1/conversions/xyz', '/v1/quotes/xyz', '/v1/wallets/xyz', '/v1/withdrawals/xyz', '/v1/payment_links/xyz']) {
      const res = await client(t, key).get(path);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.status, path).toBeLessThan(500);
    }
    expect((await client(t, key).del('/v1/api_keys/xyz')).status).toBe(404);
    expect((await client(t, key).del('/v1/webhook_endpoints/xyz')).status).toBe(404);
  });
});

describe('payments', () => {
  it('create → simulate confirm → settled, with the right ledger entries', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Pay Org');
    const intent = await client(t, key).post('/v1/payment_intents', { amount: '100.50', assetCode: 'usdc', description: 'Invoice 1' }, 'pi-1');
    expect(intent.status).toBe(201);
    expect(intent.body).toMatchObject({ status: 'pending', amount: '100.5', assetCode: 'USDC' });
    expect(intent.body.paymentInstructions.status).toBe('simulated');

    const confirmed = await client(t, key).post(`/v1/payment_intents/${intent.body.id}/simulate_confirm`);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.status).toBe('settled');
    expect(await liab(orgId, 'USDC')).toBe('100.5');
    // Confirming again is harmless: no second journal.
    await client(t, key).post(`/v1/payment_intents/${intent.body.id}/simulate_confirm`);
    expect(await liab(orgId, 'USDC')).toBe('100.5');
    expect(await prisma.journal.count({ where: { organisationId: orgId } })).toBe(1);
    expect(await integrity(orgId)).toBe(true);
  });

  it('settling the same intent concurrently credits exactly once', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Pay Race Org');
    const intent = (await client(t, key).post('/v1/payment_intents', { amount: '25', assetCode: 'USDC' })).body;
    await Promise.all(Array.from({ length: 8 }, () => client(t, key).post(`/v1/payment_intents/${intent.id}/simulate_confirm`)));
    expect(await liab(orgId, 'USDC')).toBe('25');
    expect(await integrity(orgId)).toBe(true);
  });

  it('rejects invalid, negative, non-decimal and over-precise amounts', async () => {
    const { key } = await bootstrapOrg(t, 'Amount Org');
    for (const [amount, assetCode] of [['-5', 'USDC'], ['0', 'USDC'], ['abc', 'USDC'], ['1e3', 'USDC'], ['1.1234567', 'USDC'], ['10.005', 'ZAR'], ['', 'USDC']]) {
      const res = await client(t, key).post('/v1/payment_intents', { amount, assetCode });
      expect(res.status, `${amount} ${assetCode}`).toBe(400);
    }
    expect((await client(t, key).post('/v1/payment_intents', { amount: '10.05', assetCode: 'ZAR' })).status).toBe(201);
    expect((await client(t, key).post('/v1/payment_intents', { amount: '1', assetCode: 'DOGE' })).status).toBe(400);
  });

  it('cancelled intents cannot be settled', async () => {
    const { key } = await bootstrapOrg(t, 'Cancel Org');
    const intent = (await client(t, key).post('/v1/payment_intents', { amount: '5', assetCode: 'USDC' })).body;
    expect((await client(t, key).post(`/v1/payment_intents/${intent.id}/cancel`)).status).toBe(201);
    expect((await client(t, key).post(`/v1/payment_intents/${intent.id}/simulate_confirm`)).status).toBe(400);
  });
});

describe('idempotency over HTTP', () => {
  it('concurrent requests with one key create one resource; replays are marked', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Idem Org');
    const results = await Promise.all(Array.from({ length: 10 }, () => client(t, key).post('/v1/payment_intents', { amount: '9', assetCode: 'USDC' }, 'same-key')));
    const created = results.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] !== 'true');
    expect(created).toHaveLength(1);
    // Every other response is either a replay of the same resource or an "in progress" conflict.
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(await prisma.paymentIntent.count({ where: { organisationId: orgId } })).toBe(1);

    const replay = await client(t, key).post('/v1/payment_intents', { amount: '9', assetCode: 'USDC' }, 'same-key');
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(created[0]!.body.id);
  });

  it('the same key with a different body is a 409', async () => {
    const { key } = await bootstrapOrg(t, 'Idem Mismatch Org');
    await client(t, key).post('/v1/payment_intents', { amount: '1', assetCode: 'USDC' }, 'k1');
    const res = await client(t, key).post('/v1/payment_intents', { amount: '2', assetCode: 'USDC' }, 'k1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('the same key against a different resource is not replayed as the first', async () => {
    const { key } = await bootstrapOrg(t, 'Idem Url Org');
    const a = (await client(t, key).post('/v1/payment_intents', { amount: '1', assetCode: 'USDC' })).body;
    const b = (await client(t, key).post('/v1/payment_intents', { amount: '2', assetCode: 'USDC' })).body;
    expect((await client(t, key).post(`/v1/payment_intents/${a.id}/cancel`, {}, 'cancel-key')).status).toBe(201);
    const second = await client(t, key).post(`/v1/payment_intents/${b.id}/cancel`, {}, 'cancel-key');
    expect(second.status).toBe(409);
    expect((await client(t, key).get(`/v1/payment_intents/${b.id}`)).body.status).toBe('pending');
  });

  it('keys are scoped per organisation', async () => {
    const a = await bootstrapOrg(t, 'Idem Scope A');
    const b = await bootstrapOrg(t, 'Idem Scope B');
    const ra = await client(t, a.key).post('/v1/payment_intents', { amount: '1', assetCode: 'USDC' }, 'shared');
    const rb = await client(t, b.key).post('/v1/payment_intents', { amount: '1', assetCode: 'USDC' }, 'shared');
    expect(ra.body.id).not.toBe(rb.body.id);
  });

  it('a failed request releases its key so the client can retry', async () => {
    const { key } = await bootstrapOrg(t, 'Idem Release Org');
    const bad = await client(t, key).post('/v1/payment_intents', { amount: '-1', assetCode: 'USDC' }, 'retry-key');
    expect(bad.status).toBe(400);
    const retry = await client(t, key).post('/v1/payment_intents', { amount: '-1', assetCode: 'USDC' }, 'retry-key');
    expect(retry.status).toBe(400); // re-executed (not stuck as "in progress" 409)
  });
});

describe('conversions (sandbox)', () => {
  it('quote → accept settles with exact amounts and a balanced multi-asset journal', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Conv Org');
    const quote = await client(t, key).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '10000' });
    expect(quote.status).toBe(201);
    expect(quote.body).toMatchObject({ sourceAmount: '10000', feeAmount: '30', targetAmount: '538.91838', status: 'open' });

    const conv = await client(t, key).post('/v1/conversions', { quoteId: quote.body.id }, 'conv-1');
    expect(conv.status).toBe(201);
    expect(conv.body.status).toBe('settled');
    expect(conv.body.mode).toBe('sandbox');
    expect(await liab(orgId, 'USDC')).toBe('538.91838');
    expect(await liab(orgId, 'ZAR')).toBe('0');
    const fee = await prisma.ledgerAccount.findUniqueOrThrow({ where: { organisationId_code: { organisationId: orgId, code: 'FEE-REVENUE-ZAR' } }, include: { balances: true } });
    expect(fee.balances[0]!.available.toFixed()).toBe('30');
    expect(await integrity(orgId)).toBe(true);

    const replay = await client(t, key).post('/v1/conversions', { quoteId: quote.body.id }, 'conv-1');
    expect(replay.body.id).toBe(conv.body.id);
    // A used quote cannot be accepted again, even with a different key.
    expect((await client(t, key).post('/v1/conversions', { quoteId: quote.body.id }, 'conv-2')).status).toBe(400);
  });

  it('many concurrent accepts of one quote (different keys) convert it exactly once', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Conv Race Org');
    const quote = (await client(t, key).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '1000' })).body;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => client(t, key).post('/v1/conversions', { quoteId: quote.id }, `race-${i}`)));
    const settled = results.filter((r) => r.status === 201 && r.body.status === 'settled');
    expect(settled).toHaveLength(1);
    expect(await prisma.conversion.count({ where: { organisationId: orgId, quoteId: quote.id, status: 'settled' } })).toBe(1);
    expect(await prisma.journal.count({ where: { organisationId: orgId, reference: `conversion:quote:${quote.id}` } })).toBe(1);
    expect(await liab(orgId, 'USDC')).toBe(quote.targetAmount);
    expect(await integrity(orgId)).toBe(true);
  });

  it('expired quotes are refused', async () => {
    const { key } = await bootstrapOrg(t, 'Conv Expiry Org');
    const quote = (await client(t, key).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '500' })).body;
    await prisma.quote.update({ where: { id: quote.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await client(t, key).post('/v1/conversions', { quoteId: quote.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/);
  });

  it('rejects bad quote requests', async () => {
    const { key } = await bootstrapOrg(t, 'Conv Bad Org');
    expect((await client(t, key).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'ZAR', sourceAmount: '10' })).status).toBe(400);
    expect((await client(t, key).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '10.005' })).status).toBe(400);
    expect((await client(t, key).post('/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '-1' })).status).toBe(400);
    expect((await client(t, key).post('/v1/quotes', { sourceAsset: 'EUR', targetAsset: 'USDC', sourceAmount: '10' })).status).toBe(400);
  });
});

describe('wallets and withdrawals', () => {
  async function fundedWallet(name: string, amount = '100') {
    const org = await bootstrapOrg(t, name);
    const wallet = (await client(t, org.key).post('/v1/wallets', { label: 'main' })).body;
    const address = (await client(t, org.key).post(`/v1/wallets/${wallet.id}/addresses`, { assetCode: 'USDC' })).body;
    const dep = await client(t, org.key).post(`/v1/deposit_addresses/${address.id}/simulate_deposit`, { amount });
    expect(dep.status).toBe(201);
    return { ...org, walletId: wallet.id as string };
  }
  const dest = '0x00000000000000000000000000000000000000aa';

  it('deposit credits the customer liability; withdrawal debits it and is confirmed', async () => {
    const o = await fundedWallet('Wd Org');
    expect(await liab(o.orgId, 'USDC')).toBe('100');
    layer1.behaviour = 'ok';
    const wd = await client(t, o.key).post('/v1/withdrawals', { walletId: o.walletId, assetCode: 'USDC', amount: '40', destination: dest }, 'wd-1');
    expect(wd.status).toBe(201);
    expect(wd.body.status).toBe('confirmed');
    expect(await liab(o.orgId, 'USDC')).toBe('60');
    expect(await integrity(o.orgId)).toBe(true);
  });

  it('a replayed withdrawal never debits twice; a different payload under the same key is rejected', async () => {
    const o = await fundedWallet('Wd Idem Org');
    layer1.behaviour = 'ok';
    const body = { walletId: o.walletId, assetCode: 'USDC', amount: '30', destination: dest };
    const results = await Promise.all(Array.from({ length: 6 }, () => client(t, o.key).post('/v1/withdrawals', body, 'wd-same')));
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(await liab(o.orgId, 'USDC')).toBe('70');
    expect(await prisma.withdrawalRequest.count({ where: { organisationId: o.orgId } })).toBe(1);
    const mismatch = await client(t, o.key).post('/v1/withdrawals', { ...body, amount: '31' }, 'wd-same');
    expect(mismatch.status).toBe(409);
  });

  it('refuses a withdrawal larger than the balance and records it as failed with no money moved', async () => {
    const o = await fundedWallet('Wd Overdraw Org', '10');
    layer1.behaviour = 'ok';
    const res = await client(t, o.key).post('/v1/withdrawals', { walletId: o.walletId, assetCode: 'USDC', amount: '10.000001', destination: dest });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NEGATIVE_BALANCE');
    expect(await liab(o.orgId, 'USDC')).toBe('10');
    const row = await prisma.withdrawalRequest.findFirstOrThrow({ where: { organisationId: o.orgId } });
    expect(row.status).toBe('failed');
    expect(layer1.calls.length).toBeGreaterThanOrEqual(0);
  });

  it('concurrent withdrawals cannot overspend the balance', async () => {
    const o = await fundedWallet('Wd Race Org', '100');
    layer1.behaviour = 'ok';
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => client(t, o.key).post('/v1/withdrawals', { walletId: o.walletId, assetCode: 'USDC', amount: '15', destination: dest }, `wd-r-${i}`)));
    expect(results.filter((r) => r.status === 201 && r.body.status === 'confirmed')).toHaveLength(6);
    expect(await liab(o.orgId, 'USDC')).toBe('10');
    expect(await integrity(o.orgId)).toBe(true);
  });

  it('a provider that REJECTS the withdrawal gets its funds returned by a reversing journal', async () => {
    const o = await fundedWallet('Wd Reject Org');
    layer1.behaviour = 'fail';
    const wd = await client(t, o.key).post('/v1/withdrawals', { walletId: o.walletId, assetCode: 'USDC', amount: '25', destination: dest });
    expect(wd.body.status).toBe('failed');
    expect(wd.body.failureReason).toBe('Destination rejected');
    expect(await liab(o.orgId, 'USDC')).toBe('100');
    expect(await prisma.journal.count({ where: { organisationId: o.orgId, reference: { startsWith: 'withdrawal-reversal:' } } })).toBe(1);
    expect(await integrity(o.orgId)).toBe(true);
  });

  it('a provider call that THROWS leaves the outcome unknown: funds stay held, nothing is reversed or retried', async () => {
    const o = await fundedWallet('Wd Unknown Org');
    layer1.behaviour = 'throw';
    layer1.calls = [];
    const wd = await client(t, o.key).post('/v1/withdrawals', { walletId: o.walletId, assetCode: 'USDC', amount: '25', destination: dest }, 'wd-unknown');
    expect(wd.status).toBe(201);
    expect(wd.body.status).toBe('processing');
    expect(wd.body.failureReason).toMatch(/outcome unknown/);
    expect(await liab(o.orgId, 'USDC')).toBe('75'); // debited and held
    expect(await prisma.journal.count({ where: { organisationId: o.orgId, reference: { startsWith: 'withdrawal-reversal:' } } })).toBe(0);
    // The client retrying with the same key must not call the provider again.
    const again = await client(t, o.key).post('/v1/withdrawals', { walletId: o.walletId, assetCode: 'USDC', amount: '25', destination: dest }, 'wd-unknown');
    expect(again.body.id).toBe(wd.body.id);
    expect(layer1.calls).toHaveLength(1);
    layer1.behaviour = 'ok';
  });

  it('validates withdrawal input', async () => {
    const o = await fundedWallet('Wd Validate Org');
    const base = { walletId: o.walletId, assetCode: 'USDC', amount: '1', destination: dest };
    for (const bad of [{ ...base, amount: '0' }, { ...base, amount: '-1' }, { ...base, amount: 'x' }, { ...base, walletId: 'nope' }, { ...base, destination: 'short' }]) {
      expect((await client(t, o.key).post('/v1/withdrawals', bad)).status).toBe(400);
    }
  });
});

describe('compliance', () => {
  it('per-transaction and rolling daily limits block withdrawals', async () => {
    const org = await bootstrapOrg(t, 'Limits Org');
    const wallet = (await client(t, org.key).post('/v1/wallets', {})).body;
    const addr = (await client(t, org.key).post(`/v1/wallets/${wallet.id}/addresses`, { assetCode: 'USDC' })).body;
    await client(t, org.key).post(`/v1/deposit_addresses/${addr.id}/simulate_deposit`, { amount: '1000' });
    const dest = '0x00000000000000000000000000000000000000bb';
    layer1.behaviour = 'ok';
    expect((await client(t, org.key).post('/v1/compliance/limits', { name: 'cap', assetCode: 'USDC', perTxLimit: '50', dailyLimit: '80' })).status).toBe(201);

    const over = await client(t, org.key).post('/v1/withdrawals', { walletId: wallet.id, assetCode: 'USDC', amount: '51', destination: dest });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('LIMIT_EXCEEDED');
    expect((await client(t, org.key).post('/v1/withdrawals', { walletId: wallet.id, assetCode: 'USDC', amount: '50', destination: dest })).status).toBe(201);
    const daily = await client(t, org.key).post('/v1/withdrawals', { walletId: wallet.id, assetCode: 'USDC', amount: '40', destination: dest });
    expect(daily.status).toBe(422);
    expect(daily.body.message).toMatch(/daily limit/);
    expect((await client(t, org.key).post('/v1/withdrawals', { walletId: wallet.id, assetCode: 'USDC', amount: '30', destination: dest })).status).toBe(201);
    expect(await liab(org.orgId, 'USDC')).toBe('920');
  });

  it('four-eyes: the key that requested an approval cannot decide it; only one decision wins', async () => {
    const org = await bootstrapOrg(t, 'Approvals Org');
    const second = (await client(t, org.key).post('/v1/api_keys', { name: 'approver-1', scopes: ['compliance:write', 'compliance:read'] })).body.secret;
    const third = (await client(t, org.key).post('/v1/api_keys', { name: 'approver-2', scopes: ['compliance:write', 'compliance:read'] })).body.secret;
    const approval = (await client(t, org.key).post('/v1/compliance/approvals', { resourceType: 'withdrawal', resourceId: 'w-1', amount: '500', assetCode: 'USDC' })).body;

    const self = await client(t, org.key).post(`/v1/compliance/approvals/${approval.id}/decide`, { decision: 'approved' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('FOUR_EYES_REQUIRED');

    const [r1, r2] = await Promise.all([
      client(t, second).post(`/v1/compliance/approvals/${approval.id}/decide`, { decision: 'approved' }),
      client(t, third).post(`/v1/compliance/approvals/${approval.id}/decide`, { decision: 'rejected' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 400]);
    const final = (await client(t, org.key).get('/v1/compliance/approvals')).body[0];
    expect(['approved', 'rejected']).toContain(final.status);
  });

  it('validates compliance input instead of failing with 500s', async () => {
    const org = await bootstrapOrg(t, 'Compliance Validate Org');
    expect((await client(t, org.key).post('/v1/compliance/approvals', { resourceType: 'banana', resourceId: 'x' })).status).toBe(400);
    expect((await client(t, org.key).post('/v1/compliance/limits', { name: 'x', perTxLimit: '-5' })).status).toBe(400);
    expect((await client(t, org.key).post('/v1/compliance/approvals/not-a-uuid/decide', { decision: 'approved' })).status).toBe(404);
    expect((await client(t, org.key).post('/v1/compliance/approvals/00000000-0000-4000-8000-000000000000/decide', { decision: 'banana' })).status).toBe(400);
  });

  it('sandbox KYB approval and screening work, and the audit log records them', async () => {
    const org = await bootstrapOrg(t, 'Kyb Org');
    const v = (await client(t, org.key).post('/v1/compliance/verifications', { subjectType: 'organisation', subjectId: org.orgId })).body;
    const approved = await client(t, org.key).post(`/v1/compliance/verifications/${v.id}/simulate_approve`);
    expect(approved.body.status).toBe('approved');
    const hit = await client(t, org.key).post('/v1/compliance/screenings', { subjectType: 'customer', subjectId: 'sanctioned-person', screeningType: 'sanctions' });
    expect(hit.body.result).toBe('hit');
    expect((await client(t, org.key).get('/v1/compliance/audit')).body.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ledger API', () => {
  it('manual journals work in sandbox, validate input, and are idempotent', async () => {
    const org = await bootstrapOrg(t, 'Ledger Api Org');
    const cash = (await client(t, org.key).post('/v1/accounts', { code: 'CASH', name: 'Cash', accountType: 'asset', assetCode: 'ZAR' })).body;
    const liability = (await client(t, org.key).post('/v1/accounts', { code: 'LIAB', name: 'Liab', accountType: 'liability', assetCode: 'ZAR' })).body;
    expect((await client(t, org.key).post('/v1/accounts', { code: 'CASH', name: 'dup', accountType: 'asset', assetCode: 'ZAR' })).status).toBe(409);
    const lines = [{ accountId: cash.id, direction: 'debit', amount: '1000.00', assetCode: 'ZAR' }, { accountId: liability.id, direction: 'credit', amount: '1000.00', assetCode: 'ZAR' }];
    const j = await client(t, org.key).post('/v1/journals', { reference: 'dep', lines }, 'j-1');
    expect(j.status).toBe(201);
    expect((await client(t, org.key).get(`/v1/accounts/${liability.id}/balances`)).body.available).toBe('1000');
    expect((await client(t, org.key).post('/v1/journals', { reference: 'dep', lines: [{ ...lines[0], amount: '999' }, lines[1]] }, 'j-2')).body.code).toBe('UNBALANCED_JOURNAL');
    expect((await client(t, org.key).get('/v1/ledger/integrity')).body.healthy).toBe(true);
  });

  it('needs the admin scope for account creation, manual journals and the integrity report', async () => {
    const org = await bootstrapOrg(t, 'Ledger Scope Org');
    const reader = (await client(t, org.key).post('/v1/api_keys', { name: 'r', scopes: ['organisations:read'] })).body.secret;
    expect((await client(t, reader).post('/v1/accounts', { code: 'X', name: 'x', accountType: 'asset', assetCode: 'ZAR' })).status).toBe(403);
    expect((await client(t, reader).get('/v1/ledger/integrity')).status).toBe(403);
    expect((await client(t, reader).get('/v1/accounts')).status).toBe(200);
  });
});

describe('production gates', () => {
  it('simulated and balance-minting operations refuse to run in production', async () => {
    const org = await bootstrapOrg(t, 'Prod Gate Org');
    const intent = (await client(t, org.key).post('/v1/payment_intents', { amount: '10', assetCode: 'USDC' })).body;
    const payments = t.app.get(PaymentsService);
    const conversions = t.app.get(ConversionsService);
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(payments.createIntent(org.orgId, { amount: '1', assetCode: 'USDC' })).rejects.toMatchObject({ response: { code: 'AWAITING_REGULATORY_APPROVAL' } });
      await expect(payments.simulateConfirm(org.orgId, intent.id)).rejects.toMatchObject({ response: { code: 'AWAITING_REGULATORY_APPROVAL' } });
      await expect(conversions.createQuote(org.orgId, 'ZAR', 'USDC', '100')).rejects.toMatchObject({ response: { code: 'AWAITING_REGULATORY_APPROVAL' } });
      await expect(conversions.createConversion(org.orgId, intent.id)).rejects.toMatchObject({ response: { code: 'AWAITING_REGULATORY_APPROVAL' } });
      // The sandbox key itself stops working in production (test keys are rejected).
      expect((await client(t, org.key).get('/v1/organisations/me')).status).toBe(401);
    } finally {
      process.env.NODE_ENV = before;
    }
    expect((await client(t, org.key).get('/v1/payment_intents/' + intent.id)).body.status).toBe('pending');
  });

  it('organisation creation is gated by BOOTSTRAP_TOKEN when configured, and disabled in production without one', async () => {
    process.env.BOOTSTRAP_TOKEN = 'a-very-long-operator-token-value-123';
    try {
      expect((await request(t.server).post('/v1/organisations').send({ name: 'x' })).status).toBe(403);
      expect((await request(t.server).post('/v1/organisations').set('X-Bootstrap-Token', 'wrong').send({ name: 'x' })).status).toBe(403);
      expect((await request(t.server).post('/v1/organisations').set('X-Bootstrap-Token', process.env.BOOTSTRAP_TOKEN).send({ name: 'x' })).status).toBe(201);
    } finally {
      delete process.env.BOOTSTRAP_TOKEN;
    }
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(t.server).post('/v1/organisations').send({ name: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('BOOTSTRAP_DISABLED');
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe('input hardening', () => {
  it('rejects unknown fields and oversized bodies', async () => {
    const { key } = await bootstrapOrg(t, 'Harden Org');
    expect((await client(t, key).post('/v1/payment_intents', { amount: '1', assetCode: 'USDC', isAdmin: true })).status).toBe(400);
    const huge = 'x'.repeat(200_000);
    expect((await client(t, key).post('/v1/payment_intents', { amount: '1', assetCode: 'USDC', description: huge })).status).toBe(413);
  });

  it('does not leak internals in error responses', async () => {
    const { key } = await bootstrapOrg(t, 'Leak Org');
    const res = await client(t, key).get('/v1/payment_intents/not-a-uuid');
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|postgres|column|invalid input syntax|stack/i);
  });
});
