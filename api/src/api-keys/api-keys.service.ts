import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_SCOPES, DEFAULT_SCOPES, SCOPES } from '../common/scopes';
import { isSandboxMode } from '../common/sandbox';
import { generateApiKeySecret, hashApiKey, keyPrefixOf } from '../common/crypto-keys';

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `grantorScopes` are the scopes of the key making the request. A key can only grant scopes it
   * holds itself, and only an admin key can grant `admin` (no privilege escalation). Omit it for
   * trusted internal callers such as organisation bootstrap.
   */
  async create(organisationId: string, name: string, scopes?: string[], grantorScopes?: string[]) {
    const resolvedScopes = scopes?.length ? [...new Set(scopes)] : [...DEFAULT_SCOPES];
    const unknown = resolvedScopes.filter((s) => !ALL_SCOPES.has(s));
    if (unknown.length) {
      throw new BadRequestException({ code: 'UNKNOWN_SCOPE', message: `Unknown scopes: ${unknown.join(', ')}` });
    }
    if (grantorScopes && !grantorScopes.includes(SCOPES.ADMIN)) {
      const notHeld = resolvedScopes.filter((s) => !grantorScopes.includes(s));
      if (notHeld.length) {
        throw new ForbiddenException({ code: 'SCOPE_ESCALATION', message: `Cannot grant scopes you do not hold: ${notHeld.join(', ')}` });
      }
    }

    const secret = generateApiKeySecret(isSandboxMode() ? 'test' : 'live');
    const keyPrefix = keyPrefixOf(secret);
    const keyHash = hashApiKey(secret);

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
    if (!/^[0-9a-f-]{36}$/i.test(keyId)) throw new NotFoundException('API key not found');
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
