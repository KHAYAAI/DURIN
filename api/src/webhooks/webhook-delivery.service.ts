import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Queues webhook events. This is the only thing request handlers do: it inserts rows into the
 * durable `webhook_deliveries` table. The WebhookWorker performs the HTTP calls, so a slow or
 * failing customer endpoint can never block or fail an API request.
 *
 * Note: events are queued after the originating transaction commits, so a crash between the
 * commit and this insert can drop an event. State is always recoverable from the API.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly log = new Logger(WebhookDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Never throws: a webhook problem must not fail the API request that caused the event. */
  async publish(organisationId: string, eventType: string, payload: unknown): Promise<void> {
    try {
      await this.enqueue(organisationId, eventType, payload);
    } catch (e) {
      this.log.error(`Failed to queue ${eventType}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async enqueue(organisationId: string, eventType: string, payload: unknown): Promise<void> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { organisationId, status: 'active' },
      select: { id: true, events: true },
    });
    const targets = endpoints.filter(
      (e) => e.events.length === 0 || e.events.includes(eventType) || e.events.includes('*'),
    );
    if (!targets.length) return;

    const eventId = `evt_${randomUUID()}`;
    await this.prisma.webhookDelivery.createMany({
      data: targets.map((endpoint) => ({
        organisationId,
        endpointId: endpoint.id,
        eventId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }
}
