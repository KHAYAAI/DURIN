import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { REQUEST_CONTEXT_KEY, RequestContext } from '../common/request-context';
import { SCOPES_KEY } from './scopes.decorator';
import { verifyApiKey } from '../common/crypto-keys';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey.startsWith('dk_')) {
      throw new UnauthorizedException('Invalid API key format');
    }

    const prefix = rawKey.slice(0, 12);
    const candidates = await this.prisma.apiKey.findMany({
      where: { keyPrefix: prefix, revokedAt: null },
      take: 5,
    });

    const match = candidates.find((k) => verifyApiKey(rawKey, k.keyHash));
    if (!match) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (match.expiresAt && match.expiresAt < new Date()) {
      throw new UnauthorizedException('API key expired');
    }

    this.prisma.apiKey
      .update({ where: { id: match.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    const ctx: RequestContext = {
      organisationId: match.organisationId,
      apiKeyId: match.id,
      scopes: match.scopes,
    };
    request[REQUEST_CONTEXT_KEY] = ctx;

    const requiredScopes = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredScopes?.length) {
      const hasAll =
        match.scopes.includes('admin') ||
        requiredScopes.every((s) => match.scopes.includes(s));
      if (!hasAll) {
        throw new ForbiddenException('Insufficient scope');
      }
    }

    return true;
  }
}
