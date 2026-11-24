import { ForbiddenException, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { parseDecimal, formatDecimal, roundToScale } from '@durin/ledger';
import { PrismaService } from '../prisma/prisma.service';
import { ConversionsService, type ConversionRow } from './conversions.service';
import { HouseService, houseConfig } from '../house/house.service';
import { HouseExecutor, HouseRejected, type HouseLeg } from '../house/house-executor.service';
import { assetScale } from '../common/money';
import { computeNetting, type NettingOrder } from './netting';

const STABLES = new Set(['USDC', 'USDT']);
const isStable = (a: string) => STABLES.has(a.toUpperCase());

function legOf(c: ConversionRow): HouseLeg {
  return { conversionId: c.id, organisationId: c.organisationId, srcAsset: c.sourceAsset, tgtAsset: c.targetAsset, net: formatDecimal(parseDecimal(c.sourceAmount.toFixed()) - parseDecimal(c.feeAmount.toFixed())), target: c.targetAmount.toFixed() };
}

/**
 * Atomic matching window (variant A in NETTING_DESIGN.md). Conversions accepted while netting is open wait up to
 * NETTING_WINDOW_SECONDS; each window's opposing flows are matched through the house organisation and ONLY the net
 * residual goes to the external provider. Order: receive all → hedge → pay all, so the house never carries an
 * unhedged position beyond the instant between provider fill and payouts. Any definitive refusal before payouts
 * unwinds the whole batch and sends every conversion to the provider individually. An unknown outcome STALLS the
 * batch (funds stay where they are; an operator re-drives it with `resolve`).
 */
@Injectable()
export class NettingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(NettingService.name);
  private timer?: NodeJS.Timeout; private running = false;

  constructor(
    private readonly prisma: PrismaService, private readonly conversions: ConversionsService,
    private readonly house: HouseService, private readonly executor: HouseExecutor,
  ) { this.conversions.registerNettingResolver(this); }

  onApplicationBootstrap() {
    if (houseConfig().mode === 'off' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 1000); this.timer.unref();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<{ batches: number }> {
    if (this.running) return { batches: 0 };
    this.running = true;
    try {
      const due = await this.prisma.conversion.findMany({ where: { executionMode: 'netted', status: 'processing', nettingBatchId: null, matchingUntil: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: 500 });
      const groups = new Map<string, ConversionRow[]>();
      for (const c of due) { const base = isStable(c.targetAsset) ? c.targetAsset : c.sourceAsset; (groups.get(base) ?? groups.set(base, []).get(base)!).push(c); }
      for (const [base, convs] of groups) {
        const batch = await this.prisma.nettingBatch.create({ data: { baseAsset: base, status: 'open' } });
        const claimed = await this.prisma.conversion.updateMany({ where: { id: { in: convs.map((c) => c.id) }, nettingBatchId: null }, data: { nettingBatchId: batch.id } });
        if (claimed.count === 0) continue;
        await this.drive(batch.id).catch((e) => this.log.error(`Batch ${batch.id} failed: ${e instanceof Error ? e.message : e}`));
      }
      return { batches: groups.size };
    } finally { this.running = false; }
  }

  /** Resumable and idempotent: safe to call again after a stall. */
  async drive(batchId: string, opts: { resume?: boolean } = {}): Promise<void> {
    const batch = await this.prisma.nettingBatch.findUniqueOrThrow({ where: { id: batchId } });
    if (batch.status === 'settled' || batch.status === 'failed') return;
    const houseOrg = await this.house.houseOrgId();
    const convs = await this.prisma.conversion.findMany({ where: { nettingBatchId: batchId, status: 'processing' }, orderBy: { createdAt: 'asc' } });
    if (!convs.length) { await this.setBatch(batchId, { status: 'settled' }); return; }
    if (!houseOrg) return this.fallbackAll(batchId, convs, [], 'NO_HOUSE_ORGANISATION');
    const base = batch.baseAsset; const quote = 'ZAR';
    const legs = convs.map(legOf);
    const orders: NettingOrder[] = convs.map((c) => (isStable(c.targetAsset)
      ? { id: c.id, side: 'buy' as const, baseAmount: c.targetAmount.toFixed(), quoteAmount: legOf(c).net }
      : { id: c.id, side: 'sell' as const, baseAmount: legOf(c).net, quoteAmount: c.targetAmount.toFixed() }));
    const net = computeNetting(orders);
    await this.setBatch(batchId, { status: 'hedging', hedgeAction: net.hedge.action, hedgeBaseAmount: net.hedge.baseAmount });

    try {
      for (const leg of legs) await this.executor.receive(houseOrg, leg);
    } catch (e) {
      if (e instanceof HouseRejected) return this.fallbackAll(batchId, convs, legs, e.reason);
      return this.stall(batchId, convs, e);
    }

    if (net.hedge.action !== 'none') {
      const action = net.hedge.action;
      const quoteEstimate = this.estimateQuote(orders, action, net.hedge.baseAmount);
      const h = { action, base, quote, baseAmount: net.hedge.baseAmount, quoteEstimate };
      let look = await this.executor.lookupHedge(houseOrg, batchId).catch((e) => e as Error);
      if (look instanceof Error) return this.stall(batchId, convs, look);
      if (look.status === 'not_found' && opts.resume && batch.status === 'stalled') {
        const minAge = Number(process.env.RESOLVE_NOT_EXECUTED_MIN_AGE_MINUTES ?? 15) * 60_000;
        if (Date.now() - batch.updatedAt.getTime() < minAge) throw new ForbiddenException({ code: 'COOLING_OFF', message: 'The hedge may still be in flight; wait for the cooling-off period.' });
      }
      try {
        if (look.status === 'filled') await this.executor.bookHedge(houseOrg, batchId, h, { status: 'filled', providerRef: look.providerRef });
        else if (look.status === 'rejected') return this.fallbackAll(batchId, convs, legs, look.reason ?? 'HEDGE_REJECTED');
        else if (look.status === 'pending') return this.stall(batchId, convs, new Error('hedge still pending'));
        else {
          const res = await this.executor.hedge(houseOrg, batchId, h);
          if (res.status === 'rejected') return this.fallbackAll(batchId, convs, legs, res.reason ?? 'HEDGE_REJECTED');
          look = res as never;
        }
      } catch (e) { return this.stall(batchId, convs, e); }
      await this.setBatch(batchId, { hedgeQuoteAmount: quoteEstimate, hedgeProviderRef: (look as { providerRef?: string }).providerRef });
    }

    await this.setBatch(batchId, { status: 'settling' });
    for (let i = 0; i < convs.length; i++) {
      const c = convs[i]!; const leg = legs[i]!;
      try {
        await this.executor.pay(houseOrg, leg);
      } catch (e) {
        if (e instanceof HouseRejected) { // this customer cannot be paid; give their source back and fail only them
          await this.executor.unreceive(houseOrg, leg).catch((u) => this.log.error(`unreceive ${c.id}: ${u}`));
          await this.conversions.failConversion(c, e.reason);
          continue;
        }
        return this.stall(batchId, convs, e);
      }
      await this.conversions.finishFilled(c, `netted:${batchId}`);
    }
    await this.setBatch(batchId, { status: 'settled' });
  }

  /** Operator resolution of a stalled batch: re-drives it (idempotently). */
  async resolveBatch(batchId: string): Promise<void> {
    const b = await this.prisma.nettingBatch.findUniqueOrThrow({ where: { id: batchId } });
    if (b.status !== 'stalled') return;
    await this.prisma.conversion.updateMany({ where: { nettingBatchId: batchId, status: 'processing' }, data: { providerUnknown: false } });
    await this.drive(batchId, { resume: true });
  }

  private estimateQuote(orders: NettingOrder[], action: 'buy_base' | 'sell_base', residual: string): string {
    const side = action === 'buy_base' ? 'buy' : 'sell';
    let b = 0n, q = 0n;
    for (const o of orders) if (o.side === side) { b += parseDecimal(o.baseAmount); q += parseDecimal(o.quoteAmount); }
    if (b === 0n) throw new Error('No orders on the hedge side');
    const cost = (q * parseDecimal(residual)) / b; // scaled 1e18 × 1e18 / 1e18
    return roundToScale(formatDecimal(cost), assetScale('ZAR'), action === 'buy_base' ? 'up' : 'down');
  }

  private async fallbackAll(batchId: string, convs: ConversionRow[], legs: HouseLeg[], reason: string): Promise<void> {
    const houseOrg = await this.house.houseOrgId();
    try {
      if (houseOrg) for (const leg of legs) await this.executor.unreceive(houseOrg, leg);
    } catch (e) { return this.stall(batchId, convs, e); }
    await this.setBatch(batchId, { status: 'failed', failureReason: reason.slice(0, 200) });
    for (const c of convs) await this.conversions.fallbackToProvider(c);
  }

  private async stall(batchId: string, convs: ConversionRow[], e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    this.log.error(`Netting batch ${batchId} STALLED: ${msg}`);
    await this.setBatch(batchId, { status: 'stalled', failureReason: msg.slice(0, 200) });
    await this.prisma.conversion.updateMany({ where: { id: { in: convs.map((c) => c.id) }, status: 'processing' }, data: { providerUnknown: true } });
  }

  private setBatch(id: string, data: Record<string, unknown>) { return this.prisma.nettingBatch.update({ where: { id }, data }); }
}
