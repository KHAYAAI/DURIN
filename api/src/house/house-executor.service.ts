import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { HouseService } from './house.service';
import { CUSTODY_TRANSFER_PORT, type CustodyTransferPort } from '../providers/transfer/custody-transfer.port';
import { LIQUIDITY_PORT } from '../providers/liquidity/liquidity.module';
import type { LiquidityOrderResult, LiquidityPort } from '../providers/liquidity/liquidity.port';

/** A definitive refusal before the house took any irreversible step (or after it was fully undone). */
export class HouseRejected extends Error { constructor(public readonly reason: string) { super(reason); } }

export interface HouseLeg { conversionId: string; organisationId: string; srcAsset: string; tgtAsset: string; net: string; target: string }

/**
 * The house's side of a customer conversion, as small IDEMPOTENT steps (every transfer reference, journal key and
 * provider reference is derived from the conversion/batch id, so a stalled run can simply be re-driven):
 *
 *   receive:  customer custody → house custody (src net N)         Dr H.CUSTODY-REF-src / Cr H.HOUSE-TRADE-src
 *   hedge:    house ⇄ external provider for the NET residual       (batch only)
 *   pay:      house custody → customer custody (tgt T)             Dr H.HOUSE-TRADE-tgt / Cr H.CUSTODY-REF-tgt
 *
 * Order matters: ALL receipts, then the hedge, then ALL payouts, so the house never pays out value it has not
 * received. Customer-side journals are posted by the conversion state machine after `pay`.
 */
