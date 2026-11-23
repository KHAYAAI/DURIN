import { describe, expect, it } from 'vitest';
import { bpsOf, decimalPlaces, mul, roundToScale, sub } from '../src';

describe('mul', () => {
  it('multiplies exactly', () => {
    expect(mul('9970', '0.054054')).toBe('538.91838');
    expect(mul('0.1', '0.2')).toBe('0.02');
    expect(mul('-2.5', '4')).toBe('-10');
  });
});

describe('bpsOf', () => {
  it('computes basis points exactly', () => {
    expect(bpsOf('10000', 30)).toBe('30');
    expect(bpsOf('1', 30)).toBe('0.003');
    expect(bpsOf('100', 10000)).toBe('100');
  });
  it('rejects invalid basis points', () => {
    expect(() => bpsOf('1', -1)).toThrow();
    expect(() => bpsOf('1', 10001)).toThrow();
    expect(() => bpsOf('1', 0.5)).toThrow();
  });
});

describe('roundToScale', () => {
  it('rounds half-even', () => {
    expect(roundToScale('0.125', 2)).toBe('0.12');
    expect(roundToScale('0.135', 2)).toBe('0.14');
    expect(roundToScale('2.5', 0)).toBe('2');
    expect(roundToScale('3.5', 0)).toBe('4');
    expect(roundToScale('-0.125', 2)).toBe('-0.12');
  });
  it('rounds down (toward zero) for payouts', () => {
    expect(roundToScale('538.9183899', 6, 'down')).toBe('538.918389');
    expect(roundToScale('0.999999', 2, 'down')).toBe('0.99');
    expect(roundToScale('-0.999999', 2, 'down')).toBe('-0.99');
  });
  it('rounds up (away from zero)', () => {
    expect(roundToScale('0.001', 2, 'up')).toBe('0.01');
    expect(roundToScale('-0.001', 2, 'up')).toBe('-0.01');
  });
  it('never creates value when rounding down', () => {
    for (const v of ['1.999999999', '0.000000001', '123456.789012345678']) {
      expect(sub(v, roundToScale(v, 6, 'down')).startsWith('-')).toBe(false);
    }
  });
});

describe('decimalPlaces', () => {
  it('counts used fractional digits', () => {
    expect(decimalPlaces('100')).toBe(0);
    expect(decimalPlaces('100.50')).toBe(1);
    expect(decimalPlaces('0.000001')).toBe(6);
    expect(decimalPlaces('-3.14')).toBe(2);
  });
});
