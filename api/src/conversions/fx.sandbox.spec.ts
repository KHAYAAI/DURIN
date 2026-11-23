import { describe, it, expect } from 'vitest';
import { add, cmp, mul, parseDecimal, sub } from '@durin/ledger';
import { computeQuote, getSandboxRate } from './fx.sandbox';
import { buildConversionLines } from './journal-lines';

describe('sandbox FX', () => {
  it('returns rate for ZAR→USDC', () => {
    expect(cmp(getSandboxRate('ZAR', 'USDC'), '0')).toBe(1);
  });

  it('computes an exact quote with fee for R10,000', () => {
    const q = computeQuote('ZAR', 'USDC', '10000');
    expect(q.sourceAsset).toBe('ZAR');
    expect(q.targetAsset).toBe('USDC');
    expect(q.feeAmount).toBe('30'); // 0.30% of 10000
    expect(q.targetAmount).toBe('538.91838'); // (10000 - 30) * 0.054054
  });

  it('never pays out more than the exact rate allows (rounds down)', () => {
    const q = computeQuote('ZAR', 'USDC', '123.45');
    const net = sub('123.45', q.feeAmount);
    expect(cmp(q.targetAmount, mul(net, q.rate))).toBeLessThanOrEqual(0);
  });

  it('rejects same asset, non-positive, over-precise and dust amounts', () => {
    expect(() => getSandboxRate('ZAR', 'ZAR')).toThrow();
    expect(() => computeQuote('ZAR', 'USDC', '0')).toThrow();
    expect(() => computeQuote('ZAR', 'USDC', '-5')).toThrow();
    expect(() => computeQuote('ZAR', 'USDC', '10.005')).toThrow(/decimal places/);
    expect(() => computeQuote('USDC', 'ZAR', '0.000001')).toThrow(/too small/); // rounds down to zero cents
    expect(() => computeQuote('ZAR', 'USDC', '1e3')).toThrow();
  });
});

describe('buildConversionLines', () => {
  const sums = (lines: ReturnType<typeof buildConversionLines>, asset: string, dir: 'debit' | 'credit') =>
    lines.filter((l) => l.assetCode === asset && l.direction === dir).reduce((s, l) => add(s, l.amount), '0');

  it('balances exactly per asset', () => {
    const q = computeQuote('ZAR', 'USDC', '10000');
    const lines = buildConversionLines({
      sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '10000', targetAmount: q.targetAmount, feeAmount: q.feeAmount,
      sourceLiabilityId: 'sl', sourceAssetId: 'sa', targetLiabilityId: 'tl', targetAssetId: 'ta', feeRevenueId: 'fee',
    });
    expect(sums(lines, 'ZAR', 'debit')).toBe(sums(lines, 'ZAR', 'credit'));
    expect(sums(lines, 'USDC', 'debit')).toBe(sums(lines, 'USDC', 'credit'));
    expect(parseDecimal(sums(lines, 'ZAR', 'debit'))).toBe(parseDecimal('10000'));
  });

  it('balances with float-hostile amounts and without a fee', () => {
    const lines = buildConversionLines({
      sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '0.3', targetAmount: '0.1', feeAmount: '0.1',
      sourceLiabilityId: 'sl', sourceAssetId: 'sa', targetLiabilityId: 'tl', targetAssetId: 'ta', feeRevenueId: 'fee',
    });
    expect(sums(lines, 'ZAR', 'debit')).toBe(sums(lines, 'ZAR', 'credit'));
    const noFee = buildConversionLines({
      sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '5', targetAmount: '1', feeAmount: '0',
      sourceLiabilityId: 'sl', sourceAssetId: 'sa', targetLiabilityId: 'tl', targetAssetId: 'ta', feeRevenueId: 'fee',
    });
    expect(noFee).toHaveLength(4);
  });

  it('rejects a fee larger than the source amount', () => {
    expect(() =>
      buildConversionLines({
        sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '1', targetAmount: '1', feeAmount: '2',
        sourceLiabilityId: 'sl', sourceAssetId: 'sa', targetLiabilityId: 'tl', targetAssetId: 'ta', feeRevenueId: 'fee',
      }),
    ).toThrow();
  });
});
