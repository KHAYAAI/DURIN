import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WebhooksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organisationId: string, url: string, events: string[]) {
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const secretHash = createHash('sha256').update(secret).digest('hex');

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        organisationId,
        url,
        secretHash,
        events,
        status: 'active',
      },
    });

    return {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      status: endpoint.status,
      createdAt: endpoint.createdAt,
      /** Shown only on creation — used to verify DURIN-Signature */
      secret,
      deliveryStatus: 'simulated' as const,
      note: 'Webhook delivery worker is not yet implemented; endpoint is stored only.',
    };
  }

  async list(organisationId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        url: true,
        events: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async remove(organisationId: string, id: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({
      where: { id, organisationId },
    });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    return { id, deleted: true };
  }
}
