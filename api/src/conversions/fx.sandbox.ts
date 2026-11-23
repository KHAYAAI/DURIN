/**
 * Sandbox FX rates — deterministic, not live market data.
 * Status: simulated
 *
 * All arithmetic is exact decimal (no floating point). Rounding policy:
 *  - fee: round half-even to the source asset's scale
 *  - target amount: round DOWN to the target asset's scale (never pay out more than quoted)
 */
import { bpsOf, cmp, decimalPlaces, mul, roundToScale, sub } from '@durin/ledger';
import { assetScale } from '../common/money';

export type Asset = 'ZAR' | 'USDC' | 'USDT';

/** 1 unit of base in quote terms (sandbox). */
const SANDBOX_RATES: Record<string, string> = {
  'USDC/ZAR': '18.50',
  'USDT/ZAR': '18.45',
  'ZAR/USDC': '0.054054', // 1/18.50
  'ZAR/USDT': '0.054201',
  'USDC/USDT': '0.999',
  'USDT/USDC': '1.001',
};

export const SANDBOX_FEE_BPS = 30; // 0.30% sandbox fee on source

export function getSandboxRate(source: string, target: string): string {
  if (source === target) {
    throw new Error('Source and target asset must differ');
  }
  const key = `${source}/${target}`;
  const rate = SANDBOX_RATES[key];
  if (!rate) {
    throw new Error(`No sandbox rate for ${key}`);
  }
  return rate;
}

export function computeQuote(sourceAsset: string, targetAsset: string, sourceAmount: string) {
  const source = sourceAsset.toUpperCase();
  const target = targetAsset.toUpperCase();
  const rate = getSandboxRate(source, target);

  if (cmp(sourceAmount, '0') <= 0) throw new Error('sourceAmount must be positive');
  if (decimalPlaces(sourceAmount) > assetScale(source)) {
    throw new Error(`${source} supports at most ${assetScale(source)} decimal places`);
  }

  const fee = roundToScale(bpsOf(sourceAmount, SANDBOX_FEE_BPS), assetScale(source), 'half_even');
  const netSource = sub(sourceAmount, fee);
  const targetAmount = roundToScale(mul(netSource, rate), assetScale(target), 'down');
  if (cmp(targetAmount, '0') <= 0) throw new Error('Amount too small to convert');

  return {
    rate,
    feeAmount: fee,
    feeAsset: source,
    targetAmount,
    sourceAmount,
    sourceAsset: source,
    targetAsset: target,
    feeBps: SANDBOX_FEE_BPS,
    expiresInSeconds: 60,
  };
}
