import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface G1Scope { assets: string[]; jurisdictions: string[] }

/**
 * Gate G1 — counsel sign-off for live currency conversion.
 *
 * This service RECORDS a human decision; it can never produce one. A record is only created by a
 * signed-in dashboard user who completed MFA (see GatesController), names the counsel reference
 * and the SHA-256 of the signed opinion, scopes it to assets and jurisdictions, and expires.
 * Live conversion requires BOTH a valid record here AND the operator kill-switch
 * CONVERSION_LIVE_ENABLED=true (see conversions/live-gate.ts).
 */
@Injectable()
export class GatesService {
  constructor(private readonly prisma: PrismaService) {}

  async recordG1(organisationId: string, actor: string, input: { counselReference: string; documentSha256: string; assets: string[]; jurisdictions: string[]; validDays: number }) {
    return this.record('G1', organisationId, actor, input);
  }

  /** G1 = live conversion (per customer organisation); G2 = internal netting; G3 = own-inventory dealing (G2/G3 are recorded on the house organisation). */
  async record(gate: 'G1' | 'G2' | 'G3', organisationId: string, actor: string, input: { counselReference: string; documentSha256: string; assets: string[]; jurisdictions: string[]; validDays: number }) {
    if (!/^[0-9a-f]{64}$/i.test(input.documentSha256)) throw new BadRequestException('documentSha256 must be a 64-character hex SHA-256');
    if (!input.assets.length || !input.jurisdictions.length) throw new BadRequestException('assets and jurisdictions are required');
    if (input.validDays < 1 || input.validDays > 365) throw new BadRequestException('validDays must be between 1 and 365');
    const row = await this.prisma.gateApproval.create({
      data: {
        organisationId, gate, counselReference: input.counselReference, documentSha256: input.documentSha256.toLowerCase(),
        scope: { assets: input.assets.map((a) => a.toUpperCase()), jurisdictions: input.jurisdictions.map((j) => j.toUpperCase()) },
        approvedBy: actor, expiresAt: new Date(Date.now() + input.validDays * 86_400_000),
      },
    });
    await this.prisma.auditLog.create({ data: { organisationId, actorType: 'user', actorId: actor, action: `gate.${gate.toLowerCase()}_recorded`, resourceType: 'gate_approval', resourceId: row.id, metadata: { counselReference: input.counselReference, documentSha256: row.documentSha256 } } });
    return this.ser(row);
  }

  async revoke(organisationId: string, id: string, actor: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Approval not found');
    const res = await this.prisma.gateApproval.updateMany({ where: { id, organisationId, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: actor } });
    if (res.count !== 1) throw new NotFoundException('Active approval not found');
    await this.prisma.auditLog.create({ data: { organisationId, actorType: 'user', actorId: actor, action: 'gate.g1_revoked', resourceType: 'gate_approval', resourceId: id } });
    return { id, revoked: true };
  }

  async list(organisationId: string, gate: 'G1' | 'G2' | 'G3' = 'G1') {
    const rows = await this.prisma.gateApproval.findMany({ where: { organisationId, gate }, orderBy: { approvedAt: 'desc' }, take: 50 });
    return rows.map((r) => this.ser(r));
  }

  /** True when a valid, unrevoked, unexpired approval for `gate` covers every given asset (none given = any). */
  async isOpen(organisationId: string, gate: 'G1' | 'G2' | 'G3', assets: string[] = []): Promise<boolean> {
    const rows = await this.prisma.gateApproval.findMany({ where: { organisationId, gate, revokedAt: null, expiresAt: { gt: new Date() } } });
    return rows.some((r) => assets.every((a) => (r.scope as unknown as G1Scope).assets.includes(a.toUpperCase())));
  }

  /** Throws unless a valid, unrevoked, unexpired G1 approval covers every asset in the conversion. */
  async assertG1(organisationId: string, assets: string[]): Promise<void> {
    const rows = await this.prisma.gateApproval.findMany({ where: { organisationId, gate: 'G1', revokedAt: null, expiresAt: { gt: new Date() } } });
    const covered = rows.some((r) => {
      const scope = r.scope as unknown as G1Scope;
      return assets.every((a) => scope.assets.includes(a.toUpperCase()));
    });
    if (!covered) {
      throw new ForbiddenException({ code: 'AWAITING_REGULATORY_APPROVAL', message: 'No valid gate G1 (counsel sign-off) covers this conversion.' });
    }
  }

  private ser(r: { id: string; gate: string; counselReference: string; documentSha256: string; scope: unknown; approvedBy: string; approvedAt: Date; expiresAt: Date; revokedAt: Date | null }) {
    return { id: r.id, gate: r.gate, counselReference: r.counselReference, documentSha256: r.documentSha256, scope: r.scope, approvedBy: r.approvedBy, approvedAt: r.approvedAt, expiresAt: r.expiresAt, revoked: !!r.revokedAt, active: !r.revokedAt && r.expiresAt > new Date() };
  }
}
