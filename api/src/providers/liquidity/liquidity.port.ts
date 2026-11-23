/**
 * Liquidity provider port — executes the actual asset swap (e.g. an exchange / OTC desk).
 * DURIN never takes market risk silently: every execution carries a client reference so the
 * provider can de-duplicate, and an unknown outcome is resolved by `getOrder`, never by retrying.
 */
export interface LiquidityOrderParams {
  organisationId: string;
  /** Idempotency reference; DURIN uses the conversion id. */
  clientReference: string;
  quoteId: string;
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  targetAmount: string;
}

export type LiquidityOrderStatus = 'filled' | 'rejected';

export interface LiquidityOrderResult {
  status: LiquidityOrderStatus;
  providerRef?: string;
  reason?: string;
}

export interface LiquidityOrderLookup {
  status: LiquidityOrderStatus | 'pending' | 'not_found';
  providerRef?: string;
  reason?: string;
}

export interface LiquidityPort {
  readonly name: string;
  readonly mode: 'sandbox' | 'live';
  /** Live providers must supply firm quotes; the sandbox uses simulated FX (conversions/fx.sandbox.ts). */
  getQuote?(params: { sourceAsset: string; targetAsset: string; sourceAmount: string }): Promise<{
    rate: string; targetAmount: string; feeAmount: string; feeAsset: string; expiresInSeconds: number; providerQuoteId: string;
  }>;
  /** Throwing (timeout, 5xx, network) means the outcome is UNKNOWN, not "failed". */
  execute(params: LiquidityOrderParams): Promise<LiquidityOrderResult>;
  getOrder(organisationId: string, clientReference: string): Promise<LiquidityOrderLookup>;
}
