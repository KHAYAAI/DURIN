import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { add, cmp, parseDecimal } from '@durin/ledger';
import { assertPositiveAmount } from '../common/money';
import { assertSandboxOnly } from '../common/sandbox';
import { DiditClient, loadDiditConfig, mapDiditStatus } from './didit';
import { Inject, Optional } from '@nestjs/common';

export const DIDIT_FETCH = Symbol('DIDIT_FETCH');

@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(DIDIT_FETCH) private readonly diditFetch?: typeof fetch,
  ) {}

  async startVerification(
    organisationId: string,
    subjectType: string,
    subjectId: string,
    level = 'kyb_basic',
  ) {
    const cfg = loadDiditConfig();
    if (!cfg.enabled) {
      const record = await this.prisma.verificationRecord.create({
        data: {
          organisationId, subjectType, subjectId, provider: 'sandbox', status: 'pending', level,
          metadata: { mode: 'sandbox', note: 'Simulated KYB/KYC — no real provider called' },
        },
      });
      await this.audit(organisationId, 'system', null, 'verification.started', 'verification', record.id);
      return this.serVerification(record);
    }

    const workflowId = level.startsWith('kyb') ? cfg.kybWorkflow : cfg.kycWorkflow;
    if (!cfg.apiKey || !workflowId) {
      throw new ServiceUnavailableException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'Didit is selected but DIDIT_API_KEY / workflow id is not configured.' });
    }
    // The record id is the vendor_data we send, so webhooks can always be tied back to it.
    const record = await this.prisma.verificationRecord.create({
      data: { organisationId, subjectType, subjectId, provider: 'didit', status: 'not_started', level, metadata: { mode: 'live' } },
    });
    try {
      const client = new DiditClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }, this.diditFetch);
      const session = await client.createSession({
        workflowId, vendorData: record.id, callback: cfg.callback,
        metadata: { organisationId, subjectType },
      });
      const updated = await this.prisma.verificationRecord.update({
        where: { id: record.id },
        data: { externalId: session.sessionId, verificationUrl: session.url, providerStatus: session.status, status: 'pending' },
      });
      await this.audit(organisationId, 'system', null, 'verification.started', 'verification', record.id);
      return this.serVerification(updated);
    } catch {
      await this.prisma.verificationRecord.update({ where: { id: record.id }, data: { status: 'rejected', providerStatus: 'provider_error' } });
      throw new ServiceUnavailableException({ code: 'PROVIDER_ERROR', message: 'Could not start verification with the provider.' });
    }
  }

  /**
   * Applies a verified Didit webhook. Returns 'duplicate' for an event_id already processed and
   * 'unknown' when no record matches (acknowledged so Didit does not retry forever).
   */
  async applyDiditEvent(body: Record<string, unknown>): Promise<'applied' | 'duplicate' | 'unknown' | 'ignored'> {
    const eventId = typeof body.event_id === 'string' ? body.event_id : undefined;
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined;
    const status = typeof body.status === 'string' ? body.status : undefined;
    if (!eventId || !sessionId || !status || body.webhook_type !== 'status.updated') return 'ignored';

    const vendor = typeof body.vendor_data === 'string' && /^[0-9a-f-]{36}$/i.test(body.vendor_data) ? body.vendor_data : undefined;
    const rec = await this.prisma.verificationRecord.findFirst({
      where: { provider: 'didit', OR: [{ externalId: sessionId }, ...(vendor ? [{ id: vendor }] : [])] },
    });
    if (!rec) return 'unknown';

    try {
      await this.prisma.processedWebhookEvent.create({ data: { provider: 'didit', eventId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'duplicate';
      throw e;
    }

    const mapped = mapDiditStatus(status);
    // Never let a late, out-of-order event downgrade a final decision.
    const final = rec.status === 'approved' || rec.status === 'rejected';
    const next = final && (mapped === 'pending' || mapped === 'not_started') ? rec.status : mapped;
    const updated = await this.prisma.verificationRecord.update({
      where: { id: rec.id },
      data: {
        status: next,
        providerStatus: status,
        externalId: rec.externalId ?? sessionId,
        lastEventId: eventId,
        reviewedAt: next === 'approved' || next === 'rejected' ? new Date() : rec.reviewedAt,
      },
    });
    await this.audit(rec.organisationId, 'system', 'didit', 'verification.updated', 'verification', rec.id, { status: next, providerStatus: status });
    return updated ? 'applied' : 'applied';
  }

  /** Live gate: the organisation must hold an approved KYB from a real provider (never the sandbox). */
  async assertOrganisationVerified(organisationId: string): Promise<void> {
    const rec = await this.prisma.verificationRecord.findFirst({
      where: { organisationId, status: 'approved', provider: { not: 'sandbox' }, level: { startsWith: 'kyb' } },
    });
    if (!rec) {
      throw new ForbiddenException({ code: 'KYB_REQUIRED', message: 'Organisation has no approved KYB verification.' });
    }
  }

  /** Sandbox: auto-approve after create for demo flows */
  async simulateApproveVerification(organisationId: string, id: string) {
    // A tenant must never be able to approve its own KYB/KYC. Sandbox only.
    assertSandboxOnly('Simulated verification approval');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Verification not found');
    const rec = await this.prisma.verificationRecord.findFirst({
      where: { id, organisationId },
    });
    if (!rec) throw new NotFoundException('Verification not found');
    if (rec.provider !== 'sandbox') throw new ForbiddenException('Provider-backed verifications can only be decided by the provider');
    const updated = await this.prisma.verificationRecord.update({
      where: { id },
      data: { status: 'approved', reviewedAt: new Date() },
    });
    await this.audit(organisationId, 'system', null, 'verification.approved', 'verification', id);
    return this.serVerification(updated);
  }

  async listVerifications(organisationId: string) {
    const rows = await this.prisma.verificationRecord.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serVerification(r));
  }

  async screen(
    organisationId: string,
    subjectType: string,
    subjectId: string,
    screeningType: string,
  ) {
    // Sandbox: always clear unless subjectId contains "sanction".
    // Tenant-created results carry no weight, so this is refused outside sandbox mode.
    assertSandboxOnly('Simulated screening');
    const hit = subjectId.toLowerCase().includes('sanction');
    const row = await this.prisma.screeningResult.create({
      data: {
        organisationId,
        subjectType,
        subjectId,
        screeningType,
        provider: 'sandbox',
        result: hit ? 'hit' : 'clear',
        details: {
          mode: 'sandbox',
          note: hit ? 'Simulated hit for demo' : 'Simulated clear',
        },
      },
    });
    await this.audit(organisationId, 'system', null, 'screening.completed', 'screening', row.id, {
      result: row.result,
    });
    return {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      screeningType: row.screeningType,
      result: row.result,
      details: row.details,
      createdAt: row.createdAt,
      mode: 'sandbox' as const,
    };
  }

  async setLimit(
    organisationId: string,
    name: string,
    opts: { assetCode?: string; dailyLimit?: string; perTxLimit?: string },
  ) {
    if (opts.dailyLimit) assertPositiveAmount(opts.dailyLimit);
    if (opts.perTxLimit) assertPositiveAmount(opts.perTxLimit);
    const row = await this.prisma.limitPolicy.create({
      data: {
        organisationId,
        name,
        assetCode: opts.assetCode?.toUpperCase(),
        dailyLimit: opts.dailyLimit ? new Prisma.Decimal(opts.dailyLimit) : null,
        perTxLimit: opts.perTxLimit ? new Prisma.Decimal(opts.perTxLimit) : null,
        active: true,
      },
    });
    return {
      id: row.id,
      name: row.name,
      assetCode: row.assetCode,
      dailyLimit: row.dailyLimit?.toFixed() ?? null,
      perTxLimit: row.perTxLimit?.toFixed() ?? null,
      active: row.active,
    };
  }

  async listLimits(organisationId: string) {
    const rows = await this.prisma.limitPolicy.findMany({
      where: { organisationId, active: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      assetCode: r.assetCode,
      dailyLimit: r.dailyLimit?.toFixed() ?? null,
      perTxLimit: r.perTxLimit?.toFixed() ?? null,
      active: r.active,
    }));
  }

  async checkLimits(
    organisationId: string,
    assetCode: string,
    amount: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const policies = await this.prisma.limitPolicy.findMany({
      where: {
        organisationId,
        active: true,
        OR: [{ assetCode: assetCode.toUpperCase() }, { assetCode: null }],
      },
    });
    try {
      parseDecimal(amount);
    } catch {
      return { allowed: false, reason: 'Invalid amount' };
    }
    // Rolling 24h outflow for the asset (withdrawals that have not failed or been cancelled).
    const needsDaily = policies.some((p) => p.dailyLimit);
    let outflow24h = '0';
    if (needsDaily) {
      const rows = await this.prisma.withdrawalRequest.findMany({
        where: {
          organisationId,
          assetCode: assetCode.toUpperCase(),
          status: { notIn: ['failed', 'cancelled'] },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        select: { amount: true },
      });
      outflow24h = rows.reduce((sum, r) => add(sum, r.amount.toFixed()), '0');
    }
    for (const p of policies) {
      if (p.perTxLimit && cmp(amount, p.perTxLimit.toFixed()) > 0) {
        return {
          allowed: false,
          reason: `Exceeds per-tx limit ${p.perTxLimit.toFixed()} on policy ${p.name}`,
        };
      }
      if (p.dailyLimit && cmp(add(outflow24h, amount), p.dailyLimit.toFixed()) > 0) {
        return {
          allowed: false,
          reason: `Exceeds daily limit ${p.dailyLimit.toFixed()} on policy ${p.name}`,
        };
      }
    }
    return { allowed: true };
  }

  async requestApproval(
    organisationId: string,
    resourceType: string,
    resourceId: string,
    amount?: string,
    assetCode?: string,
    requestedBy?: string,
  ) {
    if (amount) assertPositiveAmount(amount, assetCode);
    const row = await this.prisma.approvalRequest.create({
      data: {
        organisationId,
        resourceType,
        resourceId,
        amount: amount ? new Prisma.Decimal(amount) : null,
        assetCode: assetCode?.toUpperCase(),
        status: 'pending',
        requestedBy,
      },
    });
    await this.audit(organisationId, 'api_key', requestedBy ?? null, 'approval.requested', resourceType, resourceId);
    return this.serApproval(row);
  }

  /**
   * Four-eyes: the key that requested an approval cannot decide it. The decision is applied with
   * a compare-and-set on `pending`, so two concurrent decisions cannot both succeed.
   */
  async decideApproval(
    organisationId: string,
    id: string,
    decision: 'approved' | 'rejected',
    note?: string,
    actorId?: string,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Approval not found');
    const row = await this.prisma.approvalRequest.findFirst({ where: { id, organisationId } });
    if (!row) throw new NotFoundException('Approval not found');
    if (row.requestedBy && actorId && row.requestedBy === actorId) {
      throw new ForbiddenException({
        code: 'FOUR_EYES_REQUIRED',
        message: 'The key that requested an approval cannot decide it. Use a different API key.',
      });
    }
    const decided = await this.prisma.approvalRequest.updateMany({
      where: { id, organisationId, status: 'pending' },
      data: { status: decision, decisionNote: note, decidedBy: actorId ?? 'api' },
    });
    if (decided.count !== 1) {
      throw new BadRequestException(`Approval already ${row.status === 'pending' ? 'decided' : row.status}`);
    }
    const updated = await this.prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
    await this.audit(organisationId, 'api_key', actorId ?? null, `approval.${decision}`, 'approval', id);
    return this.serApproval(updated);
  }

  async listApprovals(organisationId: string, status?: string) {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        organisationId,
        ...(status ? { status: status as 'pending' | 'approved' | 'rejected' | 'cancelled' } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.serApproval(r));
  }

  async listAudit(organisationId: string, limit = 50) {
    return this.prisma.auditLog.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  async audit(
    organisationId: string | null,
    actorType: string,
    actorId: string | null,
    action: string,
    resourceType?: string,
    resourceId?: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organisationId: organisationId ?? undefined,
        actorType,
        actorId,
        action,
        resourceType,
        resourceId,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private serVerification(r: {
    id: string;
    subjectType: string;
    subjectId: string;
    provider: string;
    status: string;
    level: string;
    reviewedAt: Date | null;
    createdAt: Date;
    verificationUrl?: string | null;
    providerStatus?: string | null;
  }) {
    return {
      id: r.id,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      provider: r.provider,
      status: r.status,
      level: r.level,
      reviewedAt: r.reviewedAt,
      createdAt: r.createdAt,
      verificationUrl: r.provider === 'didit' && r.status !== 'approved' ? (r.verificationUrl ?? null) : null,
      providerStatus: r.providerStatus ?? null,
      mode: r.provider === 'sandbox' ? ('sandbox' as const) : ('live' as const),
    };
  }

  private serApproval(r: {
    id: string;
    resourceType: string;
    resourceId: string;
    amount: Prisma.Decimal | null;
    assetCode: string | null;
    status: string;
    decisionNote: string | null;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      amount: r.amount?.toFixed() ?? null,
      assetCode: r.assetCode,
      status: r.status,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt,
    };
  }
}
