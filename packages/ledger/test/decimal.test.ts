import { describe, expect, it } from 'vitest';
import { add, cmp, formatDecimal, parseDecimal, sub } from '../src';

/** Small deterministic PRNG so failures are reproducible. */
function prng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
}

function randomDecimal(rnd: () => number): string {
  const integer = Math.floor(rnd() * 1e9).toString();
  const decimals = Math.floor(rnd() * 19);
  let fraction = '';
  for (let i = 0; i < decimals; i++) fraction += Math.floor(rnd() * 10).toString();
  const text = fraction ? `${integer}.${fraction}` : integer;
  return rnd() < 0.3 ? `-${text}` : text;
}

describe('decimal arithmetic', () => {
  it('has no floating point error', () => {
    expect(add('0.1', '0.2')).toBe('0.3');
    expect(sub('1', '0.9')).toBe('0.1');
    expect(add('0.000000000000000001', '0.000000000000000002')).toBe('0.000000000000000003');
  });

  it('round-trips parse and format for random values', () => {
    const rnd = prng(7);
    for (let i = 0; i < 2000; i++) {
      const value = randomDecimal(rnd);
      const canonical = formatDecimal(parseDecimal(value));
      expect(formatDecimal(parseDecimal(canonical))).toBe(canonical);
      expect(cmp(value, canonical)).toBe(0);
    }
  });

  it('satisfies commutativity, associativity and inverse for random values', () => {
    const rnd = prng(11);
    for (let i = 0; i < 2000; i++) {
      const a = randomDecimal(rnd);
      const b = randomDecimal(rnd);
      const c = randomDecimal(rnd);
      expect(add(a, b)).toBe(add(b, a));
      expect(add(add(a, b), c)).toBe(add(a, add(b, c)));
      expect(sub(add(a, b), b)).toBe(formatDecimal(parseDecimal(a)));
    }
  });

  it('orders values consistently', () => {
    expect(cmp('1', '2')).toBe(-1);
    expect(cmp('2.0', '2')).toBe(0);
    expect(cmp('-0.5', '0')).toBe(-1);
    expect(cmp('999999999999999999', '999999999999999998')).toBe(1);
  });

  it.each(['', ' 1', '1 ', '1e5', '1E-3', '+1', '1.', '.5', '--1', '1,5', 'NaN', '0x10', '1.0000000000000000001', '1234567890123456789'])(
    'rejects invalid input %j',
    (bad) => {
      expect(() => parseDecimal(bad)).toThrow();
    },
  );

  it('accepts the numeric(36,18) limits', () => {
    expect(formatDecimal(parseDecimal('999999999999999999.999999999999999999'))).toBe('999999999999999999.999999999999999999');
  });
});
