import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { LAYER1_PORT } from '../providers/layer1/layer1.module';
import { Layer1Port } from '../providers/layer1/layer1.port';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(LAYER1_PORT) private readonly layer1: Layer1Port,
  ) {}

  async createWallet(organisationId: string, label?: string) {
    const remote = await this.layer1.createWallet({ organisationId, label });
    const wallet = await this.prisma.wallet.create({
      data: {
        organisationId,
        label: label ?? null,
        provider: this.layer1.name,
        externalRef: remote.externalRef,
        status: 'active',
        metadata: { mode: this.layer1.mode },
      },
    });
    return this.serializeWallet(wallet);
  }

  async listWallets(organisationId: string) {
    const rows = await this.prisma.wallet.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
      include: { addresses: true },
    });
    return rows.map((w) => this.serializeWallet(w, w.addresses));
  }

  async getWallet(organisationId: string, id: string) {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id, organisationId },
      include: { addresses: true },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    return this.serializeWallet(wallet, wallet.addresses);
  }

  async createAddress(
    organisationId: string,
    walletId: string,
    assetCode: string,
    chain?: string,
  ) {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: walletId, organisationId },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (!wallet.externalRef) {
      throw new BadRequestException('Wallet missing provider reference');
    }

    const remote = await this.layer1.createDepositAddress({
      walletExternalRef: wallet.externalRef,
      assetCode: assetCode.toUpperCase(),
      chain,
    });

    const address = await this.prisma.depositAddress.create({
      data: {
        organisationId,
        walletId: wallet.id,
        assetCode: remote.assetCode,
        chain: remote.chain,
        address: remote.address,
        providerRef: remote.providerRef,
        status: 'active',
      },
    });

    return {
      id: address.id,
      walletId: address.walletId,
      assetCode: address.assetCode,
      chain: address.chain,
      address: address.address,
      status: address.status,
      createdAt: address.createdAt,
      mode: this.layer1.mode,
      note:
        this.layer1.mode === 'sandbox'
          ? 'Simulated address — do not send real funds.'
          : undefined,
    };
  }

  /**
   * Sandbox: simulate detecting a deposit to an address and credit ledger liability.
   */
  async simulateDeposit(
    organisationId: string,
    addressId: string,
    amount: string,
  ) {
    const addr = await this.prisma.depositAddress.findFirst({
      where: { id: addressId, organisationId },
      include: { wallet: true },
    });
    if (!addr) throw new NotFoundException('Deposit address not found');

    const detection = this.layer1.simulateDeposit
      ? await this.layer1.simulateDeposit({
          address: addr.address,
          assetCode: addr.assetCode,
          amount,
        })
      : { detected: true, txHash: '0xsimulated' };

    // Credit platform settlement accounts (same pattern as payment settle)
    const assetKey = `SETTLEMENT-ASSET-${addr.assetCode}`;
    const liabKey = `SETTLEMENT-LIAB-${addr.assetCode}`;
    const assetAcc =
      (await this.prisma.ledgerAccount.findUnique({
        where: { organisationId_code: { organisationId, code: assetKey } },
      })) ??
      (await this.ledger
        .createAccount(organisationId, {
          code: assetKey,
          name: `Settlement asset ${addr.assetCode}`,
          accountType: 'asset',
          assetCode: addr.assetCode,
        })
        .then((a) => this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: a.id } })));

    const liabAcc =
      (await this.prisma.ledgerAccount.findUnique({
        where: { organisationId_code: { organisationId, code: liabKey } },
      })) ??
      (await this.ledger
        .createAccount(organisationId, {
          code: liabKey,
          name: `Customer liability ${addr.assetCode}`,
          accountType: 'liability',
          assetCode: addr.assetCode,
        })
        .then((a) => this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: a.id } })));

    const journal = await this.ledger.postJournal(
      organisationId,
      {
        reference: `deposit:${addr.id}:${detection.txHash}`,
        description: `Simulated deposit to ${addr.address}`,
        lines: [
          {
            accountId: assetAcc.id,
            direction: 'debit',
            amount,
            assetCode: addr.assetCode,
          },
          {
            accountId: liabAcc.id,
            direction: 'credit',
            amount,
            assetCode: addr.assetCode,
          },
        ],
      },
      `dep-${addr.id}-${detection.txHash}`,
    );

    return {
      detected: detection.detected,
      txHash: detection.txHash,
      address: addr.address,
      assetCode: addr.assetCode,
      amount,
      journalId: journal.id,
      mode: 'sandbox' as const,
      note: 'Simulated deposit — no real chain event.',
    };
  }

  async requestWithdrawal(
    organisationId: string,
    data: {
      walletId: string;
      assetCode: string;
      amount: string;
      destination: string;
      chain?: string;
    },
    idempotencyKey?: string,
  ) {
    if (idempotencyKey) {
      const existing = await this.prisma.withdrawalRequest.findUnique({
        where: {
          organisationId_idempotencyKey: { organisationId, idempotencyKey },
        },
      });
      if (existing) return this.serializeWithdrawal(existing);
    }

    const wallet = await this.prisma.wallet.findFirst({
      where: { id: data.walletId, organisationId },
    });
    if (!wallet?.externalRef) throw new NotFoundException('Wallet not found');

    const assetCode = data.assetCode.toUpperCase();

    // Debit customer liability / credit settlement asset on ledger first
    const assetKey = `SETTLEMENT-ASSET-${assetCode}`;
    const liabKey = `SETTLEMENT-LIAB-${assetCode}`;
    const assetAcc = await this.prisma.ledgerAccount.findUnique({
      where: { organisationId_code: { organisationId, code: assetKey } },
    });
    const liabAcc = await this.prisma.ledgerAccount.findUnique({
      where: { organisationId_code: { organisationId, code: liabKey } },
    });
    if (!assetAcc || !liabAcc) {
      throw new BadRequestException(
        'No settlement accounts for asset — deposit or payment settle first',
      );
    }

    let journalId: string | null = null;
    try {
      const journal = await this.ledger.postJournal(
        organisationId,
        {
          reference: `withdrawal:${data.walletId}`,
          description: `Withdrawal ${data.amount} ${assetCode} to ${data.destination}`,
          lines: [
            {
              accountId: liabAcc.id,
              direction: 'debit',
              amount: data.amount,
              assetCode,
            },
            {
              accountId: assetAcc.id,
              direction: 'credit',
              amount: data.amount,
              assetCode,
            },
          ],
        },
        idempotencyKey ? `wd-j-${idempotencyKey}` : undefined,
      );
      journalId = journal.id;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Ledger post failed';
      throw new BadRequestException(msg);
    }

    const remote = await this.layer1.requestWithdrawal({
      walletExternalRef: wallet.externalRef,
      assetCode,
      amount: data.amount,
      destination: data.destination,
      chain: data.chain,
    });

    const row = await this.prisma.withdrawalRequest.create({
      data: {
        organisationId,
        walletId: wallet.id,
        assetCode,
        amount: new Prisma.Decimal(data.amount),
        destination: data.destination,
        chain: data.chain ?? 'ethereum-sepolia',
        status: remote.status === 'confirmed' ? 'confirmed' : 'submitted',
        providerRef: remote.providerRef,
        txHash: remote.txHash,
        journalId,
        failureReason: remote.failureReason,
        idempotencyKey,
      },
    });

    return {
      ...this.serializeWithdrawal(row),
      mode: this.layer1.mode,
      note:
        this.layer1.mode === 'sandbox'
          ? 'Sandbox withdrawal — no real broadcast.'
          : undefined,
    };
  }

  async listWithdrawals(organisationId: string) {
    const rows = await this.prisma.withdrawalRequest.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.serializeWithdrawal(r));
  }

  async getWithdrawal(organisationId: string, id: string) {
    const row = await this.prisma.withdrawalRequest.findFirst({
      where: { id, organisationId },
    });
    if (!row) throw new NotFoundException('Withdrawal not found');
    return this.serializeWithdrawal(row);
  }

  private serializeWallet(
    w: {
      id: string;
      organisationId: string;
      label: string | null;
      provider: string;
      externalRef: string | null;
      status: string;
      createdAt: Date;
    },
    addresses?: Array<{
      id: string;
      assetCode: string;
      chain: string;
      address: string;
      status: string;
    }>,
  ) {
    return {
      id: w.id,
      organisationId: w.organisationId,
      label: w.label,
      provider: w.provider,
      externalRef: w.externalRef,
      status: w.status,
      createdAt: w.createdAt,
      addresses: addresses?.map((a) => ({
        id: a.id,
        assetCode: a.assetCode,
        chain: a.chain,
        address: a.address,
        status: a.status,
      })),
      mode: this.layer1.mode,
    };
  }

  private serializeWithdrawal(r: {
    id: string;
    organisationId: string;
    walletId: string;
    assetCode: string;
    amount: Prisma.Decimal;
    destination: string;
    chain: string;
    status: string;
    providerRef: string | null;
    txHash: string | null;
    journalId: string | null;
    failureReason: string | null;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      organisationId: r.organisationId,
      walletId: r.walletId,
      assetCode: r.assetCode,
      amount: r.amount.toFixed(),
      destination: r.destination,
      chain: r.chain,
      status: r.status,
      providerRef: r.providerRef,
      txHash: r.txHash,
      journalId: r.journalId,
      failureReason: r.failureReason,
      createdAt: r.createdAt,
    };
  }
}
