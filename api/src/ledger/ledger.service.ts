import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  validateJournalInput,
  netAvailableDelta,
  add,
  cmp,
  LedgerInvariantError,
  PostJournalInput,
} from '@durin/ledger';

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async createAccount(
    organisationId: string,
    data: {
      code: string;
      name: string;
      accountType: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'system';
      assetCode: string;
      allowNegative?: boolean;
    },
  ) {
    try {
      const account = await this.prisma.$transaction(async (tx) => {
        const acc = await tx.ledgerAccount.create({
          data: {
            organisationId,
            code: data.code,
            name: data.name,
            accountType: data.accountType,
            assetCode: data.assetCode.toUpperCase(),
            allowNegative: data.allowNegative ?? false,
          },
        });
        await tx.balance.create({
          data: {
            organisationId,
            accountId: acc.id,
            assetCode: acc.assetCode,
            available: new Prisma.Decimal(0),
            pending: new Prisma.Decimal(0),
            reserved: new Prisma.Decimal(0),
          },
        });
        return acc;
      });
      return this.serializeAccount(account);
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Account code already exists: ${data.code}`);
      }
      throw e;
    }
  }

  async listAccounts(organisationId: string) {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { organisationId },
      orderBy: { code: 'asc' },
      include: { balances: true },
    });
    return accounts.map((a) => this.serializeAccount(a, a.balances[0]));
  }

  async getAccount(organisationId: string, accountId: string) {
    const account = await this.prisma.ledgerAccount.findFirst({
      where: { id: accountId, organisationId },
      include: { balances: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    return this.serializeAccount(account, account.balances[0]);
  }

  async getBalances(organisationId: string, accountId: string) {
    const balance = await this.prisma.balance.findFirst({
      where: { accountId, organisationId },
    });
    if (!balance) throw new NotFoundException('Balance not found');
    return {
      accountId: balance.accountId,
      assetCode: balance.assetCode,
      available: balance.available.toFixed(),
      pending: balance.pending.toFixed(),
      reserved: balance.reserved.toFixed(),
      updatedAt: balance.updatedAt,
    };
  }

  /**
   * Post a balanced journal atomically.
   * Idempotent when idempotencyKey is provided.
   */
  async postJournal(
    organisationId: string,
    input: Omit<PostJournalInput, 'organisationId'>,
    idempotencyKey?: string,
  ) {
    const fullInput: PostJournalInput = {
      organisationId,
      ...input,
      idempotencyKey: idempotencyKey ?? input.idempotencyKey,
    };

    try {
      validateJournalInput(fullInput);
    } catch (e) {
      if (e instanceof LedgerInvariantError) {
        throw new BadRequestException({ code: e.code, message: e.message });
      }
      throw e;
    }

    // Idempotent replay
    if (fullInput.idempotencyKey) {
      const existing = await this.prisma.journal.findUnique({
        where: {
          organisationId_idempotencyKey: {
            organisationId,
            idempotencyKey: fullInput.idempotencyKey,
          },
        },
        include: { lines: true },
      });
      if (existing) {
        return this.serializeJournal(existing);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Re-check idempotency inside transaction
      if (fullInput.idempotencyKey) {
        const existing = await tx.journal.findUnique({
          where: {
            organisationId_idempotencyKey: {
              organisationId,
              idempotencyKey: fullInput.idempotencyKey,
            },
          },
          include: { lines: true },
        });
        if (existing) return this.serializeJournal(existing);
      }

      const accountIds = [...new Set(fullInput.lines.map((l) => l.accountId))];
      const accounts = await tx.ledgerAccount.findMany({
        where: { id: { in: accountIds }, organisationId },
      });
      if (accounts.length !== accountIds.length) {
        throw new BadRequestException({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'One or more accounts not found in this organisation',
        });
      }
      const accountMap = new Map(accounts.map((a) => [a.id, a]));

      for (const line of fullInput.lines) {
        const acc = accountMap.get(line.accountId)!;
        if (acc.status !== 'active') {
          throw new BadRequestException({
            code: 'ACCOUNT_CLOSED',
            message: `Account ${acc.code} is not active`,
          });
        }
        if (acc.assetCode !== line.assetCode.toUpperCase()) {
          throw new BadRequestException({
            code: 'ASSET_MISMATCH',
            message: `Line asset ${line.assetCode} does not match account ${acc.code} asset ${acc.assetCode}`,
          });
        }
      }

      // Group lines by account for balance updates
      const linesByAccount = new Map<string, typeof fullInput.lines>();
      for (const line of fullInput.lines) {
        const list = linesByAccount.get(line.accountId) ?? [];
        list.push(line);
        linesByAccount.set(line.accountId, list);
      }

      // Lock balances and check non-negative constraint
      for (const [accountId, lines] of linesByAccount) {
        const acc = accountMap.get(accountId)!;
        const balance = await tx.balance.findUnique({ where: { accountId } });
        if (!balance) {
          throw new BadRequestException({
            code: 'ACCOUNT_NOT_FOUND',
            message: `Balance row missing for account ${accountId}`,
          });
        }

        const delta = netAvailableDelta(acc.accountType, lines);
        const currentAvailable = balance.available.toFixed();
        const nextAvailable = add(currentAvailable, delta);

        if (!acc.allowNegative && cmp(nextAvailable, '0') < 0) {
          throw new BadRequestException({
            code: 'NEGATIVE_BALANCE',
            message: `Posting would make account ${acc.code} available balance negative (${nextAvailable})`,
          });
        }

        await tx.balance.update({
          where: { accountId },
          data: { available: new Prisma.Decimal(nextAvailable) },
        });
      }

      const journal = await tx.journal.create({
        data: {
          organisationId,
          reference: fullInput.reference,
          description: fullInput.description,
          idempotencyKey: fullInput.idempotencyKey,
          valueDate: fullInput.valueDate ? new Date(fullInput.valueDate) : null,
          lines: {
            create: fullInput.lines.map((l) => ({
              accountId: l.accountId,
              direction: l.direction,
              amount: new Prisma.Decimal(l.amount),
              assetCode: l.assetCode.toUpperCase(),
              metadata: l.metadata as Prisma.InputJsonValue | undefined,
            })),
          },
        },
        include: { lines: true },
      });

      return this.serializeJournal(journal);
    });
  }

  async listJournals(organisationId: string, limit = 50) {
    const journals = await this.prisma.journal.findMany({
      where: { organisationId },
      orderBy: { postedAt: 'desc' },
      take: Math.min(limit, 100),
      include: { lines: true },
    });
    return journals.map((j) => this.serializeJournal(j));
  }

  async getJournal(organisationId: string, journalId: string) {
    const journal = await this.prisma.journal.findFirst({
      where: { id: journalId, organisationId },
      include: { lines: true },
    });
    if (!journal) throw new NotFoundException('Journal not found');
    return this.serializeJournal(journal);
  }

  private serializeAccount(
    account: {
      id: string;
      organisationId: string;
      code: string;
      name: string;
      accountType: string;
      assetCode: string;
      allowNegative: boolean;
      status: string;
      createdAt: Date;
    },
    balance?: {
      available: Prisma.Decimal;
      pending: Prisma.Decimal;
      reserved: Prisma.Decimal;
    },
  ) {
    return {
      id: account.id,
      organisationId: account.organisationId,
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      assetCode: account.assetCode,
      allowNegative: account.allowNegative,
      status: account.status,
      createdAt: account.createdAt,
      balances: balance
        ? {
            available: balance.available.toFixed(),
            pending: balance.pending.toFixed(),
            reserved: balance.reserved.toFixed(),
          }
        : undefined,
    };
  }

  private serializeJournal(journal: {
    id: string;
    organisationId: string;
    reference: string | null;
    description: string | null;
    idempotencyKey: string | null;
    postedAt: Date;
    lines: Array<{
      id: string;
      accountId: string;
      direction: string;
      amount: Prisma.Decimal;
      assetCode: string;
    }>;
  }) {
    return {
      id: journal.id,
      organisationId: journal.organisationId,
      reference: journal.reference,
      description: journal.description,
      idempotencyKey: journal.idempotencyKey,
      postedAt: journal.postedAt,
      status: 'posted' as const,
      lines: journal.lines.map((l) => ({
        id: l.id,
        accountId: l.accountId,
        direction: l.direction,
        amount: l.amount.toFixed(),
        assetCode: l.assetCode,
      })),
    };
  }
}
