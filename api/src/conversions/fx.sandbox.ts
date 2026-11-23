/**
 * Sandbox FX rates — deterministic, not live market data.
 * Status: simulated
 */

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

const FEE_BPS = 30; // 0.30% sandbox fee on source

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

/** fee and target amounts as decimal strings (simple string math via Number for sandbox only; ledger uses precise types). */
export function computeQuote(sourceAsset: string, targetAsset: string, sourceAmount: string) {
  const rate = getSandboxRate(sourceAsset.toUpperCase(), targetAsset.toUpperCase());
  const src = Number(sourceAmount);
  if (!(src > 0)) throw new Error('sourceAmount must be positive');

  const fee = (src * FEE_BPS) / 10_000;
  const netSource = src - fee;
  const targetAmount = netSource * Number(rate);

  return {
    rate,
    feeAmount: fee.toFixed(8).replace(/\.?0+$/, match => (match.includes('.') ? match.replace(/0+$/, '').replace(/\.$/, '') : match)) || '0',
    feeAsset: sourceAsset.toUpperCase(),
    targetAmount: targetAmount.toFixed(8).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, ''),
    sourceAmount: sourceAmount,
    sourceAsset: sourceAsset.toUpperCase(),
    targetAsset: targetAsset.toUpperCase(),
    expiresInSeconds: 60,
  };
}
