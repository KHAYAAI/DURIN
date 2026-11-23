import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const LOCK_TTL_MS = 30_000;

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  hashRequest(method: string, path: string, body: unknown): string {
    const canonical = JSON.stringify({ method, path, body: body ?? null });
    return createHash('sha256').update(canonical).digest('hex');
  }

  async begin(
    organisationId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ hit: true; status: number; body: unknown } | { hit: false }> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        organisationId_idempotencyKey: { organisationId, idempotencyKey },
      },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency-Key reused with a different request payload',
        );
      }
      if (existing.responseStatus != null) {
        return {
          hit: true,
          status: existing.responseStatus,
          body: existing.responseBody,
        };
      }
      // In progress — for M1 we treat as conflict; later can wait/poll
      if (existing.lockedUntil && existing.lockedUntil > new Date()) {
        throw new ConflictException('Request with this Idempotency-Key is still in progress');
      }
    }

    const lockedUntil = new Date(Date.now() + LOCK_TTL_MS);
    await this.prisma.idempotencyRecord.upsert({
      where: {
        organisationId_idempotencyKey: { organisationId, idempotencyKey },
      },
      create: {
        organisationId,
        idempotencyKey,
        requestHash,
        lockedUntil,
      },
      update: {
        requestHash,
        lockedUntil,
        responseStatus: null,
        responseBody: undefined,
      },
    });

    return { hit: false };
  }

  async complete(
    organisationId: string,
    idempotencyKey: string,
    status: number,
    body: unknown,
  ) {
    await this.prisma.idempotencyRecord.update({
      where: {
        organisationId_idempotencyKey: { organisationId, idempotencyKey },
      },
      data: {
        responseStatus: status,
        responseBody: body as object,
        lockedUntil: null,
      },
    });
  }
}
