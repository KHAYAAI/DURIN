import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { computeQuote } from './fx.sandbox';
import { buildConversionLines } from './journal-lines';

@Injectable()
export class ConversionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async createQuote(
    organisationId: string,
    sourceAsset: string,
    targetAsset: string,
    sourceAmount: string,
  ) {
    if (sourceAsset.toUpperCase() === targetAsset.toUpperCase()) {
      throw new BadRequestException('sourceAsset and targetAsset must differ');
    }

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
        metadata: { provider: 'sandbox', feeBps: 30 },
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
    if (idempotencyKey) {
      const existing = await this.prisma.conversion.findUnique({
        where: {
          organisationId_idempotencyKey: { organisationId, idempotencyKey },
        },
      });
      if (existing) return this.serializeConversion(existing);
    }

    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, organisationId },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    if (quote.status !== 'open') {
      throw new BadRequestException(`Quote is ${quote.status}, not open`);
    }
    if (quote.expiresAt < new Date()) {
      await this.prisma.quote.update({
        where: { id: quote.id },
        data: { status: 'expired' },
      });
      throw new BadRequestException('Quote has expired');
    }

    const sourceAsset = quote.sourceAsset;
    const targetAsset = quote.targetAsset;
    const sourceAmount = quote.sourceAmount.toFixed();
    const targetAmount = quote.targetAmount.toFixed();
    const feeAmount = quote.feeAmount.toFixed();

    // Settlement accounts for both assets
    const sourceAccounts = await this.ensurePair(organisationId, sourceAsset);
    const targetAccounts = await this.ensurePair(organisationId, targetAsset);

    // Fee account (revenue) in source asset
    const feeAccount = await this.ensureRevenueAccount(organisationId, sourceAsset);

    // Build balanced multi-asset journal:
    // 1) Reduce customer liability in source (debit liability) + reduce settlement asset source (credit asset)
    // 2) Increase settlement asset target (debit asset) + increase customer liability target (credit liability)
    // 3) Fee: debit customer liability source + credit fee revenue
    //
    // Simplified sandbox economic view:
    // - Debit source liability (customer spends source)
    // - Credit source asset (platform source inventory down) — skip if we model pure liability swap
    // For sandbox clarity we do:
    //   DR customer liability SOURCE (sourceAmount)
    //   CR settlement asset SOURCE (sourceAmount - fee) 
    //   CR fee revenue SOURCE (fee)
    //   DR settlement asset TARGET (targetAmount)
    //   CR customer liability TARGET (targetAmount)
    //
    // That requires source legs balanced and target legs balanced separately — validateJournalInput checks per asset.

    const adjustedLines = buildConversionLines({
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

    // Pre-fund sandbox: ensure source liability has enough available
    await this.ensureSandboxLiquidity(
      organisationId,
      sourceAccounts,
      sourceAmount,
      sourceAsset,
    );

    let journal;
    try {
      journal = await this.ledger.postJournal(
        organisationId,
        {
          reference: `conversion:quote:${quote.id}`,
          description: `Convert ${sourceAmount} ${sourceAsset} → ${targetAmount} ${targetAsset}`,
          lines: adjustedLines,
        },
        idempotencyKey ? `conv-j-${idempotencyKey}` : `conv-j-${quote.id}`,
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Ledger post failed';
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
          failureReason: message,
          idempotencyKey,
        },
      });
      return this.serializeConversion(failed);
    }

    const [conversion] = await this.prisma.$transaction([
      this.prisma.conversion.create({
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
      }),
      this.prisma.quote.update({
        where: { id: quote.id },
        data: { status: 'accepted' },
      }),
    ]);

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
    const assetCodeUp = assetCode.toUpperCase();
    const assetKey = `SETTLEMENT-ASSET-${assetCodeUp}`;
    const liabKey = `SETTLEMENT-LIAB-${assetCodeUp}`;

    let asset = await this.prisma.ledgerAccount.findUnique({
      where: { organisationId_code: { organisationId, code: assetKey } },
    });
    if (!asset) {
      const created = await this.ledger.createAccount(organisationId, {
        code: assetKey,
        name: `Settlement asset ${assetCodeUp}`,
        accountType: 'asset',
        assetCode: assetCodeUp,
      });
      asset = await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: created.id } });
    }

    let liability = await this.prisma.ledgerAccount.findUnique({
      where: { organisationId_code: { organisationId, code: liabKey } },
    });
    if (!liability) {
      const created = await this.ledger.createAccount(organisationId, {
        code: liabKey,
        name: `Customer liability ${assetCodeUp}`,
        accountType: 'liability',
        assetCode: assetCodeUp,
      });
      liability = await this.prisma.ledgerAccount.findUniqueOrThrow({
        where: { id: created.id },
      });
    }

    return { asset, liability };
  }

  private async ensureRevenueAccount(organisationId: string, assetCode: string) {
    const code = `FEE-REVENUE-${assetCode.toUpperCase()}`;
    let acc = await this.prisma.ledgerAccount.findUnique({
      where: { organisationId_code: { organisationId, code } },
    });
    if (!acc) {
      const created = await this.ledger.createAccount(organisationId, {
        code,
        name: `Fee revenue ${assetCode.toUpperCase()}`,
        accountType: 'revenue',
        assetCode: assetCode.toUpperCase(),
      });
      acc = await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: created.id } });
    }
    return acc;
  }

  /**
   * Sandbox helper: if customer liability available is insufficient, post an opening
   * deposit so conversion demos work without a prior payment_intent settle.
   */
  private async ensureSandboxLiquidity(
    organisationId: string,
    accounts: { asset: { id: string }; liability: { id: string } },
    required: string,
    assetCode: string,
  ) {
    const balance = await this.prisma.balance.findUnique({
      where: { accountId: accounts.liability.id },
    });
    const available = balance ? balance.available.toFixed() : '0';
    if (Number(available) >= Number(required)) return;

    const topUp = (Number(required) - Number(available) + 1).toFixed(2);
    await this.ledger.postJournal(
      organisationId,
      {
        reference: 'sandbox-prefund',
        description: `Sandbox pre-fund ${topUp} ${assetCode}`,
        lines: [
          {
            accountId: accounts.asset.id,
            direction: 'debit',
            amount: topUp,
            assetCode,
          },
          {
            accountId: accounts.liability.id,
            direction: 'credit',
            amount: topUp,
            assetCode,
          },
        ],
      },
      `sandbox-prefund-${accounts.liability.id}-${Date.now()}`,
    );
  }

  private subDecimal(a: string, b: string): string {
    const result = Number(a) - Number(b);
    if (result < 0) throw new BadRequestException('Invalid fee relative to source amount');
    return result.toFixed(8).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
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
