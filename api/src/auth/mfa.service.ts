import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WORKOS_PORT, WorkosPort } from './workos.port';

const MAX_ATTEMPTS = 5;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const stepUpTtlMs = () => Number(process.env.MFA_STEPUP_TTL_MINUTES ?? 15) * 60 * 1000;

/**
 * Session-bound MFA step-up. WorkOS AuthKit access tokens carry no MFA claim, and Required MFA
 * does not cover users who sign in through enterprise SSO, so DURIN runs its own TOTP challenge
 * (via WorkOS) and records the result against (user, session). Sensitive endpoints check it.
 */
@Injectable()
export class MfaService {
  constructor(private readonly prisma: PrismaService, @Inject(WORKOS_PORT) private readonly workos: WorkosPort) {}

  private requireConfigured() {
    if (!this.workos.configured) throw new ServiceUnavailableException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'WorkOS is not configured.' });
  }

  async status(organisationId: string, userId: string, sessionId: string) {
    const v = await this.latestVerification(userId, sessionId);
    return { verified: !!v, expiresAt: v?.expiresAt ?? null };
  }

  async latestVerification(userId: string, sessionId: string) {
    return this.prisma.mfaVerification.findFirst({
      where: { userId, sessionId, expiresAt: { gt: new Date() } },
      orderBy: { verifiedAt: 'desc' },
    });
  }

  async enroll(userId: string) {
    this.requireConfigured();
    const existing = await this.workos.listTotpFactorIds(userId);
    if (existing.length > 0) throw new BadRequestException({ code: 'MFA_ALREADY_ENROLLED', message: 'A TOTP factor is already enrolled.' });
    return this.workos.enrollTotp(userId);
  }

  async challenge(organisationId: string, userId: string, sessionId: string, factorId?: string) {
    this.requireConfigured();
    const factors = await this.workos.listTotpFactorIds(userId);
    if (factors.length === 0) throw new ForbiddenException({ code: 'MFA_NOT_ENROLLED', message: 'Enroll a TOTP factor first.' });
    const chosen = factorId ?? factors[0]!;
    // A user can only be challenged on their own factors.
    if (!factors.includes(chosen)) throw new NotFoundException('Factor not found');
    const ch = await this.workos.challenge(chosen);
    const row = await this.prisma.mfaChallenge.create({
      data: {
        organisationId, userId, sessionId, factorId: chosen, workosChallengeId: ch.challengeId,
        expiresAt: new Date(Math.min(Date.now() + CHALLENGE_TTL_MS, ch.expiresAt?.getTime() ?? Infinity)),
      },
    });
    return { challengeId: row.id, expiresAt: row.expiresAt };
  }

  async verify(organisationId: string, userId: string, sessionId: string, challengeId: string, code: string) {
    this.requireConfigured();
    if (!/^[0-9a-f-]{36}$/i.test(challengeId)) throw new NotFoundException('Challenge not found');
    const ch = await this.prisma.mfaChallenge.findFirst({ where: { id: challengeId, userId, sessionId } });
    if (!ch) throw new NotFoundException('Challenge not found');
    if (ch.status !== 'pending' || ch.expiresAt < new Date() || ch.attempts >= MAX_ATTEMPTS) {
      throw new ForbiddenException({ code: 'MFA_CHALLENGE_INVALID', message: 'Challenge is expired, used or locked. Start a new one.' });
    }
    // Count the attempt BEFORE asking WorkOS so concurrent guesses cannot exceed the limit.
    const claimed = await this.prisma.mfaChallenge.updateMany({
      where: { id: ch.id, status: 'pending', attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new ForbiddenException({ code: 'MFA_CHALLENGE_INVALID', message: 'Challenge is locked.' });

    let valid = false;
    try {
      valid = await this.workos.verify(ch.workosChallengeId, code);
    } catch {
      valid = false;
    }
    if (!valid) throw new ForbiddenException({ code: 'MFA_CODE_INVALID', message: 'Invalid code.' });

    // Single use: only the request that flips pending→verified creates the verification.
    const done = await this.prisma.mfaChallenge.updateMany({ where: { id: ch.id, status: 'pending' }, data: { status: 'verified' } });
    if (done.count !== 1) throw new ForbiddenException({ code: 'MFA_CHALLENGE_INVALID', message: 'Challenge already used.' });
    const v = await this.prisma.mfaVerification.create({
      data: { organisationId, userId, sessionId, factorId: ch.factorId, expiresAt: new Date(Date.now() + stepUpTtlMs()) },
    });
    return { verified: true, expiresAt: v.expiresAt };
  }
}
