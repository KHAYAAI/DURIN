import { add, cmp, sub } from '@durin/ledger';

/**
 * Netting calculator for one asset pair. PURE and not wired into conversions (see NETTING_DESIGN.md):
 * it answers "if these orders were matched internally, what remains to be hedged with the provider,
 * and is that within the position limit?". All arithmetic is exact decimal.
 *
 * Convention: `base` is the asset whose net position is hedged (e.g. USDC); `quote` is the other (ZAR).
 *  - A BUY order delivers `base` to the customer and takes `quote` (source net of fee).
 *  - A SELL order delivers `quote` to the customer and takes `base`.
 */
export interface NettingOrder {
  id: string;
  side: 'buy' | 'sell';
  /** Base asset amount: delivered to the customer on a buy; received from the customer on a sell. */
  baseAmount: string;
  /** Quote asset amount: received from the customer (net of fee) on a buy; delivered on a sell. */
  quoteAmount: string;
}

export interface NettingResult {
  /** Σ base received from sellers − Σ base owed to buyers. Negative: must BUY base from the provider. */
  baseNet: string;
  /** Σ quote received from buyers − Σ quote owed to sellers (before the cost of the residual hedge). */
  quoteNet: string;
  hedge: { action: 'none' | 'buy_base' | 'sell_base'; baseAmount: string };
  /** Base amount matched internally, i.e. NOT sent to the provider. */
  internallyMatchedBase: string;
  /** Share of gross base flow that did not need the provider, in basis points (0–10000). */
  nettingRateBps: number;
}

export function computeNetting(orders: NettingOrder[]): NettingResult {
  const ids = new Set<string>();
  let baseFromSellers = '0', baseToBuyers = '0', quoteFromBuyers = '0', quoteToSellers = '0';
  for (const o of orders) {
    if (ids.has(o.id)) throw new Error(`Duplicate order id ${o.id}`);
    ids.add(o.id);
    if (cmp(o.baseAmount, '0') <= 0 || cmp(o.quoteAmount, '0') <= 0) throw new Error(`Order ${o.id} has a non-positive amount`);
    if (o.side === 'buy') { baseToBuyers = add(baseToBuyers, o.baseAmount); quoteFromBuyers = add(quoteFromBuyers, o.quoteAmount); }
    else { baseFromSellers = add(baseFromSellers, o.baseAmount); quoteToSellers = add(quoteToSellers, o.quoteAmount); }
  }
  const baseNet = sub(baseFromSellers, baseToBuyers);
  const quoteNet = sub(quoteFromBuyers, quoteToSellers);
  const c = cmp(baseNet, '0');
  const residual = c < 0 ? sub('0', baseNet) : baseNet;
  const gross = add(baseFromSellers, baseToBuyers);
  const matched = cmp(baseFromSellers, baseToBuyers) < 0 ? baseFromSellers : baseToBuyers;
  // matched counts on both sides of the cross, so gross flow avoided = 2 × matched.
  const avoided = add(matched, matched);
  return {
    baseNet,
    quoteNet,
    hedge: { action: c === 0 ? 'none' : c < 0 ? 'buy_base' : 'sell_base', baseAmount: c === 0 ? '0' : residual },
    internallyMatchedBase: matched,
    nettingRateBps: bpsOfGross(avoided, gross),
  };
}

function bpsOfGross(avoided: string, gross: string): number {
  if (cmp(gross, '0') === 0) return 0;
  // Integer basis points via scaled bigint math (18dp strings → compare with cross-multiplication).
  const toBig = (s: string) => { const [i, f = ''] = s.split('.'); return BigInt(i! + f.padEnd(18, '0').slice(0, 18)); };
  return Number((toBig(avoided) * 10_000n) / toBig(gross));
}

/** Is the unhedged position within the approved limit? A breach means: stop netting, send every order to the provider. */
export function withinPositionLimit(unhedgedBase: string, maxAbsBase: string): boolean {
  const abs = cmp(unhedgedBase, '0') < 0 ? sub('0', unhedgedBase) : unhedgedBase;
  return cmp(abs, maxAbsBase) <= 0;
}
