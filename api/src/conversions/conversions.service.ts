import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service';
import { cmp, sub } from '@durin/ledger';
import { computeQuote } from './fx.sandbox';
import { ConversionAccounts, fillLines, releaseLines, reserveLines, settleLines } from './journal-lines';
import { assertPositiveAmount } from '../common/money';
import { assertSandboxOnly, isSandboxMode } from '../common/sandbox';
import { assertConversionAllowed } from './live-gate';
import { HouseService } from '../house/house.service';
import { HouseExecutor, HouseRejected } from '../house/house-executor.service';
import { LIQUIDITY_PORT } from '../providers/liquidity/liquidity.module';
import { LiquidityPort } from '../providers/liquidity/liquidity.port';
import { GatesService } from '../compliance/gates.service';
import { ComplianceService } from '../compliance/compliance.service';
import { sandboxCustody } from '../providers/sandbox-custody';
import {
  ensureCustodyRef,
  ensureCustomer,
  ensureFeeRevenue,
  ensureInTransit,
  ensureLpClearing,
} from '../ledger/chart';

export type ConversionRow = Prisma.ConversionGetPayload<object>;

/**
 * Conversion state machine (custody-reference ledger, see journal-lines.ts):
 *
 *   accepted ─ reserve journal ─▶ processing ─ LP call (intent logged first) ─┬─ filled ─▶ fill journal ─▶ settle journal ─▶ settled
 *                                                                             ├─ rejected ─▶ release journal ─▶ failed
 *                                                                             └─ threw / timed out ─▶ processing + providerUnknown
 *
 * An unknown LP outcome keeps the customer's funds reserved and is NEVER retried or reversed
 * automatically: it is resolved only by asking the provider (`resolve`) or by an operator
 * recording that the provider confirmed the order was not executed.
 */
@Injectable()
export class ConversionsService {
  private readonly log = new Logger(ConversionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookDeliveryService,
    private readonly compliance: ComplianceService,
    private readonly gates: GatesService,
    @Inject(LIQUIDITY_PORT) private readonly liquidity: LiquidityPort,
    private readonly house: HouseService,
    private readonly houseExec: HouseExecutor,
  ) {}

  private nettingResolver?: { resolveBatch(batchId: string): Promise<void> };
  registerNettingResolver(r: { resolveBatch(batchId: string): Promise<void> }) { this.nettingResolver = r; }

  async createQuote(
    organisationId: string,
    sourceAsset: string,
    targetAsset: string,
    sourceAmount: string,
  ) {
    assertConversionAllowed(this.liquidity.mode);
    if (sourceAsset.toUpperCase() === targetAsset.toUpperCase()) {
      throw new BadRequestException('sourceAsset and targetAsset must differ');
    }
    assertPositiveAmount(sourceAmount, sourceAsset);

    let computed: {
      sourceAsset: string; targetAsset: string; sourceAmount: string; targetAmount: string;
      rate: string; feeAmount: string; feeAsset: string; expiresInSeconds: number; feeBps?: number; providerQuoteId?: string;
    };
    try {
      if (this.liquidity.mode === 'live') {
        if (!this.liquidity.getQuote) throw new Error('Liquidity adapter cannot quote');
        await this.compliance.assertOrganisationVerified(organisationId);
        await this.gates.assertG1(organisationId, [sourceAsset, targetAsset]);
        const q = await this.liquidity.getQuote({ sourceAsset, targetAsset, sourceAmount });
        computed = { ...q, sourceAsset: sourceAsset.toUpperCase(), targetAsset: targetAsset.toUpperCase(), sourceAmount };
      } else {
        computed = computeQuote(sourceAsset, targetAsset, sourceAmount);
      }
    } catch (e: unknown) {
      if (e instanceof ForbiddenException) throw e;
      throw new BadRequestException(e instanceof Error ? e.message : 'Invalid quote request');
    }

    const expiresAt = new Date(Date.now() + computed.expiresInSeconds * 1000);

    const quote = await this.prisma.quote.create({
      data: {
        organisationId,
        sourceAsset: computed.sourceAsset,
        targetAsset: computed.targetAsset,
        sourceAmount: new Prisma.Decimal(computed.sourceAmount),
        targetAmount: new Prisma.Decimal(computed.targetAmount),
        rate: new Prisma.Decimal(computed.rate),
        feeAmount: new Prisma.Decimal(computed.feeAmount),
        feeAsset: computed.feeAsset,
        status: 'open',
        expiresAt,
        metadata: { provider: this.liquidity.name, feeBps: computed.feeBps ?? null, providerQuoteId: computed.providerQuoteId ?? null },
      },
    });

    return this.serializeQuote(quote);
  }

