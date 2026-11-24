import { createHash } from 'crypto';
import { ProviderOutcomeUnknown } from '../errors';
import type { LiquidityOrderLookup, LiquidityOrderParams, LiquidityOrderResult, LiquidityPort } from '../liquidity/liquidity.port';
import { ValrClient, fromScaled, toScaled } from './valr-client';

/**
 * Liquidity adapter on VALR (Exchange market orders, FOK).
 *
 *  - Pair mapping: `<ASSET>ZAR` (e.g. USDCZAR); override with VALR_PAIRS='{"USDC":"USDCZAR"}'. VERIFY the
 *    symbols and minimum sizes against GET /v1/public/pairs before use.
 *  - Idempotency/lookup: the order's `customerOrderId` is derived from the DURIN organisation and conversion id,
 *    so a repeated execute() cannot place a second order, and getOrder() can find it. A transport error or 5xx on
 *    placement is an UNKNOWN outcome: this adapter throws and DURIN resolves via getOrder(), never by re-sending.
 *  - Fills are all-or-nothing (FOK). Fees: for a BUY with baseAmount VALR credits baseAmount minus its taker fee, and
 *    the executed amounts are returned in `executed` so the ledger/treasury can account for any difference.
 *  - NOT VERIFIED: the allowed characters/length of customerOrderId (we send 40 hex characters), and the exact
 *    status strings beyond those in VALR's docs. Run against VALR with a funded test account first.
 */
const TERMINAL_OK = new Set(['filled']);
const TERMINAL_BAD = new Set(['failed', 'cancelled']);

export interface ValrExecuted { paidAmount?: string; receivedAmount?: string; feeAmount?: string; feeCurrency?: string; averagePrice?: string }
declare module '../liquidity/liquidity.port' { interface LiquidityOrderResult { executed?: ValrExecuted } }

export function customerOrderId(organisationId: string, clientReference: string): string {
  const org = createHash('sha256').update(organisationId).digest('hex').slice(0, 8);
  return `${org}${clientReference.replace(/-/g, '').slice(0, 32)}`;
}

export class ValrLiquidityAdapter implements LiquidityPort {
  readonly name = 'valr';
  readonly mode = 'live' as const;
  private readonly pairs: Record<string, string>;

  constructor(
    private readonly client: ValrClient,
    private readonly opts: { treasurySubAccountId?: string; pairs?: Record<string, string>; quoteBufferBps?: number; pollMs?: number; maxPolls?: number } = {},
  ) {
    this.pairs = { USDC: 'USDCZAR', USDT: 'USDTZAR', ...(opts.pairs ?? {}) };
  }

  static fromEnv(): ValrLiquidityAdapter {
    return new ValrLiquidityAdapter(ValrClient.fromEnv(), {
      treasurySubAccountId: process.env.VALR_TREASURY_SUBACCOUNT_ID,
      pairs: process.env.VALR_PAIRS ? JSON.parse(process.env.VALR_PAIRS) : undefined,
      quoteBufferBps: process.env.VALR_QUOTE_BUFFER_BPS ? Number(process.env.VALR_QUOTE_BUFFER_BPS) : undefined,
    });
  }

  /** ZAR↔stablecoin only. Returns the VALR pair and whether the customer is BUYING the base asset. */
  private route(source: string, target: string): { pair: string; side: 'BUY' | 'SELL'; base: string } {
    const s = source.toUpperCase(), t = target.toUpperCase();
    if (s === 'ZAR' && this.pairs[t]) return { pair: this.pairs[t]!, side: 'BUY', base: t };
    if (t === 'ZAR' && this.pairs[s]) return { pair: this.pairs[s]!, side: 'SELL', base: s };
    throw new Error(`VALR adapter does not route ${s}→${t}`);
  }

  async getQuote(p: { sourceAsset: string; targetAsset: string; sourceAmount: string }) {
    const { pair, side } = this.route(p.sourceAsset, p.targetAsset);
    const r = await this.client.request('POST', `/v1/simple/${pair}/quote`, {
      subAccountId: this.opts.treasurySubAccountId, body: { payInCurrency: p.sourceAsset.toUpperCase(), payAmount: p.sourceAmount, side },
    });
    if (r.status !== 200) throw new Error(`VALR quote failed (${r.status}): ${String(r.json?.message ?? '').slice(0, 120)}`);
    const { receiveAmount, fee, feeCurrency, id } = r.json as { receiveAmount: string; fee: string; feeCurrency: string; id: string; payAmount: string };
    // VALR may quote less than requested if the book is thin ("maximum is ..."): require the full amount.
    if (r.json.payAmount && r.json.payAmount !== p.sourceAmount) throw new Error('VALR can only fill part of this amount right now');
    const buffer = this.opts.quoteBufferBps ?? 30; // protects DURIN from movement between quote and fill
    const target = scaleDown(receiveAmount, 10_000 - buffer);
    return {
      rate: ratio(target, p.sourceAmount), targetAmount: target, feeAmount: '0', feeAsset: p.sourceAsset.toUpperCase(),
      expiresInSeconds: 10, providerQuoteId: id ?? `valr-${Date.now()}`, venueFee: `${fee} ${feeCurrency}`,
    };
  }

