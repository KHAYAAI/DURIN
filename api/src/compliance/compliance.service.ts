import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { add, cmp, parseDecimal } from '@durin/ledger';
import { assertPositiveAmount } from '../common/money';
import { assertSandboxOnly } from '../common/sandbox';

@Injectable()
export class ComplianceService {
  constructor(private readonly prisma: PrismaService) {}

  async startVerification(
    organisationId: string,
    subjectType: string,
    subjectId: string,
    level = 'kyb_basic',
  ) {
    const record = await this.prisma.verificationRecord.create({
      data: {
        organisationId,
        subjectType,
        subjectId,
        provider: 'sandbox',
        status: 'pending',
        level,
        metadata: { mode: 'sandbox', note: 'Simulated KYB/KYC — no real provider called' },
      },
    });
    await this.audit(organisationId, 'system', null, 'verification.started', 'verification', record.id);
    return this.serVerification(record);
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
      mode: 'sandbox' as const,
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
