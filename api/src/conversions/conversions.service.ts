import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service';
import { cmp, sub } from '@durin/ledger';
import { computeQuote } from './fx.sandbox';
import { buildConversionLines } from './journal-lines';
import { assertPositiveAmount } from '../common/money';
import { assertSandboxOnly } from '../common/sandbox';

@Injectable()
export class ConversionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookDeliveryService,
  ) {}

  async createQuote(
    organisationId: string,
    sourceAsset: string,
    targetAsset: string,
    sourceAmount: string,
  ) {
    assertSandboxOnly('Currency conversion quotes');
    if (sourceAsset.toUpperCase() === targetAsset.toUpperCase()) {
      throw new BadRequestException('sourceAsset and targetAsset must differ');
    }
    assertPositiveAmount(sourceAmount, sourceAsset);

    let computed;
    try {
      computed = computeQuote(sourceAsset, targetAsset, sourceAmount);
    } catch (e: unknown) {
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
        metadata: { provider: 'sandbox', feeBps: computed.feeBps },
      },
    });

    return this.serializeQuote(quote);
  }

  async getQuote(organisationId: string, id: string) {
    const quote = await this.prisma.quote.findFirst({
      where: { id, organisationId },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    return this.serializeQuote(quote);
  }

  /**
   * Accept quote and run sandbox conversion to settlement.
   * Posts a multi-line journal moving source → target (and fee).
   * Status: simulated rates + immediate settle in sandbox.
   */
  async createConversion(
    organisationId: string,
    quoteId: string,
    idempotencyKey?: string,
  ) {
    assertSandboxOnly('Currency conversion');

    if (idempotencyKey) {
      const existing = await this.prisma.conversion.findUnique({
        where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
      });
      if (existing) return this.serializeConversion(existing);
    }

    if (!/^[0-9a-f-]{36}$/i.test(quoteId)) throw new NotFoundException('Quote not found');
    const quote = await this.prisma.quote.findFirst({ where: { id: quoteId, organisationId } });
    if (!quote) throw new NotFoundException('Quote not found');
    if (quote.status !== 'open') {
      throw new BadRequestException(`Quote is ${quote.status}, not open`);
    }
    if (quote.expiresAt < new Date()) {
      await this.prisma.quote.updateMany({
        where: { id: quote.id, status: 'open' },
        data: { status: 'expired' },
      });
      throw new BadRequestException('Quote has expired');
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

    const sourceAsset = quote.sourceAsset;
    const targetAsset = quote.targetAsset;
    const sourceAmount = quote.sourceAmount.toFixed();
    const targetAmount = quote.targetAmount.toFixed();
    const feeAmount = quote.feeAmount.toFixed();

    let journal;
    try {
      const sourceAccounts = await this.ensurePair(organisationId, sourceAsset);
      const targetAccounts = await this.ensurePair(organisationId, targetAsset);
      const feeAccount = await this.ensureRevenueAccount(organisationId, sourceAsset);

      // Balanced per asset: source legs net to zero, target legs net to zero.
      // SANDBOX ACCOUNTING ONLY (see journal-lines.ts).
      const lines = buildConversionLines({
        sourceAsset,
        targetAsset,
        sourceAmount,
        targetAmount,
        feeAmount,
        sourceLiabilityId: sourceAccounts.liability.id,
        sourceAssetId: sourceAccounts.asset.id,
        targetLiabilityId: targetAccounts.liability.id,
        targetAssetId: targetAccounts.asset.id,
        feeRevenueId: feeAccount.id,
      });

      await this.ensureSandboxLiquidity(organisationId, sourceAccounts, sourceAmount, sourceAsset, quote.id);

      // The journal is keyed on the quote, so one quote can never be posted twice.
      journal = await this.ledger.postJournal(
        organisationId,
        {
          reference: `conversion:quote:${quote.id}`,
          description: `Convert ${sourceAmount} ${sourceAsset} → ${targetAmount} ${targetAsset}`,
          lines,
        },
        `conv-j-${quote.id}`,
      );
    } catch (e: unknown) {
      await releaseQuote();
      // Business rejections (insufficient funds, bad accounts) are recorded as a failed
      // conversion. Unexpected errors propagate; internal details are never echoed to clients.
      if (e instanceof BadRequestException || e instanceof ConflictException) {
        const response = e.getResponse();
        const reason =
          typeof response === 'object' && response && 'code' in response ? String((response as { code: unknown }).code) : 'LEDGER_REJECTED';
        const failed = await this.prisma.conversion.create({
          data: {
            organisationId,
            quoteId: quote.id,
            sourceAsset,
            targetAsset,
            sourceAmount: quote.sourceAmount,
            targetAmount: quote.targetAmount,
            rate: quote.rate,
            feeAmount: quote.feeAmount,
            status: 'failed',
            failureReason: reason,
            idempotencyKey,
          },
        });
        const serialized = this.serializeConversion(failed);
        await this.webhooks.publish(organisationId, 'conversion.failed', serialized);
        return serialized;
      }
      throw e;
    }

    const conversion = await this.prisma.conversion.create({
      data: {
        organisationId,
        quoteId: quote.id,
        sourceAsset,
        targetAsset,
        sourceAmount: quote.sourceAmount,
        targetAmount: quote.targetAmount,
        rate: quote.rate,
        feeAmount: quote.feeAmount,
        status: 'settled',
        journalId: journal.id,
        idempotencyKey,
        settledAt: new Date(),
      },
    });

    await this.webhooks.publish(organisationId, 'conversion.settled', this.serializeConversion(conversion));

    return {
      ...this.serializeConversion(conversion),
      journal,
      mode: 'sandbox' as const,
      note: 'Sandbox conversion settled immediately with simulated FX. Not a live market rate or regulated conversion.',
    };
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

  private async ensurePair(organisationId: string, assetCode: string) {
    const code = assetCode.toUpperCase();
    const asset = await this.ledger.ensureAccount(organisationId, {
      code: `SETTLEMENT-ASSET-${code}`,
      name: `Settlement asset ${code}`,
      accountType: 'asset',
      assetCode: code,
    });
    const liability = await this.ledger.ensureAccount(organisationId, {
      code: `SETTLEMENT-LIAB-${code}`,
      name: `Customer liability ${code}`,
      accountType: 'liability',
      assetCode: code,
    });
    return { asset, liability };
  }

  private async ensureRevenueAccount(organisationId: string, assetCode: string) {
    const code = assetCode.toUpperCase();
    return this.ledger.ensureAccount(organisationId, {
      code: `FEE-REVENUE-${code}`,
      name: `Fee revenue ${code}`,
      accountType: 'revenue',
      assetCode: code,
    });
  }

  /**
   * SANDBOX ONLY. If the customer liability is short, post an opening deposit for exactly the
   * shortfall so conversion demos work without a prior payment. This creates balances from
   * nothing, so it is refused outside sandbox mode (see common/sandbox.ts).
   */
  private async ensureSandboxLiquidity(
    organisationId: string,
    accounts: { asset: { id: string }; liability: { id: string } },
    required: string,
    assetCode: string,
    quoteId: string,
  ) {
    assertSandboxOnly('Sandbox pre-funding');
    const balance = await this.prisma.balance.findUnique({
      where: { accountId: accounts.liability.id },
    });
    const available = balance ? balance.available.toFixed() : '0';
    if (cmp(available, required) >= 0) return;

    const shortfall = sub(required, available);
    await this.ledger.postJournal(
      organisationId,
      {
        reference: 'sandbox-prefund',
        description: `Sandbox pre-fund ${shortfall} ${assetCode}`,
        lines: [
          { accountId: accounts.asset.id, direction: 'debit', amount: shortfall, assetCode },
          { accountId: accounts.liability.id, direction: 'credit', amount: shortfall, assetCode },
        ],
      },
      `sandbox-prefund-${quoteId}`,
    );
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
      mode: 'sandbox' as const,
      note: 'Simulated FX rate — not a live market quote.',
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
      failureReason: c.failureReason,
      settledAt: c.settledAt,
      createdAt: c.createdAt,
      mode: 'sandbox' as const,
    };
  }
}