  async execute(p: LiquidityOrderParams): Promise<LiquidityOrderResult> {
    const { pair, side, base } = this.route(p.sourceAsset, p.targetAsset);
    const id = customerOrderId(p.organisationId, p.clientReference);
    const baseAmount = side === 'BUY' ? p.targetAmount : p.sourceAmount; // base asset quantity
    void base;
    const placed = await this.client.request('POST', '/v2/orders/market', {
      subAccountId: this.opts.treasurySubAccountId,
      body: { side, baseAmount, pair, customerOrderId: id, timeInForce: 'FOK' },
    });
    if (placed.status === 400 && placed.json?.orderId === undefined) {
      // Either rejected before reaching the exchange, OR this customerOrderId already exists (a repeated call).
      // Look the order up first: only "no such order" makes this a definitive rejection.
      const existing = await this.status(pair, id);
      if (existing.status === 'filled') return { status: 'filled', providerRef: existing.providerRef, executed: await this.summary(id) };
      if (existing.status === 'rejected') return { status: 'rejected', providerRef: existing.providerRef, reason: existing.reason };
      if (existing.status === 'pending') return this.await(pair, id, existing.providerRef ?? id);
      return { status: 'rejected', reason: `VALR ${placed.json?.code ?? 400}: ${String(placed.json?.message ?? 'rejected').slice(0, 160)}` };
    }
    if (placed.status !== 201 && placed.status !== 202 && !(placed.status === 400 && placed.json?.orderId)) {
      // 401/403/429/anything else: do not assume the order was not placed.
      throw new ProviderOutcomeUnknown(`VALR order placement returned ${placed.status}`);
    }
    return this.await(pair, id, String(placed.json?.id ?? placed.json?.orderId ?? id));
  }

  private async await(pair: string, id: string, orderId: string): Promise<LiquidityOrderResult> {
    const polls = this.opts.maxPolls ?? 20;
    for (let i = 0; i < polls; i++) {
      const s = await this.status(pair, id);
      if (s.status === 'filled') return { status: 'filled', providerRef: s.providerRef ?? orderId, executed: await this.summary(id) };
      if (s.status === 'rejected') return { status: 'rejected', providerRef: s.providerRef, reason: s.reason };
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 500));
    }
    throw new ProviderOutcomeUnknown(`VALR order ${id} did not reach a final state in time`);
  }

  private async status(pair: string, id: string): Promise<LiquidityOrderLookup> {
    const r = await this.client.request('GET', `/v1/orders/${pair}/customerorderid/${id}`, { subAccountId: this.opts.treasurySubAccountId });
    if (r.status === 400 || r.status === 404) return { status: 'not_found' };
    if (r.status !== 200) throw new Error(`VALR order status failed (${r.status})`);
    const st = String(r.json.orderStatusType ?? '').toLowerCase();
    if (TERMINAL_OK.has(st)) return { status: 'filled', providerRef: r.json.orderId };
    if (TERMINAL_BAD.has(st)) return { status: 'rejected', providerRef: r.json.orderId, reason: String(r.json.failedReason || st).slice(0, 200) };
    return { status: 'pending', providerRef: r.json.orderId };
  }

  private async summary(id: string): Promise<ValrExecuted | undefined> {
    const r = await this.client.request('GET', `/v1/orders/history/summary/customerorderid/${id}`, { subAccountId: this.opts.treasurySubAccountId });
    if (r.status !== 200) return undefined;
    return { averagePrice: r.json.averagePrice, paidAmount: r.json.total, receivedAmount: r.json.totalExecutedQuantity, feeAmount: r.json.totalFee, feeCurrency: r.json.feeCurrency };
  }

  async getOrder(organisationId: string, clientReference: string): Promise<LiquidityOrderLookup> {
    const id = customerOrderId(organisationId, clientReference);
    for (const pair of new Set(Object.values(this.pairs))) {
      const s = await this.status(pair, id);
      if (s.status !== 'not_found') return s;
    }
    return { status: 'not_found' };
  }
}

function scaleDown(amount: string, numerator10k: number): string {
  return fromScaled((toScaled(amount) * BigInt(numerator10k)) / 10_000n);
}
function ratio(target: string, source: string): string {
  const s = toScaled(source);
  return s > 0n ? fromScaled((toScaled(target) * 10n ** 18n) / s) : '0';
}
