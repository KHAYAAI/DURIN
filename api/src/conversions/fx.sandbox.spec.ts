import { describe, it, expect } from 'vitest';
import { add, cmp, mul, parseDecimal, sub } from '@durin/ledger';
import { computeQuote, getSandboxRate } from './fx.sandbox';
import { fillLines, releaseLines, reserveLines, settleLines } from './journal-lines';

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

describe('conversion journals', () => {
  const a = {
    srcCustomer: 'sc', srcInTransit: 'sit', srcLp: 'slp', srcFee: 'sf', srcCustody: 'scu',
    tgtCustomer: 'tc', tgtLp: 'tlp', tgtCustody: 'tcu',
  };
  const params = { sourceAsset: 'USDC', targetAsset: 'ZAR', source: '100', fee: '0.3', target: '1840.5' };
  const sums = (lines: Array<{ amount: string; assetCode: string; direction: string }>, asset: string, dir: string) =>
    lines.filter((l) => l.assetCode === asset && l.direction === dir).reduce((n, l) => add(n, l.amount), '0');
  const balanced = (lines: Array<{ amount: string; assetCode: string; direction: string }>) => {
    for (const asset of ['USDC', 'ZAR']) expect(sums(lines, asset, 'debit')).toBe(sums(lines, asset, 'credit'));
  };

  it('reserve, release, fill and settle each balance per asset', () => {
    balanced(reserveLines(a, 'USDC', '100'));
    balanced(releaseLines(a, 'USDC', '100'));
    balanced(fillLines(a, params));
    balanced(settleLines(a, params));
  });

  it('fill credits the customer target and books the fee as revenue', () => {
    const lines = fillLines(a, params);
    expect(lines.find((l) => l.accountId === 'tc')).toMatchObject({ direction: 'credit', amount: '1840.5' });
    expect(lines.find((l) => l.accountId === 'sf')).toMatchObject({ direction: 'credit', amount: '0.3' });
  });

  it('with no fee there is no fee line', () => {
    const lines = fillLines(a, { ...params, fee: '0' });
    expect(lines.some((l) => l.accountId === 'sf')).toBe(false);
    balanced(lines);
  });

  it('rejects a fee larger than the source amount', () => {
    expect(() => fillLines(a, { ...params, fee: '101' })).toThrow('Fee exceeds source amount');
  });
});