  async getQuote(organisationId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Quote not found');
    const quote = await this.prisma.quote.findFirst({ where: { id, organisationId } });
    if (!quote) throw new NotFoundException('Quote not found');
    return this.serializeQuote(quote);
  }

  /** Accept a quote and run the conversion. Returns the conversion in whatever state it reached. */
  async createConversion(organisationId: string, quoteId: string, idempotencyKey?: string) {
    assertConversionAllowed(this.liquidity.mode);

    if (idempotencyKey) {
      const existing = await this.prisma.conversion.findUnique({
        where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
      });
      if (existing) return this.serializeConversion(existing);
    }

    if (!/^[0-9a-f-]{36}$/i.test(quoteId)) throw new NotFoundException('Quote not found');
    const quote = await this.prisma.quote.findFirst({ where: { id: quoteId, organisationId } });
    if (!quote) throw new NotFoundException('Quote not found');
    if (quote.status !== 'open') throw new BadRequestException(`Quote is ${quote.status}, not open`);
    if (quote.expiresAt < new Date()) {
      await this.prisma.quote.updateMany({ where: { id: quote.id, status: 'open' }, data: { status: 'expired' } });
      throw new BadRequestException('Quote has expired');
    }
    if (this.liquidity.mode === 'live') {
      await this.compliance.assertOrganisationVerified(organisationId);
      await this.gates.assertG1(organisationId, [quote.sourceAsset, quote.targetAsset]);
    }

    // Atomically claim the quote: of any number of concurrent accepts, exactly one proceeds.
    const claimed = await this.prisma.quote.updateMany({
      where: { id: quote.id, organisationId, status: 'open', expiresAt: { gt: new Date() } },
      data: { status: 'accepted' },
    });
    if (claimed.count !== 1) {
      if (idempotencyKey) {
        const existing = await this.prisma.conversion.findUnique({
          where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
        });
        if (existing) return this.serializeConversion(existing);
      }
      throw new ConflictException('Quote is no longer open');
    }
    const releaseQuote = () =>
      this.prisma.quote.updateMany({
        where: { id: quote.id, status: 'accepted', expiresAt: { gt: new Date() } },
        data: { status: 'open' },
      });

    // 1. Persist the conversion BEFORE any money moves or any provider is called.
    let conv: ConversionRow;
    try {
      conv = await this.prisma.conversion.create({
        data: {
          organisationId,
          quoteId: quote.id,
          sourceAsset: quote.sourceAsset,
          targetAsset: quote.targetAsset,
          sourceAmount: quote.sourceAmount,
          targetAmount: quote.targetAmount,
          rate: quote.rate,
          feeAmount: quote.feeAmount,
          status: 'processing',
          idempotencyKey,
        },
      });
    } catch (e) {
      await releaseQuote();
      throw e;
    }

    const accounts = await this.accountsFor(organisationId, conv.sourceAsset, conv.targetAsset);
    const src = conv.sourceAsset;
    const amounts = {
      source: conv.sourceAmount.toFixed(),
      fee: conv.feeAmount.toFixed(),
      target: conv.targetAmount.toFixed(),
    };

    // 2. Reserve the customer's source funds.
    try {
      if (isSandboxMode()) await this.ensureSandboxFunds(organisationId, accounts, amounts.source, src, conv.id);
      const reserve = await this.ledger.postJournal(
        organisationId,
        { reference: `conversion:${conv.id}:reserve`, description: `Reserve ${amounts.source} ${src} for conversion`, lines: reserveLines(accounts, src, amounts.source) },
        `conv-reserve-${conv.id}`,
      );
      conv = await this.prisma.conversion.update({ where: { id: conv.id }, data: { reserveJournalId: reserve.id } });
    } catch (e: unknown) {
      if (e instanceof BadRequestException || e instanceof ConflictException) {
        await releaseQuote();
        return this.serializeConversion(await this.markFailed(conv, this.reasonOf(e)));
      }
      await releaseQuote();
      throw e;
    }

    // 3. Route: own inventory / internal netting when gated open, otherwise the external provider.
    const netSource = sub(amounts.source, amounts.fee);
    const route = await this.house.routeFor({ sourceAsset: src, targetAsset: conv.targetAsset, netSource, target: amounts.target });
    if (route === 'house') return this.serializeConversion(await this.executeViaHouse(conv, accounts));
    if (route === 'netted') {
      const windowMs = Math.max(1, Number(process.env.NETTING_WINDOW_SECONDS ?? 5)) * 1000;
      return this.serializeConversion(await this.prisma.conversion.update({ where: { id: conv.id }, data: { executionMode: 'netted', matchingUntil: new Date(Date.now() + windowMs) } }));
    }
    // Intent-before-send, then the (single) provider call.
    return this.executeWithProvider(conv, accounts);
  }

