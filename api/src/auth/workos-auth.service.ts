import { Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { WORKOS_KEYS } from './workos.port';
import { ALL_SCOPES, DEFAULT_SCOPES, SCOPES } from '../common/scopes';

export interface WorkosPrincipal {
  userId: string;
  sessionId: string;
  workosOrganizationId: string;
  role?: string;
  scopes: string[];
  authTime?: number;
}

export function workosJwksProvider(): JWTVerifyGetKey | undefined {
  const url = process.env.WORKOS_JWKS_URL ?? (process.env.WORKOS_CLIENT_ID ? `https://api.workos.com/sso/jwks/${process.env.WORKOS_CLIENT_ID}` : undefined);
  return url ? createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cooldownDuration: 30_000 }) : undefined;
}

/** Maps a WorkOS role/permissions to DURIN scopes. `admin` is granted only by the `admin` role. */
export function scopesFromClaims(role: string | undefined, permissions: unknown): string[] {
  if (role === 'admin') return [...DEFAULT_SCOPES, SCOPES.ADMIN, SCOPES.CONVERSIONS_RESOLVE, SCOPES.RECONCILIATION_READ, SCOPES.RECONCILIATION_WRITE];
  const perms = Array.isArray(permissions) ? permissions.filter((p): p is string => typeof p === 'string') : [];
  return perms.filter((p) => ALL_SCOPES.has(p) && p !== SCOPES.ADMIN);
}

/** Verifies AuthKit access tokens (signature via JWKS, issuer, expiry). No audience claim is issued. */
@Injectable()
export class WorkosAuthService {
  constructor(@Optional() @Inject(WORKOS_KEYS) private readonly keys?: JWTVerifyGetKey) {}

  get enabled(): boolean {
    return !!this.keys;
  }

  static looksLikeJwt(token: string): boolean {
    return token.split('.').length === 3 && !token.startsWith('dk_');
  }

  async verify(token: string): Promise<WorkosPrincipal> {
    if (!this.keys) throw new UnauthorizedException('Token authentication is not enabled');
    const clientId = process.env.WORKOS_CLIENT_ID;
    const issuers = (process.env.WORKOS_ISSUERS?.split(',').map((s) => s.trim()).filter(Boolean)) ?? [
      'https://api.workos.com/',
      ...(clientId ? [`https://api.workos.com/user_management/${clientId}`] : []),
    ];
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, { issuer: issuers, algorithms: ['RS256'], clockTolerance: 5 }));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const userId = payload.sub;
    const sid = payload['sid'];
    const orgId = payload['org_id'];
    if (typeof userId !== 'string' || typeof sid !== 'string') throw new UnauthorizedException('Invalid token claims');
    if (typeof orgId !== 'string') throw new UnauthorizedException('Token has no organization; sign in to an organization');
    const role = typeof payload['role'] === 'string' ? (payload['role'] as string) : undefined;
    return {
      userId, sessionId: sid, workosOrganizationId: orgId, role,
      scopes: scopesFromClaims(role, payload['permissions']),
      authTime: typeof payload['auth_time'] === 'number' ? (payload['auth_time'] as number) : undefined,
    };
  }
}
