import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  validateJournalInput,
  formatDecimal,
  parseDecimal,
  LedgerInvariantError,
  PostJournalInput,
} from '@durin/ledger';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Database trigger messages (see migration 20261123000000_ledger_invariants) mapped to API error codes. */
const DB_ERROR_CODES = [
  'NEGATIVE_BALANCE',
  'ASSET_MISMATCH',
  'ACCOUNT_CLOSED',
  'TENANT_MISMATCH',
  'UNBALANCED_JOURNAL',
] as const;

type JournalRow = {
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
};

type AccountSpec = {
  code: string;
  name: string;
  accountType: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'system';
  assetCode: string;
  allowNegative?: boolean;
};

/**
 * Ledger write path.
 *
 * Correctness model:
 *  - Accounts touched by a journal are locked with SELECT ... FOR UPDATE in ascending id order,
 *    so concurrent postings serialise and cannot deadlock.
 *  - Balances are maintained ONLY by database triggers inside the same transaction as the
 *    journal lines. The runtime database role has no write access to `balances`.
 *  - The database independently enforces: balanced journals per asset, positive amounts,
 *    asset and tenant consistency, non-negative balances, and immutability of posted entries.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async createAccount(organisationId: string, data: AccountSpec) {
    try {
      // The balance row is created by the ledger_accounts_snapshot trigger.
      const account = await this.prisma.ledgerAccount.create({
        data: {
          organisationId,
          code: data.code,
          name: data.name,
          accountType: data.accountType,
          assetCode: data.assetCode.toUpperCase(),
          allowNegative: data.allowNegative ?? false,
        },
        include: { balances: true },
      });
      return this.serializeAccount(account, account.balances[0]);
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Account code already exists: ${data.code}`);
      }
      throw e;
    }
  }

  /**
   * Get-or-create an account by code. Safe under concurrency: if two requests race to create
   * the same account, the loser re-reads the winner's row.
   */
  async ensureAccount(organisationId: string, spec: AccountSpec) {
    const where = { organisationId_code: { organisationId, code: spec.code } };
    const assetCode = spec.assetCode.toUpperCase();
    const check = (account: { accountType: string; assetCode: string }) => {
      if (account.accountType !== spec.accountType || account.assetCode !== assetCode) {
        throw new ConflictException(`Account ${spec.code} exists with a different type or asset`);
      }
    };
    const existing = await this.prisma.ledgerAccount.findUnique({ where });
    if (existing) {
      check(existing);
      return existing;
    }
    try {
      return await this.prisma.ledgerAccount.create({
        data: {
          organisationId,
          code: spec.code,
          name: spec.name,
          accountType: spec.accountType,
          assetCode,
          allowNegative: spec.allowNegative ?? false,
        },
      });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.ledgerAccount.findUniqueOrThrow({ where });
        check(winner);
        return winner;
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
    if (!UUID_PATTERN.test(accountId)) throw new NotFoundException('Account not found');
    const account = await this.prisma.ledgerAccount.findFirst({
      where: { id: accountId, organisationId },
      include: { balances: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    return this.serializeAccount(account, account.balances[0]);
  }

  async getBalances(organisationId: string, accountId: string) {
    if (!UUID_PATTERN.test(accountId)) throw new NotFoundException('Balance not found');
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
   * Post a balanced journal atomically. Idempotent when an idempotency key is provided:
   * the same key with the same lines returns the original journal; the same key with
   * different lines is rejected with 409.
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

    const accountIds = [...new Set(fullInput.lines.map((l) => l.accountId))].sort();
    if (accountIds.some((id) => !UUID_PATTERN.test(id))) {
      throw new BadRequestException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'One or more accounts not found in this organisation',
      });
    }

    const key = fullInput.idempotencyKey;
    if (key) {
      const existing = await this.findByKey(organisationId, key);
      if (existing) return this.replay(existing, fullInput);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lock all touched accounts in a fixed order: serialises writers, prevents deadlocks.
        const locked = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT id FROM ledger_accounts
                      WHERE organisation_id = ${organisationId}::uuid
                        AND id = ANY(${accountIds}::uuid[])
                      ORDER BY id FOR UPDATE`,
        );
        if (locked.length !== accountIds.length) {
          throw new BadRequestException({
            code: 'ACCOUNT_NOT_FOUND',
            message: 'One or more accounts not found in this organisation',
          });
        }

        const accounts = await tx.ledgerAccount.findMany({
          where: { id: { in: accountIds }, organisationId },
        });
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

        const journal = await tx.journal.create({
          data: {
            organisationId,
            reference: fullInput.reference,
            description: fullInput.description,
            idempotencyKey: key,
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
    } catch (e) {
      // Concurrent request with the same idempotency key won the race.
      if (key && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.findByKey(organisationId, key);
        if (existing) return this.replay(existing, fullInput);
      }
      throw this.mapDbError(e);
    }
  }

  async listJournals(organisationId: string, limit = 50) {
    const take = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 50;
    const journals = await this.prisma.journal.findMany({
      where: { organisationId },
      orderBy: { postedAt: 'desc' },
      take,
      include: { lines: true },
    });
    return journals.map((j) => this.serializeJournal(j));
  }

  async getJournal(organisationId: string, journalId: string) {
    if (!UUID_PATTERN.test(journalId)) throw new NotFoundException('Journal not found');
    const journal = await this.prisma.journal.findFirst({
      where: { id: journalId, organisationId },
      include: { lines: true },
    });
    if (!journal) throw new NotFoundException('Journal not found');
    return this.serializeJournal(journal);
  }

  /**
   * Internal consistency report for one organisation. Re-derives every balance from the
   * posted lines and checks that every journal balances per asset. A healthy ledger returns
   * `healthy: true` with empty lists. Used by reconciliation and monitoring.
   */
  async integrityReport(organisationId: string) {
    const drift = await this.prisma.$queryRaw<
      { account_id: string; code: string; snapshot: Prisma.Decimal; derived: Prisma.Decimal }[]
    >(Prisma.sql`
      SELECT b.account_id, a.code, b.available AS snapshot,
             COALESCE(SUM(CASE WHEN (a.account_type IN ('asset','expense','system')) = (l.direction = 'debit')
                               THEN l.amount ELSE -l.amount END), 0) AS derived
        FROM balances b
        JOIN ledger_accounts a ON a.id = b.account_id
        LEFT JOIN journal_lines l ON l.account_id = b.account_id
       WHERE b.organisation_id = ${organisationId}::uuid
       GROUP BY b.account_id, a.code, b.available
      HAVING b.available <> COALESCE(SUM(CASE WHEN (a.account_type IN ('asset','expense','system')) = (l.direction = 'debit')
                                              THEN l.amount ELSE -l.amount END), 0)`);

    const unbalanced = await this.prisma.$queryRaw<{ journal_id: string; asset_code: string }[]>(Prisma.sql`
      SELECT l.journal_id, l.asset_code
        FROM journal_lines l JOIN journals j ON j.id = l.journal_id
       WHERE j.organisation_id = ${organisationId}::uuid
       GROUP BY l.journal_id, l.asset_code
      HAVING SUM(CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END) <> 0`);

    return {
      organisationId,
      healthy: drift.length === 0 && unbalanced.length === 0,
      balanceDrift: drift.map((d) => ({
        accountId: d.account_id,
        code: d.code,
        snapshot: d.snapshot.toString(),
        derived: d.derived.toString(),
      })),
      unbalancedJournals: unbalanced.map((u) => ({ journalId: u.journal_id, assetCode: u.asset_code })),
      checkedAt: new Date().toISOString(),
    };
  }

  private async findByKey(organisationId: string, idempotencyKey: string) {
    return this.prisma.journal.findUnique({
      where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
      include: { lines: true },
    });
  }

  /** Return the original journal if the replay matches it; reject if the key was reused differently. */
  private replay(existing: JournalRow, input: PostJournalInput) {
    const normalise = (lines: { accountId: string; direction: string; amount: string; assetCode: string }[]) =>
      lines
        .map((l) => `${l.accountId}|${l.direction}|${formatDecimal(parseDecimal(l.amount))}|${l.assetCode.toUpperCase()}`)
        .sort()
        .join(';');
    const same =
      normalise(existing.lines.map((l) => ({ ...l, amount: l.amount.toFixed() }))) === normalise(input.lines);
    if (!same) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was already used with a different journal',
      });
    }
    return this.serializeJournal(existing);
  }

  private mapDbError(e: unknown): unknown {
    if (e instanceof BadRequestException || e instanceof ConflictException) return e;
    const message = e instanceof Error ? e.message : '';
    for (const code of DB_ERROR_CODES) {
      if (message.includes(code)) {
        const detail = message.slice(message.indexOf(code)).split('\n')[0]!.trim();
        return new BadRequestException({ code, message: detail });
      }
    }
    return e;
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

  private serializeJournal(journal: JournalRow) {
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