  /** Resolve a conversion whose LP outcome is unknown by asking the provider. Never re-sends the order. */
  async resolve(organisationId: string, id: string, manual?: 'not_executed') {
    const conv = await this.requireConversion(organisationId, id);
    if (!conv.providerUnknown || conv.status !== 'processing') {
      throw new BadRequestException('Conversion has no unknown provider outcome to resolve');
    }
    if (conv.executionMode === 'house') return this.serializeConversion(await this.executeViaHouse(conv));
    if (conv.executionMode === 'netted' && conv.nettingBatchId && this.nettingResolver) {
      await this.nettingResolver.resolveBatch(conv.nettingBatchId);
      return this.serializeConversion(await this.prisma.conversion.findUniqueOrThrow({ where: { id: conv.id } }));
    }
    const accounts = await this.accountsFor(organisationId, conv.sourceAsset, conv.targetAsset);
    const lookup = await this.liquidity.getOrder(organisationId, conv.id);

    if (lookup.status === 'filled') {
      await this.markCall(conv, 'succeeded', 'resolved: filled');
      return this.serializeConversion(await this.completeFill(conv, accounts, lookup.providerRef));
    }
    if (lookup.status === 'rejected') {
      await this.markCall(conv, 'failed', `resolved: ${lookup.reason ?? 'rejected'}`);
      return this.serializeConversion(await this.releaseAndFail(conv, accounts, lookup.reason ?? 'LP_REJECTED'));
    }
    if (manual === 'not_executed' && lookup.status === 'not_found') {
      // A provider may not list a just-submitted order yet. Releasing funds too early could let a
      // late fill double-spend them, so require a cooling-off period since the call was sent.
      const minAgeMs = Number(process.env.RESOLVE_NOT_EXECUTED_MIN_AGE_MINUTES ?? 15) * 60_000;
      const call = await this.prisma.providerCall.findFirst({ where: { provider: this.liquidity.name, operation: 'liquidity.execute', clientReference: conv.id } });
      if (!call || Date.now() - call.createdAt.getTime() < minAgeMs) {
        throw new ForbiddenException({ code: 'COOLING_OFF', message: `Not-executed confirmation is only accepted ${minAgeMs / 60_000} minutes after the order was sent.` });
      }
      // Operator asserts (after checking with the provider) that the order never executed.
      await this.markCall(conv, 'failed', 'operator: confirmed not executed');
      return this.serializeConversion(await this.releaseAndFail(conv, accounts, 'LP_NOT_EXECUTED'));
    }
    return { ...this.serializeConversion(conv), providerStatus: lookup.status };
  }

