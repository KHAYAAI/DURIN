import { describe, expect, it } from 'vitest';
import type { Layer1Port } from '../../src/providers/layer1/layer1.port';
import type { Layer2Port } from '../../src/providers/layer2/layer2.port';
import type { LiquidityPort } from '../../src/providers/liquidity/liquidity.port';
import { randomUUID } from 'crypto';

/**
 * Behavioural contracts every provider adapter must satisfy — sandbox today, and any live adapter
 * run against the vendor's sandbox environment (set LIVE_ADAPTER_CONTRACT=1 and supply credentials
 * in the live-adapter spec). Passing proves the adapter honours DURIN's assumptions; it does NOT
 * prove the custodian's balances are real.
 */
const DECIMAL = /^\d+(\.\d+)?$/;

function snapshotContract(get: () => Promise<{ asOf: Date; balances: Array<{ assetCode: string; available: string }> }>) {
  it('reports a fresh, well-formed custody snapshot (asOf, unique upper-case assets, non-negative decimal strings)', async () => {
    const snap = await get();
    expect(snap.asOf).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - snap.asOf.getTime())).toBeLessThan(5 * 60_000);
    const assets = snap.balances.map((b) => b.assetCode);
    expect(new Set(assets).size).toBe(assets.length);
    for (const b of snap.balances) {
      expect(b.assetCode).toBe(b.assetCode.toUpperCase());
      expect(b.available).toMatch(DECIMAL);
    }
  });
}

export function layer1Contract(
  name: string,
  make: () => Promise<{ port: Layer1Port; org: string }>,
  opts: { chain: string; destination: string; assetCode?: string } = { chain: 'ethereum-sepolia', destination: '0x00000000000000000000000000000000000000aa' },
) {
  describe(`Layer1Port contract: ${name}`, () => {
    it('creates wallets and addresses with provider references', async () => {
      const { port, org } = await make();
      const w = await port.createWallet({ organisationId: org });
      expect(w.externalRef).toBeTruthy();
      const a = await port.createDepositAddress({ walletExternalRef: w.externalRef, assetCode: 'usdc', chain: opts.chain });
      expect(a.address).toBeTruthy();
      expect(a.assetCode).toBe('USDC');
      expect(a.providerRef).toBeTruthy();
    });

    it('is idempotent on clientReference: a repeated withdrawal request returns the same provider reference', async () => {
      const { port, org } = await make();
      const w = await port.createWallet({ organisationId: org });
      const req = { organisationId: org, walletExternalRef: w.externalRef, assetCode: opts.assetCode ?? 'USDC', amount: '1', destination: opts.destination, chain: opts.chain, clientReference: randomUUID() };
      const first = await port.requestWithdrawal(req);
      const second = await port.requestWithdrawal(req);
      expect(second.providerRef).toBe(first.providerRef);
    });

    snapshotContract(async () => (await make()).port.getCustodyBalances((await make()).org));
  });
}

export function layer2Contract(name: string, make: () => Promise<{ port: Layer2Port; org: string }>) {
  describe(`Layer2Port contract: ${name}`, () => {
    it('creates deposit instructions carrying a reference and the requested amount', async () => {
      const { port, org } = await make();
      const i = await port.createDepositInstruction({ organisationId: org, amount: '100.00', currency: 'ZAR' });
      expect(i.reference).toBeTruthy();
      expect(i.amount).toBe('100.00');
      expect(i.currency).toBe('ZAR');
    });
    snapshotContract(async () => { const { port, org } = await make(); return port.getCustodyBalances(org); });
  });
}

export function liquidityContract(name: string, make: () => Promise<{ port: LiquidityPort; org: string }>) {
  describe(`LiquidityPort contract: ${name}`, () => {
    const order = (org: string, ref: string) => ({ organisationId: org, clientReference: ref, quoteId: randomUUID(), sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '100', targetAmount: '5' });

    it('execute is idempotent per clientReference: the same reference never executes twice', async () => {
      const { port, org } = await make();
      const ref = randomUUID();
      const a = await port.execute(order(org, ref));
      const b = await port.execute(order(org, ref));
      expect(b).toEqual(a);
    });

    it('getOrder reports a filled order, and not_found for a reference that was never sent', async () => {
      const { port, org } = await make();
      const ref = randomUUID();
      await port.execute(order(org, ref));
      expect((await port.getOrder(org, ref)).status).toBe('filled');
      expect((await port.getOrder(org, randomUUID())).status).toBe('not_found');
    });

    it('orders are scoped to the organisation', async () => {
      const { port, org } = await make();
      const ref = randomUUID();
      await port.execute(order(org, ref));
      expect((await port.getOrder(randomUUID(), ref)).status).toBe('not_found');
    });
  });
}
