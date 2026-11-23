import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const LOCK_TTL_MS = 30_000;

export type BeginResult = { hit: true; status: number; body: unknown } | { hit: false };

/**
 * Idempotency for mutating requests, scoped to (organisation, key).
 *
 * - First request atomically claims the key (unique insert); concurrent duplicates get 409.
 * - A completed key replays the stored response.
 * - The same key with a different method/URL/body is rejected (409 IDEMPOTENCY_KEY_REUSED).
 * - A crashed in-flight request holds a lease; after it expires another request may take over.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  hashRequest(method: string, path: string, body: unknown): string {
    const canonical = JSON.stringify({ method, path, body: body ?? null });
    return createHash('sha256').update(canonical).digest('hex');
  }

  async begin(organisationId: string, idempotencyKey: string, requestHash: string): Promise<BeginResult> {
    const lockedUntil = new Date(Date.now() + LOCK_TTL_MS);
    try {
      await this.prisma.idempotencyRecord.create({
        data: { organisationId, idempotencyKey, requestHash, lockedUntil },
      });
      return { hit: false };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
    });
    if (!existing) {
      // The owner released the key between our insert and read; try once more.
      return this.begin(organisationId, idempotencyKey, requestHash);
    }
    if (existing.requestHash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency-Key was already used with a different request',
      });
    }
    if (existing.responseStatus != null) {
      return { hit: true, status: existing.responseStatus, body: existing.responseBody };
    }

    // In flight. Take over only if the previous owner's lease has expired (compare-and-set).
    const now = new Date();
    const took = await this.prisma.idempotencyRecord.updateMany({
      where: {
        id: existing.id,
        responseStatus: null,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { lockedUntil },
    });
    if (took.count !== 1) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is still in progress',
      });
    }
    return { hit: false };
  }

  async complete(organisationId: string, idempotencyKey: string, status: number, body: unknown) {
    await this.prisma.idempotencyRecord.update({
      where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
      data: {
        responseStatus: status,
        responseBody: (body ?? null) as Prisma.InputJsonValue,
        lockedUntil: null,
      },
    });
  }

  /** The request failed before producing a response: free the key so the client can retry. */
  async release(organisationId: string, idempotencyKey: string) {
    await this.prisma.idempotencyRecord.deleteMany({
      where: { organisationId, idempotencyKey, responseStatus: null },
    });
  }
}