  /** Conversions stuck with an unknown provider outcome, for the reconciliation worker / operators. */
  async listUnresolved(organisationId: string) {
    const rows = await this.prisma.conversion.findMany({
      where: { organisationId, status: 'processing', providerUnknown: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => this.serializeConversion(c));
  }

  private async executeWithProvider(conv: ConversionRow, accounts: ConversionAccounts) {
    const organisationId = conv.organisationId;
    try {
      await this.prisma.providerCall.create({
        data: {
          organisationId, provider: this.liquidity.name, operation: 'liquidity.execute',
          entityType: 'conversion', entityId: conv.id, clientReference: conv.id, status: 'sent',
        },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      // A call row already exists: this conversion was already sent. Never send twice.
      return this.serializeConversion(await this.flagUnknown(conv, 'duplicate send prevented'));
    }

    let result;
    try {
      result = await this.liquidity.execute({
        organisationId, clientReference: conv.id, quoteId: conv.quoteId,
        sourceAsset: conv.sourceAsset, targetAsset: conv.targetAsset,
        sourceAmount: sub(conv.sourceAmount.toFixed(), conv.feeAmount.toFixed()),
        targetAmount: conv.targetAmount.toFixed(),
      });
    } catch (e: unknown) {
      // Timeout / transport failure: the order may or may not have executed.
      this.log.error(`Liquidity call for conversion ${conv.id} has an UNKNOWN outcome: ${e instanceof Error ? e.message : 'error'}`);
      return this.serializeConversion(await this.flagUnknown(conv, e instanceof Error ? e.message : 'unknown'));
    }

    if (result.status === 'rejected') {
      await this.markCall(conv, 'failed', result.reason ?? 'rejected');
      return this.serializeConversion(await this.releaseAndFail(conv, accounts, result.reason ?? 'LP_REJECTED'));
    }
    await this.markCall(conv, 'succeeded', 'filled');
    return this.serializeConversion(await this.completeFill(conv, accounts, result.providerRef));
  }

  /** LP filled: credit the customer's target (on delivery) and record settlement. Idempotent per conversion. */
  private async completeFill(conv: ConversionRow, accounts: ConversionAccounts, providerRef?: string): Promise<ConversionRow> {
    const organisationId = conv.organisationId;
    const p = {
      sourceAsset: conv.sourceAsset, targetAsset: conv.targetAsset,
      source: conv.sourceAmount.toFixed(), fee: conv.feeAmount.toFixed(), target: conv.targetAmount.toFixed(),
    };
    const fill = await this.ledger.postJournal(
      organisationId,
      { reference: `conversion:${conv.id}:fill`, description: `Fill ${p.source} ${p.sourceAsset} → ${p.target} ${p.targetAsset}`, lines: fillLines(accounts, p) },
      `conv-fill-${conv.id}`,
    );
    const settle = await this.ledger.postJournal(
      organisationId,
      { reference: `conversion:${conv.id}:settle`, description: `Settle conversion ${conv.id} at custodians`, lines: settleLines(accounts, p) },
      `conv-settle-${conv.id}`,
    );
    const done = await this.prisma.conversion.update({
      where: { id: conv.id },
      data: {
        status: 'settled', providerUnknown: false, providerRef: providerRef ?? conv.providerRef,
        journalId: fill.id, fillJournalId: fill.id, settleJournalId: settle.id, settledAt: new Date(),
      },
    });
    await this.prisma.quote.updateMany({ where: { id: conv.quoteId }, data: { status: 'accepted' } });
    await this.webhooks.publish(organisationId, 'conversion.settled', this.serializeConversion(done));
    return done;
  }

  private async releaseAndFail(conv: ConversionRow, accounts: ConversionAccounts, reason: string): Promise<ConversionRow> {
    await this.ledger.postJournal(
      conv.organisationId,
      { reference: `conversion:${conv.id}:release`, description: `Release reserved ${conv.sourceAmount.toFixed()} ${conv.sourceAsset}`, lines: releaseLines(accounts, conv.sourceAsset, conv.sourceAmount.toFixed()) },
      `conv-release-${conv.id}`,
    );
    return this.markFailed(conv, reason);
  }

  private async markFailed(conv: ConversionRow, reason: string): Promise<ConversionRow> {
    const failed = await this.prisma.conversion.update({
      where: { id: conv.id },
      data: { status: 'failed', failureReason: reason, providerUnknown: false },
    });
    await this.webhooks.publish(conv.organisationId, 'conversion.failed', this.serializeConversion(failed));
    return failed;
  }

  private async flagUnknown(conv: ConversionRow, detail: string): Promise<ConversionRow> {
    await this.markCall(conv, 'unknown', detail);
    return this.prisma.conversion.update({ where: { id: conv.id }, data: { providerUnknown: true } });
  }

  private async markCall(conv: ConversionRow, status: 'succeeded' | 'failed' | 'unknown', detail: string) {
    await this.prisma.providerCall.updateMany({
      where: { provider: this.liquidity.name, operation: 'liquidity.execute', clientReference: conv.id },
      data: { status, detail: detail.slice(0, 500), completedAt: status === 'unknown' ? null : new Date() },
    });
  }

  private reasonOf(e: BadRequestException | ConflictException): string {
    const response = e.getResponse();
    return typeof response === 'object' && response && 'code' in response ? String((response as { code: unknown }).code) : 'LEDGER_REJECTED';
  }

  private async requireConversion(organisationId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Conversion not found');
    const c = await this.prisma.conversion.findFirst({ where: { id, organisationId } });
    if (!c) throw new NotFoundException('Conversion not found');
    return c;
  }

  private async accountsFor(organisationId: string, sourceAsset: string, targetAsset: string): Promise<ConversionAccounts> {
    const [srcCustomer, srcInTransit, srcLp, srcFee, srcCustody, tgtCustomer, tgtLp, tgtCustody] = await Promise.all([
      ensureCustomer(this.ledger, organisationId, sourceAsset),
      ensureInTransit(this.ledger, organisationId, sourceAsset),
      ensureLpClearing(this.ledger, organisationId, sourceAsset),
      ensureFeeRevenue(this.ledger, organisationId, sourceAsset),
      ensureCustodyRef(this.ledger, organisationId, sourceAsset),
      ensureCustomer(this.ledger, organisationId, targetAsset),
      ensureLpClearing(this.ledger, organisationId, targetAsset),
      ensureCustodyRef(this.ledger, organisationId, targetAsset),
    ]);
    return {
      srcCustomer: srcCustomer.id, srcInTransit: srcInTransit.id, srcLp: srcLp.id, srcFee: srcFee.id, srcCustody: srcCustody.id,
      tgtCustomer: tgtCustomer.id, tgtLp: tgtLp.id, tgtCustody: tgtCustody.id,
    };
  }

  /**
   * SANDBOX ONLY. If the customer balance is short, post an opening deposit for exactly the
   * shortfall (mirrored in the simulated custodian) so demos work without a prior payment.
   */
  private async ensureSandboxFunds(organisationId: string, accounts: ConversionAccounts, required: string, assetCode: string, conversionId: string) {
    assertSandboxOnly('Sandbox pre-funding');
    const balance = await this.prisma.balance.findUnique({ where: { accountId: accounts.srcCustomer } });
    const available = balance ? balance.available.toFixed() : '0';
    if (cmp(available, required) >= 0) return;
    const shortfall = sub(required, available);
    await this.ledger.postJournal(
      organisationId,
      {
        reference: 'sandbox-prefund',
        description: `Sandbox pre-fund ${shortfall} ${assetCode}`,
        lines: [
          { accountId: accounts.srcCustody, direction: 'debit', amount: shortfall, assetCode },
          { accountId: accounts.srcCustomer, direction: 'credit', amount: shortfall, assetCode },
        ],
      },
      `sandbox-prefund-${conversionId}`,
    );
    sandboxCustody.creditOnce(`prefund-${conversionId}`, organisationId, assetCode, shortfall);
  }

  /** Fill from the house's own inventory (G3). Falls back to the provider if the house refuses before moving anything. */
  async executeViaHouse(conv: ConversionRow, accounts?: ConversionAccounts): Promise<ConversionRow> {
    const acc = accounts ?? (await this.accountsFor(conv.organisationId, conv.sourceAsset, conv.targetAsset));
    const houseOrg = await this.house.houseOrgId();
    if (!houseOrg) return this.fallbackToProvider(conv);
    const leg = { conversionId: conv.id, organisationId: conv.organisationId, srcAsset: conv.sourceAsset, tgtAsset: conv.targetAsset, net: sub(conv.sourceAmount.toFixed(), conv.feeAmount.toFixed()), target: conv.targetAmount.toFixed() };
    conv = await this.prisma.conversion.update({ where: { id: conv.id }, data: { executionMode: 'house', providerUnknown: false } });
    try {
      await this.houseExec.receive(houseOrg, leg);
      await this.houseExec.pay(houseOrg, leg);
    } catch (e) {
      if (e instanceof HouseRejected) {
        try { await this.houseExec.unreceive(houseOrg, leg); } catch { return this.flagHouseUnknown(conv); }
        return this.fallbackToProvider(conv);
      }
      this.log.error(`House fill for ${conv.id} has an UNKNOWN outcome: ${e instanceof Error ? e.message : e}`);
      return this.flagHouseUnknown(conv);
    }
    return this.completeFill(conv, acc, `house:${conv.id}`);
  }

  private flagHouseUnknown(conv: ConversionRow) { return this.prisma.conversion.update({ where: { id: conv.id }, data: { providerUnknown: true } }); }

  /** Used by the netting batch and the house path. */
  async finishFilled(conv: ConversionRow, providerRef: string): Promise<ConversionRow> {
    return this.completeFill(conv, await this.accountsFor(conv.organisationId, conv.sourceAsset, conv.targetAsset), providerRef);
  }
  async failConversion(conv: ConversionRow, reason: string): Promise<ConversionRow> {
    return this.releaseAndFail(conv, await this.accountsFor(conv.organisationId, conv.sourceAsset, conv.targetAsset), reason);
  }
  /** Send a conversion the house could not handle through the external provider. */
  async fallbackToProvider(conv: ConversionRow): Promise<ConversionRow> {
    const c = await this.prisma.conversion.update({ where: { id: conv.id }, data: { executionMode: 'provider', nettingBatchId: null, matchingUntil: null, providerUnknown: false } });
    const accounts = await this.accountsFor(c.organisationId, c.sourceAsset, c.targetAsset);
    await this.executeWithProvider(c, accounts);
    return this.prisma.conversion.findUniqueOrThrow({ where: { id: c.id } });
  }

  async getConversion(organisationId: string, id: string) {
    const c = await this.prisma.conversion.findFirst({
      where: { id, organisationId },
    });
    if (!c) throw new NotFoundException('Conversion not found');
    return this.serializeConversion(c);
  }

  async listConversions(organisationId: string, limit = 50) {
    const rows = await this.prisma.conversion.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return rows.map((c) => this.serializeConversion(c));
  }

  private serializeQuote(q: {
    id: string;
    organisationId: string;
    sourceAsset: string;
    targetAsset: string;
    sourceAmount: Prisma.Decimal;
    targetAmount: Prisma.Decimal;
    rate: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
    feeAsset: string;
    status: string;
    expiresAt: Date;
    createdAt: Date;
  }) {
    return {
      id: q.id,
      organisationId: q.organisationId,
      sourceAsset: q.sourceAsset,
      targetAsset: q.targetAsset,
      sourceAmount: q.sourceAmount.toFixed(),
      targetAmount: q.targetAmount.toFixed(),
      rate: q.rate.toFixed(),
      feeAmount: q.feeAmount.toFixed(),
      feeAsset: q.feeAsset,
      status: q.status,
      expiresAt: q.expiresAt,
      createdAt: q.createdAt,
      mode: this.liquidity.mode,
      ...(this.liquidity.mode === 'sandbox' ? { note: 'Simulated FX rate — not a live market quote.' } : {}),
    };
  }

  private serializeConversion(c: {
    id: string;
    organisationId: string;
    quoteId: string;
    sourceAsset: string;
    targetAsset: string;
    sourceAmount: Prisma.Decimal;
    targetAmount: Prisma.Decimal;
    rate: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
    status: string;
    journalId: string | null;
    providerUnknown: boolean;
    providerRef: string | null;
    executionMode: string;
    failureReason: string | null;
    settledAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: c.id,
      organisationId: c.organisationId,
      quoteId: c.quoteId,
      sourceAsset: c.sourceAsset,
      targetAsset: c.targetAsset,
      sourceAmount: c.sourceAmount.toFixed(),
      targetAmount: c.targetAmount.toFixed(),
      rate: c.rate.toFixed(),
      feeAmount: c.feeAmount.toFixed(),
      status: c.status,
      journalId: c.journalId,
      providerUnknown: c.providerUnknown,
      providerRef: c.providerRef,
      executionMode: c.executionMode,
      failureReason: c.failureReason,
      settledAt: c.settledAt,
      createdAt: c.createdAt,
      mode: this.liquidity.mode,
    };
  }
}
