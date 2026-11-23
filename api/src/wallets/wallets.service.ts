import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { LAYER1_PORT } from '../providers/layer1/layer1.module';
import { Layer1Port } from '../providers/layer1/layer1.port';
import { ComplianceService } from '../compliance/compliance.service';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service';
import { assertPositiveAmount } from '../common/money';
import { ensureCustodyRef, ensureCustomer } from '../ledger/chart';
import { assertChainAllowed, assertValidDestination, evaluateDeposit } from '../chains/chain-policy';
import { isSandboxMode } from '../common/sandbox';
import { sandboxCustody } from '../providers/sandbox-custody';
import { assertSandboxOnly } from '../common/sandbox';
import { parseDecimal } from '@durin/ledger';

function defaultChain(): string | undefined {
  return isSandboxMode() ? 'ethereum-sepolia' : undefined;
}

@Injectable()
export class WalletsService {
  private readonly log = new Logger(WalletsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly compliance: ComplianceService,
    private readonly webhooks: WebhookDeliveryService,
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

    const entry = assertChainAllowed(assetCode, chain ?? defaultChain());
    const remote = await this.layer1.createDepositAddress({
      walletExternalRef: wallet.externalRef,
      assetCode: assetCode.toUpperCase(),
      chain: entry.chain,
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
   * Sandbox: simulate detecting a fully confirmed, native-token deposit and credit the customer.
   * Goes through the same chain policy and crediting path as a real detection.
   */
  async simulateDeposit(
    organisationId: string,
    addressId: string,
    amount: string,
  ) {
    assertSandboxOnly('Simulated deposits');
    const addr = await this.prisma.depositAddress.findFirst({
      where: { id: addressId, organisationId },
      include: { wallet: true },
    });
    if (!addr) throw new NotFoundException('Deposit address not found');
    assertPositiveAmount(amount, addr.assetCode);

    const detection = this.layer1.simulateDeposit
      ? await this.layer1.simulateDeposit({ address: addr.address, assetCode: addr.assetCode, amount })
      : { detected: true, txHash: '0xsimulated' };

    const entry = assertChainAllowed(addr.assetCode, addr.chain);
    const result = await this.recordDetectedDeposit(organisationId, addr.id, {
      txHash: detection.txHash,
      amount,
      tokenContract: entry.token,
      confirmations: entry.confirmations,
    });
    if (result.status !== 'credited') throw new BadRequestException({ code: 'DEPOSIT_NOT_CREDITED', message: result.status });
    const journal = result.journal;

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

  /**
   * Withdrawal lifecycle (funds-safety rules):
   *  1. Persist the request (status `requested`) before any money moves.
   *  2. Debit the customer's ledger balance in one atomic journal keyed on the withdrawal id,
   *     so a retry can never debit twice.
   *  3. Call the custody provider.
   *     - Provider says "failed": post a compensating journal and mark `failed`.
   *     - Provider call throws / times out: the outcome is UNKNOWN. Funds stay held and the
   *       request stays `processing` for manual reconciliation. It is never retried or reversed
   *       automatically, because the provider may have executed it.
   */
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
    const assetCode = data.assetCode.toUpperCase();
    assertPositiveAmount(data.amount, assetCode);
    const amount = data.amount;

    if (idempotencyKey) {
      const existing = await this.prisma.withdrawalRequest.findUnique({
        where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
      });
      if (existing) return this.replayWithdrawal(existing, data, assetCode);
    }

    const chainEntry = assertChainAllowed(assetCode, data.chain ?? defaultChain());
    assertValidDestination(chainEntry, data.destination);

    const wallet = await this.prisma.wallet.findFirst({
      where: { id: data.walletId, organisationId },
    });
    if (!wallet?.externalRef) throw new NotFoundException('Wallet not found');

    const limit = await this.compliance.checkLimits(organisationId, assetCode, amount);
    if (!limit.allowed) {
      throw new UnprocessableEntityException({ code: 'LIMIT_EXCEEDED', message: limit.reason });
    }

    const assetAcc = await this.prisma.ledgerAccount.findUnique({
      where: { organisationId_code: { organisationId, code: `CUSTODY-REF-${assetCode}` } },
    });
    const liabAcc = await this.prisma.ledgerAccount.findUnique({
      where: { organisationId_code: { organisationId, code: `CUST-LIAB-${assetCode}` } },
    });
    if (!assetAcc || !liabAcc) {
      throw new BadRequestException('No settlement accounts for asset — deposit or payment settle first');
    }

    // 1. Persist intent first.
    let row;
    try {
      row = await this.prisma.withdrawalRequest.create({
        data: {
          organisationId,
          walletId: wallet.id,
          assetCode,
          amount: new Prisma.Decimal(amount),
          destination: data.destination,
          chain: chainEntry.chain,
          status: 'requested',
          idempotencyKey,
        },
      });
    } catch (e) {
      if (idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.withdrawalRequest.findUniqueOrThrow({
          where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
        });
        return this.replayWithdrawal(winner, data, assetCode);
      }
      throw e;
    }

    const lines = (reverse: boolean) => [
      { accountId: liabAcc.id, direction: reverse ? ('credit' as const) : ('debit' as const), amount, assetCode },
      { accountId: assetAcc.id, direction: reverse ? ('debit' as const) : ('credit' as const), amount, assetCode },
    ];

    // 2. Debit the customer's balance (idempotent on the withdrawal id).
    let journalId: string;
    try {
      const journal = await this.ledger.postJournal(
        organisationId,
        {
          reference: `withdrawal:${row.id}`,
          description: `Withdrawal ${amount} ${assetCode} to ${data.destination}`,
          lines: lines(false),
        },
        `wd-j-${row.id}`,
      );
      journalId = journal.id;
    } catch (e) {
      await this.prisma.withdrawalRequest.update({
        where: { id: row.id },
        data: { status: 'failed', failureReason: this.safeReason(e) },
      });
      throw e;
    }
    row = await this.prisma.withdrawalRequest.update({
      where: { id: row.id },
      data: { status: 'processing', journalId },
    });

    // 3. Provider call.
    let remote;
    try {
      remote = await this.layer1.requestWithdrawal({
        organisationId,
        walletExternalRef: wallet.externalRef,
        assetCode,
        amount,
        destination: data.destination,
        chain: chainEntry.chain,
        clientReference: row.id,
      });
    } catch (e) {
      this.log.error(`Withdrawal ${row.id}: provider outcome unknown: ${e instanceof Error ? e.message : e}`);
      row = await this.prisma.withdrawalRequest.update({
        where: { id: row.id },
        data: { failureReason: 'Provider outcome unknown; funds held pending manual reconciliation' },
      });
      await this.webhooks.publish(organisationId, 'withdrawal.processing', this.serializeWithdrawal(row));
      return {
        ...this.serializeWithdrawal(row),
        mode: this.layer1.mode,
        note: 'The custody provider did not confirm this request. Funds remain held. Do not retry; contact support to reconcile.',
      };
    }

    if (remote.status === 'failed') {
      await this.ledger.postJournal(
        organisationId,
        {
          reference: `withdrawal-reversal:${row.id}`,
          description: `Reversal of failed withdrawal ${row.id}`,
          lines: lines(true),
        },
        `wd-rev-${row.id}`,
      );
      row = await this.prisma.withdrawalRequest.update({
        where: { id: row.id },
        data: { status: 'failed', failureReason: remote.failureReason ?? 'Rejected by custody provider', providerRef: remote.providerRef },
      });
    } else {
      row = await this.prisma.withdrawalRequest.update({
        where: { id: row.id },
        data: {
          status: remote.status === 'confirmed' ? 'confirmed' : 'submitted',
          providerRef: remote.providerRef,
          txHash: remote.txHash,
        },
      });
    }

    await this.webhooks.publish(organisationId, `withdrawal.${row.status}`, this.serializeWithdrawal(row));

    return {
      ...this.serializeWithdrawal(row),
      mode: this.layer1.mode,
      note: this.layer1.mode === 'sandbox' ? 'Sandbox withdrawal — no real broadcast.' : undefined,
    };
  }

  private replayWithdrawal(
    existing: Parameters<WalletsService['serializeWithdrawal']>[0],
    data: { walletId: string; amount: string; destination: string },
    assetCode: string,
  ) {
    const same =
      existing.walletId === data.walletId &&
      existing.assetCode === assetCode &&
      existing.destination === data.destination &&
      parseDecimal(existing.amount.toFixed()) === parseDecimal(data.amount);
    if (!same) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was already used with a different withdrawal',
      });
    }
    return this.serializeWithdrawal(existing);
  }

