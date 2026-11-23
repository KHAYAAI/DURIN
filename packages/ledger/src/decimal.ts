import { LedgerInvariantError } from './errors';

/**
 * Exact decimal arithmetic on strings, backed by scaled bigint.
 * 18 fractional digits and at most 18 integer digits, matching numeric(36,18).
 * No floating point is used anywhere.
 */
export const DECIMAL_SCALE = 18;
const FACTOR = 10n ** BigInt(DECIMAL_SCALE);
const MAX_INTEGER_DIGITS = 18;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** Parse a decimal string into a scaled bigint. Rejects exponents, spaces, `+`, `1.`, `.5`. */
export function parseDecimal(value: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new LedgerInvariantError('INVALID_AMOUNT', `Invalid decimal: ${JSON.stringify(value)}`);
  }
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [integer = '', fraction = ''] = body.split('.');
  if (integer.replace(/^0+(?=\d)/, '').length > MAX_INTEGER_DIGITS) {
    throw new LedgerInvariantError('INVALID_AMOUNT', `Too many integer digits: ${value}`);
  }
  if (fraction.length > DECIMAL_SCALE) {
    throw new LedgerInvariantError('INVALID_AMOUNT', `More than ${DECIMAL_SCALE} decimal places: ${value}`);
  }
  const scaled = BigInt(integer) * FACTOR + BigInt(fraction.padEnd(DECIMAL_SCALE, '0'));
  return negative ? -scaled : scaled;
}

/** Format a scaled bigint as a canonical decimal string without trailing zeros. */
export function formatDecimal(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const integer = abs / FACTOR;
  const fraction = (abs % FACTOR).toString().padStart(DECIMAL_SCALE, '0').replace(/0+$/, '');
  const text = fraction ? `${integer}.${fraction}` : `${integer}`;
  return negative ? `-${text}` : text;
}

export function add(a: string, b: string): string {
  return formatDecimal(parseDecimal(a) + parseDecimal(b));
}

export function sub(a: string, b: string): string {
  return formatDecimal(parseDecimal(a) - parseDecimal(b));
}

/** Compare two decimal strings: -1, 0 or 1. */
export function cmp(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export type RoundingMode = 'half_even' | 'down' | 'up';

/** Exact product of two decimals, rounded half-even to 18 decimal places. */
export function mul(a: string, b: string): string {
  const product = parseDecimal(a) * parseDecimal(b);
  return formatDecimal(divRound(product, FACTOR, 'half_even'));
}

/** `amount * bps / 10_000`, rounded half-even at 18 decimal places (no rounding for typical inputs). */
export function bpsOf(amount: string, bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new LedgerInvariantError('INVALID_AMOUNT', `Invalid basis points: ${bps}`);
  }
  return formatDecimal(divRound(parseDecimal(amount) * BigInt(bps), 10_000n, 'half_even'));
}

/**
 * Round a decimal to `scale` fractional digits (e.g. 2 for ZAR cents, 6 for USDC).
 * Use `down` for amounts paid out to customers and `half_even` for fees.
 */
export function roundToScale(value: string, scale: number, mode: RoundingMode = 'half_even'): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > DECIMAL_SCALE) {
    throw new LedgerInvariantError('INVALID_AMOUNT', `Invalid scale: ${scale}`);
  }
  const unit = 10n ** BigInt(DECIMAL_SCALE - scale);
  return formatDecimal(divRound(parseDecimal(value), unit, mode) * unit);
}

/** Number of fractional digits actually used by a decimal string. */
export function decimalPlaces(value: string): number {
  const scaled = parseDecimal(value);
  const fraction = (scaled < 0n ? -scaled : scaled) % FACTOR;
  if (fraction === 0n) return 0;
  return DECIMAL_SCALE - (fraction.toString().length - fraction.toString().replace(/0+$/, '').length);
}

function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let quotient = n / denominator;
  const remainder = n % denominator;
  if (remainder !== 0n) {
    const twice = remainder * 2n;
    const roundAwayFromZero =
      mode === 'up' ? true : mode === 'down' ? false : twice > denominator || (twice === denominator && quotient % 2n === 1n);
    if (roundAwayFromZero) quotient += 1n;
  }
  return negative ? -quotient : quotient;
}
