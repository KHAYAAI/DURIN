import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
    // Sandbox: always clear unless subjectId contains "sanction"
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
    for (const p of policies) {
      if (p.perTxLimit && Number(amount) > Number(p.perTxLimit.toFixed())) {
        return {
          allowed: false,
          reason: `Exceeds per-tx limit ${p.perTxLimit.toFixed()} on policy ${p.name}`,
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
  ) {
    const row = await this.prisma.approvalRequest.create({
      data: {
        organisationId,
        resourceType,
        resourceId,
        amount: amount ? new Prisma.Decimal(amount) : null,
        assetCode: assetCode?.toUpperCase(),
        status: 'pending',
      },
    });
    await this.audit(organisationId, 'api_key', null, 'approval.requested', resourceType, resourceId);
    return this.serApproval(row);
  }

  async decideApproval(
    organisationId: string,
    id: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ) {
    const row = await this.prisma.approvalRequest.findFirst({
      where: { id, organisationId },
    });
    if (!row) throw new NotFoundException('Approval not found');
    if (row.status !== 'pending') {
      throw new BadRequestException(`Approval already ${row.status}`);
    }
    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: {
        status: decision,
        decisionNote: note,
        decidedBy: 'api',
      },
    });
    await this.audit(organisationId, 'api_key', null, `approval.${decision}`, 'approval', id);
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
