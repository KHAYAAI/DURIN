import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { layer1Contract, layer2Contract, liquidityContract } from './adapter-contracts';
import { startFakeValr, type FakeValr } from './fake-valr';
import { ValrClient, signValr } from '../../src/providers/valr/valr-client';
import { ValrLayer1Adapter } from '../../src/providers/valr/valr.layer1';
import { ValrLayer2Adapter } from '../../src/providers/valr/valr.layer2';
import { ValrLiquidityAdapter, customerOrderId } from '../../src/providers/valr/valr.liquidity';
import { ProviderOutcomeUnknown } from '../../src/providers/errors';

const KEY = 'k'.repeat(64); const SECRET = 's'.repeat(64);
let v: FakeValr;
const client = () => new ValrClient({ baseUrl: v.url, apiKey: KEY, apiSecret: SECRET, timeoutMs: 2000 });
const lp = () => new ValrLiquidityAdapter(client(), { pollMs: 5, maxPolls: 5 });
const l1 = () => new ValrLayer1Adapter(client());
const l2 = () => new ValrLayer2Adapter(client(), { depositBank: { bankAccountName: 'VALR Collections', bankAccountNumber: '123', branchCode: '000000' } });
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

beforeAll(async () => { v = await startFakeValr(KEY, SECRET); });
afterAll(async () => { await v.close(); });

// VALR has no idempotency key on crypto withdrawals, so that contract case is skipped (documented gap).
layer1Contract('valr (fake server)', async () => ({ port: l1(), org: randomUUID() }), { chain: 'solana', destination: SOL, providerIdempotent: false });
layer2Contract('valr (fake server)', async () => ({ port: l2(), org: randomUUID() }));
liquidityContract('valr (fake server)', async () => ({ port: lp(), org: randomUUID() }));

describe('VALR request signing', () => {
  it('matches the algorithm in VALR docs (HMAC-SHA512 of ts+VERB+path+body+subaccount)', () => {
    // Independent vector computed with Python hmac/hashlib.
    expect(signValr('secret', '1700000000000', 'post', '/v1/orders?x=1', '{"a":1}', '42')).toBe(
      '7ccc0c73de67fb558ae50dfea842f954de08e4bda3e66641a9a79617b6d4dbc6f587d5a2129d3abf1bcfb5ed542b705f58f6f2ce92d9a1a1a05744b985c36ef0');
  });
  it('the server rejects a bad signature', async () => {
    const bad = new ValrClient({ baseUrl: v.url, apiKey: KEY, apiSecret: 'x'.repeat(64) });
    expect((await bad.request('GET', '/v1/account/subaccounts')).status).toBe(403);
  });
});

describe('VALR liquidity adapter', () => {
  it('places an FOK market order with a derived customerOrderId and reports executed amounts', async () => {
    const org = randomUUID(); const ref = randomUUID();
    const r = await lp().execute({ organisationId: org, clientReference: ref, quoteId: randomUUID(), sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '1850', targetAmount: '100' });
    expect(r.status).toBe('filled');
    expect(r.executed).toMatchObject({ averagePrice: '18.5', feeCurrency: 'USDC' });
    const placed = v.orders.get(customerOrderId(org, ref))!;
    expect(placed).toMatchObject({ pair: 'USDCZAR', side: 'BUY', baseAmount: '100' });
  });

  it('a customer selling USDC maps to SELL of the source base amount', async () => {
    const org = randomUUID(); const ref = randomUUID();
    await lp().execute({ organisationId: org, clientReference: ref, quoteId: randomUUID(), sourceAsset: 'USDC', targetAsset: 'ZAR', sourceAmount: '50', targetAmount: '920' });
    expect(v.orders.get(customerOrderId(org, ref))).toMatchObject({ side: 'SELL', baseAmount: '50' });
  });

  it('an exchange-side rejection is definitive; a repeated reference does not place a second order', async () => {
    v.failNextOrder = 'insufficient';
    const org = randomUUID();
    const rej = await lp().execute({ organisationId: org, clientReference: randomUUID(), quoteId: randomUUID(), sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '10', targetAmount: '1' });
    expect(rej).toMatchObject({ status: 'rejected' });
    const ref = randomUUID(); const before = v.orders.size;
    const o = { organisationId: org, clientReference: ref, quoteId: randomUUID(), sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '10', targetAmount: '1' };
    await lp().execute(o); await lp().execute(o);
    expect(v.orders.size).toBe(before + 1);
  });

  it('a 5xx on placement is an UNKNOWN outcome and is never retried; getOrder then reports truth', async () => {
    v.failNextOrder = '500';
    const org = randomUUID(); const ref = randomUUID(); const before = v.placeCalls;
    await expect(lp().execute({ organisationId: org, clientReference: ref, quoteId: randomUUID(), sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '10', targetAmount: '1' })).rejects.toBeInstanceOf(ProviderOutcomeUnknown);
    expect(v.placeCalls).toBe(before + 1);
    expect((await lp().getOrder(org, ref)).status).toBe('not_found');
  });

  it('refuses pairs it does not route, and quotes with a protective buffer', async () => {
    await expect(lp().execute({ organisationId: randomUUID(), clientReference: randomUUID(), quoteId: 'q', sourceAsset: 'USDC', targetAsset: 'USDT', sourceAmount: '1', targetAmount: '1' })).rejects.toThrow(/does not route/);
    const q = await lp().getQuote({ sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '1850' });
    expect(q.targetAmount).toBe('99.7'); // 100 USDC less the 30 bps default buffer
    expect(q.expiresInSeconds).toBeLessThanOrEqual(10);
  });
});

