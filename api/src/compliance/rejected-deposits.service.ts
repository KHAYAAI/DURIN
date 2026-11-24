import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RejectedDepositInput {
  organisationId: string; depositAddressId: string; chain: string; txHash: string; tokenContract: string;
  baseUnits: string; decimals?: number | null; reason: string; sender?: string | null;
}

/**
 * Wrong-token deposits (look-alike, bridged, unsupported). They are NEVER credited. This is the controlled
 * process for what happens to the funds:
 *
 *   detected ──review(return + screening ref)──▶ under_review ──approve (a DIFFERENT person)──▶ approved
 *      │                                                                                          │
 *      └──review(hold)──▶ held                                  complete(returnTxHash evidence) ──▶ returned
 *
 *  - Returns go to the ORIGINAL SENDER by default; any other address needs an override reason and still
 *    needs a second approver. A sanctions/KYT screening reference is mandatory before a return is approved.
 *  - The actual on-chain return is performed OUT OF BAND by the custodian's operators (the custody APIs refuse
 *    tokens that are not registered); DURIN records the evidence (tx hash) and the audit trail.
 *  - Every transition is audited with the acting user. Four-eyes: reviewer ≠ approver.
 */
@Injectable()
export class RejectedDepositsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent: the same (address, tx, token) is recorded once. */
  async record(i: RejectedDepositInput) {
    try {
      const row = await this.prisma.rejectedDeposit.create({
        data: { ...i, decimals: i.decimals ?? null, sender: i.sender ?? null },
      });
      await this.prisma.auditLog.create({
        data: { organisationId: i.organisationId, actorType: 'system', action: 'deposit.rejected', resourceType: 'rejected_deposit', resourceId: row.id,
          metadata: { reason: i.reason, txHash: i.txHash, tokenContract: i.tokenContract, baseUnits: i.baseUnits, chain: i.chain } },
      });
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.rejectedDeposit.findFirstOrThrow({ where: { depositAddressId: i.depositAddressId, txHash: i.txHash, tokenContract: i.tokenContract } });
      }
      throw e;
    }
  }

  async list(organisationId: string, status?: string) {
    const rows = await this.prisma.rejectedDeposit.findMany({ where: { organisationId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.ser(r));
  }

  private async load(organisationId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Rejected deposit not found');
    const r = await this.prisma.rejectedDeposit.findFirst({ where: { id, organisationId } });
    if (!r) throw new NotFoundException('Rejected deposit not found');
    return r;
  }

  private async audit(organisationId: string, actor: string, action: string, id: string, metadata?: Prisma.InputJsonValue) {
    await this.prisma.auditLog.create({ data: { organisationId, actorType: 'user', actorId: actor, action, resourceType: 'rejected_deposit', resourceId: id, metadata } });
  }

  /** Atomic transition: only the intended source status can move. */
  private async move(id: string, from: string, data: Prisma.RejectedDepositUpdateManyMutationInput) {
    const res = await this.prisma.rejectedDeposit.updateMany({ where: { id, status: from }, data });
    if (res.count !== 1) throw new ConflictException(`Deposit is no longer ${from}`);
  }

  async review(organisationId: string, id: string, actor: string, d: { decision: 'return' | 'hold'; returnAddress?: string; overrideReason?: string; screeningRef?: string; note?: string }) {
    const r = await this.load(organisationId, id);
    if (r.status !== 'detected') throw new ConflictException(`Deposit is ${r.status}, not detected`);
    if (d.decision === 'hold') {
      await this.move(id, 'detected', { status: 'held', reviewedBy: actor, reviewNote: d.note?.slice(0, 500) });
      await this.audit(organisationId, actor, 'rejected_deposit.held', id, { note: d.note ?? null });
      return this.ser(await this.load(organisationId, id));
    }
    if (!d.screeningRef || d.screeningRef.length < 3) throw new BadRequestException({ code: 'SCREENING_REQUIRED', message: 'A sanctions/KYT screening reference is required before a return.' });
    const to = d.returnAddress ?? r.sender;
    if (!to) throw new BadRequestException({ code: 'RETURN_ADDRESS_REQUIRED', message: 'The sender could not be determined; supply a return address with an override reason.' });
    if (r.sender && to !== r.sender && !d.overrideReason) throw new BadRequestException({ code: 'OVERRIDE_REASON_REQUIRED', message: 'Returning to an address other than the sender needs an override reason.' });
    if (!r.sender && !d.overrideReason) throw new BadRequestException({ code: 'OVERRIDE_REASON_REQUIRED', message: 'No sender is known; an override reason is required.' });
    await this.move(id, 'detected', { status: 'under_review', reviewedBy: actor, returnAddress: to, overrideReason: d.overrideReason?.slice(0, 500), screeningRef: d.screeningRef, reviewNote: d.note?.slice(0, 500) });
    await this.audit(organisationId, actor, 'rejected_deposit.review_return', id, { returnAddress: to, screeningRef: d.screeningRef });
    return this.ser(await this.load(organisationId, id));
  }

  async approve(organisationId: string, id: string, actor: string) {
    const r = await this.load(organisationId, id);
    if (r.status !== 'under_review') throw new ConflictException(`Deposit is ${r.status}, not under review`);
    if (r.reviewedBy === actor) throw new ForbiddenException({ code: 'FOUR_EYES', message: 'The reviewer cannot approve their own review.' });
    await this.move(id, 'under_review', { status: 'approved', approvedBy: actor });
    await this.audit(organisationId, actor, 'rejected_deposit.approved', id, { returnAddress: r.returnAddress });
    return this.ser(await this.load(organisationId, id));
  }

  /** Records that the return was performed out of band, with the on-chain evidence. */
  async complete(organisationId: string, id: string, actor: string, returnTxHash: string) {
    const r = await this.load(organisationId, id);
    if (r.status !== 'approved') throw new ConflictException(`Deposit is ${r.status}, not approved`);
    if (!returnTxHash || returnTxHash.length < 8 || returnTxHash.length > 200) throw new BadRequestException('returnTxHash is required');
    if (returnTxHash === r.txHash) throw new BadRequestException('The return transaction cannot be the original deposit');
    await this.move(id, 'approved', { status: 'returned', returnTxHash });
    await this.audit(organisationId, actor, 'rejected_deposit.returned', id, { returnTxHash, returnAddress: r.returnAddress });
    return this.ser(await this.load(organisationId, id));
  }

  private ser(r: Prisma.RejectedDepositGetPayload<object>) {
    return {
      id: r.id, chain: r.chain, txHash: r.txHash, tokenContract: r.tokenContract, baseUnits: r.baseUnits, decimals: r.decimals,
      reason: r.reason, sender: r.sender, status: r.status, reviewedBy: r.reviewedBy, approvedBy: r.approvedBy,
      returnAddress: r.returnAddress, screeningRef: r.screeningRef, returnTxHash: r.returnTxHash, createdAt: r.createdAt,
    };
  }
}
