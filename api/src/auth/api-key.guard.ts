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
import { keyPrefixOf, verifyApiKey } from '../common/crypto-keys';
import { isSandboxMode } from '../common/sandbox';
import { WorkosAuthService } from './workos-auth.service';
import { MfaService } from './mfa.service';
import { REQUIRE_MFA_KEY } from './mfa.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly workos: WorkosAuthService,
    private readonly mfa: MfaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (WorkosAuthService.looksLikeJwt(rawKey) && rawKey.length <= 8192) {
      return this.authenticateUser(context, request, rawKey);
    }
    // Environment separation: test keys only work in sandbox mode, live keys only outside it.
    const expectedPrefix = isSandboxMode() ? 'dk_test_' : 'dk_live_';
    if (!rawKey.startsWith(expectedPrefix) || rawKey.length > 128) {
      throw new UnauthorizedException('Invalid API key');
    }

    const prefix = keyPrefixOf(rawKey);
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
      authMethod: 'api_key',
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

  /** Dashboard user: a WorkOS AuthKit access token mapped to a DURIN organisation. */
  private async authenticateUser(context: ExecutionContext, request: Record<string, unknown>, token: string): Promise<boolean> {
    const principal = await this.workos.verify(token);
    const org = await this.prisma.organisation.findUnique({ where: { workosOrganizationId: principal.workosOrganizationId } });
    if (!org || org.status !== 'active') throw new ForbiddenException('No active DURIN organisation for this WorkOS organization');

    const ctx: RequestContext = {
      organisationId: org.id,
      apiKeyId: `user:${principal.userId}`,
      scopes: principal.scopes,
      authMethod: 'workos',
      userId: principal.userId,
      sessionId: principal.sessionId,
    };
    request[REQUEST_CONTEXT_KEY] = ctx;

    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, targets);
    if (required?.length && !(ctx.scopes.includes('admin') || required.every((s) => ctx.scopes.includes(s)))) {
      throw new ForbiddenException('Insufficient scope');
    }
    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_MFA_KEY, targets)) {
      const v = await this.mfa.latestVerification(principal.userId, principal.sessionId);
      if (!v) {
        throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Complete MFA (POST /v1/auth/mfa/challenge then /verify) before this action.' });
      }
    }
    return true;
  }
}