describe('VALR custody and rand adapters', () => {
  it('creates a subaccount per wallet, gets the right network address, and sums only this organisation', async () => {
    const a = l1(); const org = randomUUID(); const other = randomUUID();
    const w1 = await a.createWallet({ organisationId: org }); const w2 = await a.createWallet({ organisationId: other });
    const addr = await a.createDepositAddress({ walletExternalRef: w1.externalRef, assetCode: 'usdc', chain: 'solana' });
    expect(addr.address).toBe(`ADDR-${w1.externalRef}-USDC`);
    v.balances.set(w1.externalRef, [{ currency: 'USDC', available: '10.5', reserved: '0.5', total: '11', }, { currency: 'ZAR', available: '5', reserved: '0', total: '5' }]);
    v.balances.set(w2.externalRef, [{ currency: 'USDC', available: '999', reserved: '0', total: '999' }]);
    const snap = await a.getCustodyBalances(org);
    expect(snap.balances).toEqual([{ assetCode: 'USDC', available: '11' }]);
  });

  it('withdrawals: 202 submitted; 400 failed; 500 unknown; unmapped chain refused', async () => {
    const a = l1(); const w = await a.createWallet({ organisationId: randomUUID() });
    const base = { walletExternalRef: w.externalRef, assetCode: 'USDC', amount: '1', chain: 'solana' };
    expect(await a.requestWithdrawal({ ...base, destination: SOL })).toMatchObject({ status: 'submitted' });
    expect(v.withdrawals.at(-1)).toMatchObject({ networkType: 'Solana', asset: 'USDC' });
    expect(await a.requestWithdrawal({ ...base, destination: 'BAD-address' })).toMatchObject({ status: 'failed' });
    await expect(a.requestWithdrawal({ ...base, destination: 'BOOM-address' })).rejects.toBeInstanceOf(ProviderOutcomeUnknown);
    await expect(a.requestWithdrawal({ ...base, destination: SOL, chain: 'dogechain' })).rejects.toThrow();
  });

  it('rand: deposit reference per organisation subaccount; payouts only to already-linked bank accounts', async () => {
    const a = l2(); const org = randomUUID();
    const i1 = await a.createDepositInstruction({ organisationId: org, amount: '100', currency: 'ZAR' });
    const i2 = await a.createDepositInstruction({ organisationId: org, amount: '200', currency: 'ZAR' });
    expect(i1.reference).toBe(i2.reference);
    expect(i1).toMatchObject({ bankAccountName: 'VALR Collections', mode: 'live' });
    const ok = await a.initiatePayout({ organisationId: org, amount: '50', currency: 'ZAR', beneficiaryName: 'x', beneficiaryAccount: '62792461544', beneficiaryBranch: '250655' });
    expect(ok.status).toBe('accepted');
    const unlinked = await a.initiatePayout({ organisationId: org, amount: '50', currency: 'ZAR', beneficiaryName: 'x', beneficiaryAccount: '999' });
    expect(unlinked).toMatchObject({ status: 'failed' });
    expect(unlinked.failureReason).toMatch(/NOT_LINKED/);
    expect(v.fiatWithdrawals).toBe(1);
  });
});
