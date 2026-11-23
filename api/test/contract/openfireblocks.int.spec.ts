import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { layer1Contract } from './adapter-contracts';
import { startFakeOfb, type FakeOfb } from './fake-openfireblocks';
import { OpenFireblocksLayer1Adapter, ProviderOutcomeUnknown, fromUnits, toUnits } from '../../src/providers/layer1/openfireblocks.layer1';

let ofb: FakeOfb;
const adapter = () => new OpenFireblocksLayer1Adapter({ baseUrl: ofb.url, apiKey: 'ofb-test', timeoutMs: 2000 });
const SOL_DEST = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

beforeAll(async () => { ofb = await startFakeOfb(); });
afterAll(async () => { await ofb.close(); });

layer1Contract('openfireblocks (fake server)', async () => ({ port: adapter(), org: randomUUID() }), { chain: 'solana', destination: SOL_DEST });

describe('OpenFireblocks adapter specifics', () => {
  it('reports custody balances only for this organisation, in exact decimals, excluding SOL gas', async () => {
    const a = adapter();
    const org = randomUUID(); const other = randomUUID();
    const w1 = await a.createWallet({ organisationId: org });
    const w2 = await a.createWallet({ organisationId: org });
    const w3 = await a.createWallet({ organisationId: other });
    ofb.seed(w1.externalRef, '2500000'); ofb.seed(w2.externalRef, '1');  ofb.seed(w3.externalRef, '999000000');
    const snap = await a.getCustodyBalances(org);
    expect(snap.balances).toEqual([{ assetCode: 'USDC', available: '2.500001' }]);
    expect(Math.abs(Date.now() - snap.asOf.getTime())).toBeLessThan(5000);
  });

  it('refuses non-Solana chains instead of guessing a route (no ERC-20 via the wallet API)', async () => {
    const a = adapter();
    const w = await a.createWallet({ organisationId: randomUUID() });
    await expect(a.createDepositAddress({ walletExternalRef: w.externalRef, assetCode: 'USDC', chain: 'ethereum' })).rejects.toThrow(/Solana only/);
    await expect(a.requestWithdrawal({ walletExternalRef: w.externalRef, assetCode: 'USDC', amount: '1', destination: '0x00000000000000000000000000000000000000aa', chain: 'ethereum' })).rejects.toThrow(/Solana only/);
  });

  it('sends base units with the client reference as the provider idempotency key; repeats do not double-send', async () => {
    const a = adapter();
    const w = await a.createWallet({ organisationId: randomUUID() });
    const req = { walletExternalRef: w.externalRef, assetCode: 'USDC', amount: '2.5', destination: SOL_DEST, chain: 'solana', clientReference: randomUUID() };
    const first = await a.requestWithdrawal(req);
    const second = await a.requestWithdrawal(req);
    expect(first.status).toBe('submitted');
    expect(first.txHash).toMatch(/^sig-/);
    expect(second.txHash).toBe(first.txHash);
  });

  it('a definitive rejection is `failed`; approval-needed, 5xx and network errors are UNKNOWN (thrown)', async () => {
    const a = adapter();
    const w = await a.createWallet({ organisationId: randomUUID() });
    const base = { walletExternalRef: w.externalRef, assetCode: 'USDC', amount: '1', chain: 'solana', clientReference: randomUUID() };
    expect(await a.requestWithdrawal({ ...base, destination: 'DENIED11111111111111111111111111111111111' })).toMatchObject({ status: 'failed', failureReason: 'policy denied' });
    await expect(a.requestWithdrawal({ ...base, clientReference: randomUUID(), destination: 'PENDING1111111111111111111111111111111111' })).rejects.toBeInstanceOf(ProviderOutcomeUnknown);
    await expect(a.requestWithdrawal({ ...base, clientReference: randomUUID(), destination: 'BOOM111111111111111111111111111111111111' })).rejects.toBeInstanceOf(ProviderOutcomeUnknown);
    const down = new OpenFireblocksLayer1Adapter({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', timeoutMs: 500 });
    await expect(down.requestWithdrawal({ ...base, walletExternalRef: 'w', destination: SOL_DEST })).rejects.toBeInstanceOf(ProviderOutcomeUnknown);
  });

  it('a wrong API key is not treated as a rejection of the money movement', async () => {
    const bad = new OpenFireblocksLayer1Adapter({ baseUrl: ofb.url, apiKey: 'wrong' });
    await expect(bad.requestWithdrawal({ walletExternalRef: 'w', assetCode: 'USDC', amount: '1', destination: SOL_DEST, chain: 'solana' })).rejects.toBeInstanceOf(ProviderOutcomeUnknown);
  });

  it('unit conversion is exact and strict', () => {
    expect(toUnits('2.5', 6)).toBe('2500000');
    expect(toUnits('0.000001', 6)).toBe('1');
    expect(() => toUnits('0.0000001', 6)).toThrow();
    expect(() => toUnits('0', 6)).toThrow();
    expect(fromUnits(2500001n, 6)).toBe('2.500001');
    expect(fromUnits(0n, 6)).toBe('0');
  });
});
