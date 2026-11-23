import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service';

const SUPPORTED_ASSETS = new Set(['USDC', 'USDT', 'ZAR']);

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookDeliveryService,
  ) {}

  /**
   * Create a payment intent with simulated on-chain payment instructions.
   * Status: simulated (no real chain monitoring yet).
   */
  async createIntent(
    organisationId: string,
    data: {
      amount: string;
      assetCode: string;
      description?: string;
      customerReference?: string;
      metadata?: Record<string, unknown>;
    },
    idempotencyKey?: string,
  ) {
    const assetCode = data.assetCode.toUpperCase();
    if (!SUPPORTED_ASSETS.has(assetCode)) {
      throw new BadRequestException(`Unsupported asset: ${assetCode}. Sandbox supports USDC, USDT, ZAR.`);
    }
    if (parseFloat(data.amount) <= 0) {
      throw new BadRequestException('Amount must be positive');
    }

    if (idempotencyKey) {
      const existing = await this.prisma.paymentIntent.findUnique({
        where: {
          organisationId_idempotencyKey: { organisationId, idempotencyKey },
        },
      });
      if (existing) return this.serializeIntent(existing);
    }

    const instructions = this.simulatePaymentInstructions(assetCode, data.amount);

    try {
      const intent = await this.prisma.paymentIntent.create({
        data: {
          organisationId,
          amount: new Prisma.Decimal(data.amount),
          assetCode,
          status: 'pending',
          description: data.description,
          customerReference: data.customerReference,
          metadata: data.metadata as Prisma.InputJsonValue | undefined,
          paymentInstructions: instructions,
          idempotencyKey,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min
        },
      });
      return this.serializeIntent(intent);
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Idempotency key conflict');
      }
      throw e;
    }
  }

  async getIntent(organisationId: string, id: string) {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id, organisationId },
    });
    if (!intent) throw new NotFoundException('Payment intent not found');
    return this.serializeIntent(intent);
  }

  async listIntents(organisationId: string, limit = 50) {
    const intents = await this.prisma.paymentIntent.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return intents.map((i) => this.serializeIntent(i));
  }

  /**
   * Sandbox only: simulate that the customer paid on-chain.
   * Moves intent → confirmed → posts ledger entries → settled.
   */
  async simulateConfirm(organisationId: string, intentId: string) {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id: intentId, organisationId },
    });
    if (!intent) throw new NotFoundException('Payment intent not found');
    if (intent.status === 'settled' || intent.status === 'confirmed') {
      return this.serializeIntent(intent);
    }
    if (!['pending', 'requires_action', 'processing', 'created'].includes(intent.status)) {
      throw new BadRequestException(`Cannot confirm intent in status ${intent.status}`);
    }

    // Ensure org has settlement accounts for this asset
    const { assetAccount, liabilityAccount } = await this.ensureSettlementAccounts(
      organisationId,
      intent.assetCode,
    );

    const amount = intent.amount.toFixed();

    // Post journal: debit asset (we received funds), credit customer liability
    const journal = await this.ledger.postJournal(
      organisationId,
      {
        reference: `payment_intent:${intent.id}`,
        description: intent.description ?? `Payment ${intent.id}`,
        lines: [
          {
            accountId: assetAccount.id,
            direction: 'debit',
            amount,
            assetCode: intent.assetCode,
          },
          {
            accountId: liabilityAccount.id,
            direction: 'credit',
            amount,
            assetCode: intent.assetCode,
          },
        ],
      },
      `pi-settle-${intent.id}`,
    );

    const updated = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'settled',
        confirmedAt: new Date(),
        settledAt: new Date(),
        journalId: journal.id,
      },
    });

    await this.webhooks.publish(organisationId, 'payment_intent.settled', this.serializeIntent(updated));
    return {
      ...this.serializeIntent(updated),
      journal,
      simulation: true,
      note: 'Sandbox confirmation — no real chain settlement occurred.',
    };
  }

  async cancelIntent(organisationId: string, intentId: string) {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id: intentId, organisationId },
    });
    if (!intent) throw new NotFoundException('Payment intent not found');
    if (['settled', 'confirmed', 'cancelled'].includes(intent.status)) {
      throw new BadRequestException(`Cannot cancel intent in status ${intent.status}`);
    }
    const updated = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'cancelled' },
    });
    return this.serializeIntent(updated);
  }

  async createLink(
    organisationId: string,
    data: {
      amount?: string;
      assetCode?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const slug = randomBytes(12).toString('base64url');
    const link = await this.prisma.paymentLink.create({
      data: {
        organisationId,
        urlSlug: slug,
        amount: data.amount ? new Prisma.Decimal(data.amount) : null,
        assetCode: data.assetCode?.toUpperCase() ?? null,
        description: data.description,
        metadata: data.metadata as Prisma.InputJsonValue | undefined,
        active: true,
      },
    });
    return this.serializeLink(link);
  }

  async listLinks(organisationId: string) {
    const links = await this.prisma.paymentLink.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
    });
    return links.map((l) => this.serializeLink(l));
  }

  async getLink(organisationId: string, id: string) {
    const link = await this.prisma.paymentLink.findFirst({
      where: { id, organisationId },
    });
    if (!link) throw new NotFoundException('Payment link not found');
    return this.serializeLink(link);
  }

  /** Ensure platform settlement accounts exist for the asset (auto-provision in sandbox). */
  private async ensureSettlementAccounts(organisationId: string, assetCode: string) {
    const assetCodeUp = assetCode.toUpperCase();
    const assetCodeKey = `SETTLEMENT-ASSET-${assetCodeUp}`;
    const liabCodeKey = `SETTLEMENT-LIAB-${assetCodeUp}`;

    let assetAccount = await this.prisma.ledgerAccount.findUnique({
      where: {
        organisationId_code: { organisationId, code: assetCodeKey },
      },
    });
    if (!assetAccount) {
      const created = await this.ledger.createAccount(organisationId, {
        code: assetCodeKey,
        name: `Settlement asset ${assetCodeUp}`,
        accountType: 'asset',
        assetCode: assetCodeUp,
      });
      assetAccount = await this.prisma.ledgerAccount.findUniqueOrThrow({
        where: { id: created.id },
      });
    }

    let liabilityAccount = await this.prisma.ledgerAccount.findUnique({
      where: {
        organisationId_code: { organisationId, code: liabCodeKey },
      },
    });
    if (!liabilityAccount) {
      const created = await this.ledger.createAccount(organisationId, {
        code: liabCodeKey,
        name: `Customer liability ${assetCodeUp}`,
        accountType: 'liability',
        assetCode: assetCodeUp,
      });
      liabilityAccount = await this.prisma.ledgerAccount.findUniqueOrThrow({
        where: { id: created.id },
      });
    }

    return { assetAccount, liabilityAccount };
  }

  private simulatePaymentInstructions(assetCode: string, amount: string) {
    // Deterministic-looking sandbox address (not a real key)
    const suffix = randomBytes(8).toString('hex');
    if (assetCode === 'ZAR') {
      return {
        type: 'simulated_fiat',
        rail: 'sandbox_eft',
        reference: `DURIN-ZAR-${suffix.toUpperCase()}`,
        amount,
        assetCode,
        note: 'Simulated ZAR payment instruction — not a real bank account.',
        status: 'simulated',
      };
    }
    return {
      type: 'simulated_stablecoin',
      chain: 'ethereum-sepolia',
      token: assetCode,
      address: `0xSIM${suffix}`,
      amount,
      assetCode,
      note: 'Simulated deposit address — do not send real funds.',
      status: 'simulated',
    };
  }

  private serializeIntent(intent: {
    id: string;
    organisationId: string;
    amount: Prisma.Decimal;
    assetCode: string;
    status: string;
    description: string | null;
    customerReference: string | null;
    metadata: unknown;
    paymentInstructions: unknown;
    journalId: string | null;
    expiresAt: Date | null;
    confirmedAt: Date | null;
    settledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: intent.id,
      organisationId: intent.organisationId,
      amount: intent.amount.toFixed(),
      assetCode: intent.assetCode,
      status: intent.status,
      description: intent.description,
      customerReference: intent.customerReference,
      metadata: intent.metadata,
      paymentInstructions: intent.paymentInstructions,
      journalId: intent.journalId,
      expiresAt: intent.expiresAt,
      confirmedAt: intent.confirmedAt,
      settledAt: intent.settledAt,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      mode: 'sandbox' as const,
    };
  }

  private serializeLink(link: {
    id: string;
    organisationId: string;
    urlSlug: string;
    amount: Prisma.Decimal | null;
    assetCode: string | null;
    description: string | null;
    active: boolean;
    metadata: unknown;
    expiresAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: link.id,
      organisationId: link.organisationId,
      url: `https://pay.durin.local/l/${link.urlSlug}`,
      urlSlug: link.urlSlug,
      amount: link.amount?.toFixed() ?? null,
      assetCode: link.assetCode,
      description: link.description,
      active: link.active,
      metadata: link.metadata,
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
      mode: 'sandbox' as const,
      note: 'Hosted checkout page not yet implemented — link metadata only.',
    };
  }
}
