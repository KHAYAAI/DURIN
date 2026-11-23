import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@durin/shared';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../common/crypto-secrets';
import { safePost } from './safe-fetch';

/** Seconds to wait after attempt N fails (index N-1). After the last, the delivery is `failed`. */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 3600, 21_600, 43_200, 86_400];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
const LEASE_SECONDS = 60;

type Claimed = { id: string; endpoint_id: string; event_id: string; event_type: string; payload: unknown; attempts: number };

/**
 * Delivers queued webhooks. Safe to run in several API instances at once: rows are claimed with
 * FOR UPDATE SKIP LOCKED and leased, so no two workers send the same delivery concurrently.
 * Delivery is at-least-once; receivers must de-duplicate on the event id.
 */
@Injectable()
export class WebhookWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WebhookWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.WEBHOOK_WORKER === 'false') return;
    const intervalMs = Number(process.env.WEBHOOK_WORKER_INTERVAL_MS || 2000);
    this.timer = setInterval(() => {
      this.runOnce().catch((e) => this.log.error(`Webhook worker error: ${e instanceof Error ? e.message : e}`));
    }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Claim and deliver up to `limit` due deliveries. Returns how many were attempted. */
  async runOnce(limit = 20): Promise<number> {
    const claimed = await this.prisma.$queryRaw<Claimed[]>(Prisma.sql`
      UPDATE webhook_deliveries
         SET attempts = attempts + 1,
             next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS}),
             updated_at = now()
       WHERE id IN (
         SELECT id FROM webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id, endpoint_id, event_id, event_type, payload, attempts`);
    await Promise.all(claimed.map((d) => this.deliver(d)));
    return claimed.length;
  }

  private async deliver(d: Claimed): Promise<void> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { id: d.endpoint_id } });
    if (!endpoint || endpoint.status !== 'active') {
      await this.finish(d.id, 'failed', null, 'Endpoint removed or disabled');
      return;
    }

    const body = JSON.stringify({
      id: d.event_id,
      object: 'event',
      type: d.event_type,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: d.payload },
    });

    let status: number | null = null;
    let error: string | null = null;
    try {
      const secret = decryptSecret(endpoint.secretEnc);
      const res = await safePost(endpoint.url, body, {
        'Content-Type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body),
        'DURIN-Event-Id': d.event_id,
        'User-Agent': 'DURIN-Webhooks/1.0',
      });
      status = res.status;
      if (res.ok) {
        await this.finish(d.id, 'succeeded', status, null);
        return;
      }
      error = `Endpoint responded ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Delivery failed';
    }

    if (d.attempts >= MAX_ATTEMPTS) {
      await this.finish(d.id, 'failed', status, error);
      return;
    }
    const delay = RETRY_DELAYS_SECONDS[d.attempts - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1]!;
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE webhook_deliveries
         SET next_attempt_at = now() + make_interval(secs => ${delay}),
             last_status = ${status}, last_error = ${error}, updated_at = now()
       WHERE id = ${d.id}::uuid`);
  }

  private async finish(id: string, status: 'succeeded' | 'failed', httpStatus: number | null, error: string | null) {
    await this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        status,
        lastStatus: httpStatus,
        lastError: error,
        deliveredAt: status === 'succeeded' ? new Date() : null,
      },
    });
  }
}
