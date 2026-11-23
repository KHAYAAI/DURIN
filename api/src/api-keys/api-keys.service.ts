import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_SCOPES } from '../common/scopes';
import { generateApiKeySecret, hashApiKey, keyPrefixOf } from '../common/crypto-keys';

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organisationId: string, name: string, scopes?: string[]) {
    const secret = generateApiKeySecret('test');
    const keyPrefix = keyPrefixOf(secret);
    const keyHash = hashApiKey(secret);
    const resolvedScopes = scopes?.length ? scopes : [...DEFAULT_SCOPES];

    const record = await this.prisma.apiKey.create({
      data: {
        organisationId,
        name,
        keyPrefix,
        keyHash,
        scopes: resolvedScopes,
      },
    });

    return {
      id: record.id,
      name: record.name,
      keyPrefix: record.keyPrefix,
      scopes: record.scopes,
      createdAt: record.createdAt,
      secret,
      hashing: 'scrypt' as const,
    };
  }

  async list(organisationId: string) {
    return this.prisma.apiKey.findMany({
      where: { organisationId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  async revoke(organisationId: string, keyId: string) {
    const key = await this.prisma.apiKey.findFirst({
      where: { id: keyId, organisationId, revokedAt: null },
    });
    if (!key) throw new NotFoundException('API key not found');
    await this.prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
    return { id: keyId, revoked: true };
  }
}