  private safeReason(e: unknown): string {
    const response = e instanceof BadRequestException ? e.getResponse() : undefined;
    if (response && typeof response === 'object' && 'code' in response) return String((response as { code: unknown }).code);
    return 'Ledger rejected the withdrawal';
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

  /**
   * Entry point for a custody adapter (or webhook handler) that has seen funds arrive on a deposit
   * address. Applies the chain policy (native token only, enabled chain, confirmation depth) and
   * credits the customer exactly once per (address, txHash). Callers re-invoke as confirmations grow.
   */
  async recordDetectedDeposit(
    organisationId: string,
    addressId: string,
    d: { txHash: string; amount: string; tokenContract: string; tokenSymbol?: string; confirmations: number },
  ): Promise<
    | { status: 'credited'; journal: Awaited<ReturnType<LedgerService['postJournal']>> }
    | { status: 'pending'; have: number; need: number }
    | { status: 'rejected'; reason: string }
  > {
    if (!/^[0-9a-f-]{36}$/i.test(addressId)) throw new NotFoundException('Deposit address not found');
    const addr = await this.prisma.depositAddress.findFirst({ where: { id: addressId, organisationId } });
    if (!addr) throw new NotFoundException('Deposit address not found');
    assertPositiveAmount(d.amount, addr.assetCode);

    const verdict = evaluateDeposit({
      assetCode: addr.assetCode, chain: addr.chain, tokenContract: d.tokenContract,
      tokenSymbol: d.tokenSymbol, confirmations: d.confirmations,
    });
    if (verdict.action === 'wait') return { status: 'pending', have: verdict.have, need: verdict.need };
    if (verdict.action === 'reject') {
      await this.prisma.auditLog.create({
        data: {
          organisationId, actorType: 'system', action: 'deposit.rejected', resourceType: 'deposit_address', resourceId: addr.id,
          metadata: { reason: verdict.reason, txHash: d.txHash, tokenContract: d.tokenContract, amount: d.amount },
        },
      });
      return { status: 'rejected', reason: verdict.reason };
    }

    const assetAcc = await ensureCustodyRef(this.ledger, organisationId, addr.assetCode);
    const liabAcc = await ensureCustomer(this.ledger, organisationId, addr.assetCode);
    const key = `dep-${addr.id}-${d.txHash}`;
    const journal = await this.ledger.postJournal(
      organisationId,
      {
        reference: `deposit:${addr.id}:${d.txHash}`,
        description: `Deposit to ${addr.address} (${addr.chain})`,
        lines: [
          { accountId: assetAcc.id, direction: 'debit', amount: d.amount, assetCode: addr.assetCode },
          { accountId: liabAcc.id, direction: 'credit', amount: d.amount, assetCode: addr.assetCode },
        ],
      },
      key,
    );
    if (isSandboxMode()) sandboxCustody.creditOnce(key, organisationId, addr.assetCode, d.amount);
    return { status: 'credited', journal };
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
