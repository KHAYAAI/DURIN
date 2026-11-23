import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WebhookDeliveryService {
  private readonly log = new Logger(WebhookDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deliver event to all active endpoints subscribed to the event type.
   * Retries: 3 attempts with backoff. Status: implemented for sandbox.
   */
  async publish(organisationId: string, eventType: string, payload: unknown) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { organisationId, status: 'active' },
    });
    const targets = endpoints.filter(
      (e) => e.events.length === 0 || e.events.includes(eventType) || e.events.includes('*'),
    );

    const body = JSON.stringify({
      id: `evt_${Date.now()}`,
      type: eventType,
      created: new Date().toISOString(),
      data: payload,
      livemode: false,
    });

    const results = [];
    for (const ep of targets) {
      const result = await this.deliverWithRetry(ep.url, body, ep.secretHash);
      results.push({ endpointId: ep.id, url: ep.url, ...result });
    }
    return results;
  }

  private async deliverWithRetry(url: string, body: string, secretHash: string) {
    // Signature uses secret hash as key material in sandbox only — live uses stored secret
    const sig = createHmac('sha256', secretHash).update(body).digest('hex');
    const attempts = [0, 200, 500];
    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i]) await new Promise((r) => setTimeout(r, attempts[i]));
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'DURIN-Signature': sig,
            'DURIN-Event': 'true',
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return { ok: true, status: res.status, attempts: i + 1 };
        this.log.warn(`Webhook ${url} status ${res.status}`);
      } catch (e) {
        this.log.warn(`Webhook ${url} error: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { ok: false, status: 0, attempts: attempts.length };
  }
}
