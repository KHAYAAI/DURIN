import { describe, it, expect } from 'vitest';
import { computeQuote, getSandboxRate } from './fx.sandbox';
import { buildConversionLines } from './journal-lines';

describe('sandbox FX', () => {
  it('returns rate for ZAR→USDC', () => {
    expect(Number(getSandboxRate('ZAR', 'USDC'))).toBeGreaterThan(0);
  });

  it('computes quote with fee', () => {
    const q = computeQuote('ZAR', 'USDC', '10000');
    expect(q.sourceAsset).toBe('ZAR');
    expect(q.targetAsset).toBe('USDC');
    expect(Number(q.feeAmount)).toBeGreaterThan(0);
    expect(Number(q.targetAmount)).toBeGreaterThan(0);
  });

  it('rejects same asset', () => {
    expect(() => getSandboxRate('ZAR', 'ZAR')).toThrow();
  });
});

describe('buildConversionLines', () => {
  it('balances per asset', () => {
    const lines = buildConversionLines({
      sourceAsset: 'ZAR',
      targetAsset: 'USDC',
      sourceAmount: '1000',
      targetAmount: '54',
      feeAmount: '3',
      sourceLiabilityId: 'sl',
      sourceAssetId: 'sa',
      targetLiabilityId: 'tl',
      targetAssetId: 'ta',
      feeRevenueId: 'fee',
    });

    const sum = (asset: string, dir: 'debit' | 'credit') =>
      lines
        .filter((l) => l.assetCode === asset && l.direction === dir)
        .reduce((s, l) => s + Number(l.amount), 0);

    expect(sum('ZAR', 'debit')).toBeCloseTo(sum('ZAR', 'credit'), 6);
    expect(sum('USDC', 'debit')).toBeCloseTo(sum('USDC', 'credit'), 6);
  });
});
