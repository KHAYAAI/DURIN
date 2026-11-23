import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../common/crypto-secrets';
import { WEBHOOK_EVENT_TYPES } from '../common/webhook-events';
import { assertWebhookUrlAllowed, UnsafeUrlError } from './safe-fetch';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ENDPOINTS_PER_ORG = 20;

@Injectable()
export class WebhooksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organisationId: string, url: string, events: string[]) {
    this.assertEvents(events);
    await this.assertUrl(url);
    const count = await this.prisma.webhookEndpoint.count({ where: { organisationId } });
    if (count >= MAX_ENDPOINTS_PER_ORG) {
      throw new BadRequestException({ code: 'TOO_MANY_ENDPOINTS', message: `At most ${MAX_ENDPOINTS_PER_ORG} webhook endpoints per organisation` });
    }

    const secret = this.newSecret();
    const endpoint = await this.prisma.webhookEndpoint.create({
      data: { organisationId, url, secretEnc: encryptSecret(secret), events, status: 'active' },
    });

    return {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      status: endpoint.status,
      createdAt: endpoint.createdAt,
      /** Shown only once. Use it to verify the DURIN-Signature header. */
      secret,
    };
  }

  async list(organisationId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, url: true, events: true, status: true, createdAt: true, updatedAt: true },
    });
  }

  async rotateSecret(organisationId: string, id: string) {
    const endpoint = await this.find(organisationId, id);
    const secret = this.newSecret();
    await this.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { secretEnc: encryptSecret(secret) } });
    return { id: endpoint.id, secret, note: 'The previous secret no longer verifies new deliveries.' };
  }

  async deliveries(organisationId: string, id: string, limit = 50) {
    const endpoint = await this.find(organisationId, id);
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: endpoint.id, organisationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true, eventId: true, eventType: true, status: true, attempts: true,
        nextAttemptAt: true, lastStatus: true, lastError: true, deliveredAt: true, createdAt: true,
      },
    });
    return rows;
  }

  async remove(organisationId: string, id: string) {
    const ep = await this.find(organisationId, id);
    await this.prisma.webhookEndpoint.delete({ where: { id: ep.id } });
    return { id, deleted: true };
  }

  private async find(organisationId: string, id: string) {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException('Webhook endpoint not found');
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { id, organisationId } });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    return ep;
  }

  private newSecret(): string {
    return `whsec_${randomBytes(24).toString('base64url')}`;
  }

  private assertEvents(events: string[]) {
    const known = new Set<string>([...WEBHOOK_EVENT_TYPES, '*']);
    const unknown = events.filter((e) => !known.has(e));
    if (unknown.length) {
      throw new BadRequestException({ code: 'UNKNOWN_EVENT_TYPE', message: `Unknown event types: ${unknown.join(', ')}` });
    }
  }

  private async assertUrl(url: string) {
    try {
      await assertWebhookUrlAllowed(url);
    } catch (e) {
      throw new BadRequestException({
        code: 'UNSAFE_WEBHOOK_URL',
        message: e instanceof UnsafeUrlError ? e.message : 'Webhook URL could not be validated',
      });
    }
  }
}