@Injectable()
export class HouseExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly house: HouseService,
    @Inject(CUSTODY_TRANSFER_PORT) private readonly transfers: CustodyTransferPort,
    @Inject(LIQUIDITY_PORT) private readonly liquidity: LiquidityPort,
  ) {}

  get transferMode() { return this.transfers.mode; }

  private async journalExists(houseOrg: string, key: string) {
    return !!(await this.prisma.journal.findUnique({ where: { organisationId_idempotencyKey: { organisationId: houseOrg, idempotencyKey: key } }, select: { id: true } }));
  }

  async receive(houseOrg: string, leg: HouseLeg): Promise<void> {
    const t = await this.transfers.move({ fromOrganisationId: leg.organisationId, toOrganisationId: houseOrg, assetCode: leg.srcAsset, amount: leg.net, reference: `in-${leg.conversionId}` });
    if (t.status !== 'completed') throw new HouseRejected(t.reason ?? 'TRANSFER_REJECTED');
    const a = await this.house.accounts(houseOrg, leg.srcAsset);
    await this.ledger.postJournal(houseOrg, {
      reference: `house-recv:${leg.conversionId}`, description: `House received ${leg.net} ${leg.srcAsset}`,
      lines: [{ accountId: a.custody.id, direction: 'debit', amount: leg.net, assetCode: leg.srcAsset }, { accountId: a.trading.id, direction: 'credit', amount: leg.net, assetCode: leg.srcAsset }],
    }, `house-recv-${leg.conversionId}`);
  }

  /** Give the customer's source value back (only if it was received). Idempotent. */
  async unreceive(houseOrg: string, leg: HouseLeg): Promise<void> {
    if (!(await this.journalExists(houseOrg, `house-recv-${leg.conversionId}`))) return;
    const a = await this.house.accounts(houseOrg, leg.srcAsset);
    await this.ledger.postJournal(houseOrg, {
      reference: `house-unrecv:${leg.conversionId}`, description: `Reverse house receipt ${leg.net} ${leg.srcAsset}`,
      lines: [{ accountId: a.trading.id, direction: 'debit', amount: leg.net, assetCode: leg.srcAsset }, { accountId: a.custody.id, direction: 'credit', amount: leg.net, assetCode: leg.srcAsset }],
    }, `house-unrecv-${leg.conversionId}`);
    const t = await this.transfers.move({ fromOrganisationId: houseOrg, toOrganisationId: leg.organisationId, assetCode: leg.srcAsset, amount: leg.net, reference: `back-${leg.conversionId}` });
    if (t.status !== 'completed') throw new Error(`Could not return ${leg.net} ${leg.srcAsset} to the customer: ${t.reason}`); // stalls; operator re-drives
  }

  async pay(houseOrg: string, leg: HouseLeg): Promise<void> {
    const a = await this.house.accounts(houseOrg, leg.tgtAsset);
    try {
      await this.ledger.postJournal(houseOrg, {
        reference: `house-pay:${leg.conversionId}`, description: `House pays ${leg.target} ${leg.tgtAsset}`,
        lines: [{ accountId: a.trading.id, direction: 'debit', amount: leg.target, assetCode: leg.tgtAsset }, { accountId: a.custody.id, direction: 'credit', amount: leg.target, assetCode: leg.tgtAsset }],
      }, `house-pay-${leg.conversionId}`);
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof ConflictException) throw new HouseRejected('INSUFFICIENT_INVENTORY');
      throw e;
    }
    const t = await this.transfers.move({ fromOrganisationId: houseOrg, toOrganisationId: leg.organisationId, assetCode: leg.tgtAsset, amount: leg.target, reference: `out-${leg.conversionId}` });
    if (t.status !== 'completed') {
      await this.ledger.postJournal(houseOrg, {
        reference: `house-unpay:${leg.conversionId}`, description: `Reverse house payout ${leg.target} ${leg.tgtAsset}`,
        lines: [{ accountId: a.custody.id, direction: 'debit', amount: leg.target, assetCode: leg.tgtAsset }, { accountId: a.trading.id, direction: 'credit', amount: leg.target, assetCode: leg.tgtAsset }],
      }, `house-unpay-${leg.conversionId}`);
      throw new HouseRejected(t.reason ?? 'TRANSFER_REJECTED');
    }
  }

  /** Send the net residual to the external provider and book the house legs at the EXECUTED amounts when reported. */
  async hedge(houseOrg: string, batchId: string, h: { action: 'buy_base' | 'sell_base'; base: string; quote: string; baseAmount: string; quoteEstimate: string }): Promise<LiquidityOrderResult> {
    const buy = h.action === 'buy_base';
    const res = await this.liquidity.execute({
      organisationId: houseOrg, clientReference: batchId, quoteId: batchId,
      sourceAsset: buy ? h.quote : h.base, targetAsset: buy ? h.base : h.quote,
      sourceAmount: buy ? h.quoteEstimate : h.baseAmount, targetAmount: buy ? h.baseAmount : h.quoteEstimate,
    });
    if (res.status === 'filled') await this.bookHedge(houseOrg, batchId, h, res);
    return res;
  }

  /** Idempotent: also used when a stalled batch learns from the provider that the hedge DID fill. */
  async bookHedge(houseOrg: string, batchId: string, h: { action: 'buy_base' | 'sell_base'; base: string; quote: string; baseAmount: string; quoteEstimate: string }, res: LiquidityOrderResult) {
    const buy = h.action === 'buy_base';
    const ex = (res as { executed?: { paidAmount?: string; receivedAmount?: string } }).executed;
    // Adapters report executed quantity (base) and total (quote value) in receivedAmount/paidAmount respectively.
    const baseAmt = ex?.receivedAmount ?? h.baseAmount;
    const quoteAmt = ex?.paidAmount ?? h.quoteEstimate;
    const b = await this.house.accounts(houseOrg, h.base); const q = await this.house.accounts(houseOrg, h.quote);
    await this.ledger.postJournal(houseOrg, {
      reference: `house-hedge:${batchId}`, description: `Hedge ${h.action} ${baseAmt} ${h.base} (${h.quote} ${quoteAmt})`,
      lines: buy
        ? [
            { accountId: b.custody.id, direction: 'debit', amount: baseAmt, assetCode: h.base }, { accountId: b.trading.id, direction: 'credit', amount: baseAmt, assetCode: h.base },
            { accountId: q.trading.id, direction: 'debit', amount: quoteAmt, assetCode: h.quote }, { accountId: q.custody.id, direction: 'credit', amount: quoteAmt, assetCode: h.quote },
          ]
        : [
            { accountId: b.trading.id, direction: 'debit', amount: baseAmt, assetCode: h.base }, { accountId: b.custody.id, direction: 'credit', amount: baseAmt, assetCode: h.base },
            { accountId: q.custody.id, direction: 'debit', amount: quoteAmt, assetCode: h.quote }, { accountId: q.trading.id, direction: 'credit', amount: quoteAmt, assetCode: h.quote },
          ],
    }, `house-hedge-${batchId}`);
  }

  async lookupHedge(houseOrg: string, batchId: string) { return this.liquidity.getOrder(houseOrg, batchId); }
}
