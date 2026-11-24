import { describe, expect, it } from 'vitest';
import { computeNetting, withinPositionLimit, type NettingOrder } from './netting';

const buy = (id: string, base: string, quote: string): NettingOrder => ({ id, side: 'buy', baseAmount: base, quoteAmount: quote });
const sell = (id: string, base: string, quote: string): NettingOrder => ({ id, side: 'sell', baseAmount: base, quoteAmount: quote });

describe('netting calculator', () => {
  it('perfectly offsetting orders need no provider trade', () => {
    const r = computeNetting([buy('a', '100', '1850'), sell('b', '100', '1840')]);
    expect(r.baseNet).toBe('0');
    expect(r.hedge).toEqual({ action: 'none', baseAmount: '0' });
    expect(r.nettingRateBps).toBe(10_000);
    expect(r.quoteNet).toBe('10'); // buyer paid 1850, seller was paid 1840: the spread DURIN keeps (before fees/hedge costs)
  });

  it('only the difference goes to the provider (buyers outweigh sellers → buy base)', () => {
    const r = computeNetting([buy('a', '100', '1850'), buy('b', '50', '925'), sell('c', '120', '2208')]);
    expect(r.baseNet).toBe('-30');
    expect(r.hedge).toEqual({ action: 'buy_base', baseAmount: '30' });
    expect(r.internallyMatchedBase).toBe('120');
    expect(r.nettingRateBps).toBe(Math.floor((240 * 10_000) / 270)); // 2×120 of 270 gross
  });

  it('sellers outweigh buyers → sell the surplus base', () => {
    const r = computeNetting([buy('a', '10', '185'), sell('b', '40', '736')]);
    expect(r.hedge).toEqual({ action: 'sell_base', baseAmount: '30' });
  });

  it('one-sided flow is hedged in full with 0 bps netting', () => {
    const r = computeNetting([buy('a', '10', '185'), buy('b', '5', '92.5')]);
    expect(r.hedge).toEqual({ action: 'buy_base', baseAmount: '15' });
    expect(r.nettingRateBps).toBe(0);
  });

  it('empty batch is a no-op; exact decimals are preserved', () => {
    expect(computeNetting([]).hedge.action).toBe('none');
    const r = computeNetting([buy('a', '0.000001', '0.00001850'), sell('b', '0.000003', '0.00005520')]);
    expect(r.baseNet).toBe('0.000002');
    expect(r.hedge).toEqual({ action: 'sell_base', baseAmount: '0.000002' });
  });

  it('rejects duplicate ids and non-positive amounts', () => {
    expect(() => computeNetting([buy('a', '1', '1'), sell('a', '1', '1')])).toThrow('Duplicate');
    expect(() => computeNetting([buy('a', '0', '1')])).toThrow('non-positive');
  });

  it('position limit is symmetric and inclusive', () => {
    expect(withinPositionLimit('-30', '30')).toBe(true);
    expect(withinPositionLimit('30.000001', '30')).toBe(false);
    expect(withinPositionLimit('-30.000001', '30')).toBe(false);
  });
});
