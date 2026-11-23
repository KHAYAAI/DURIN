import { WorkOS } from '@workos-inc/node';

export const WORKOS_PORT = Symbol('WORKOS_PORT');
export const WORKOS_KEYS = Symbol('WORKOS_KEYS');

/** The slice of WorkOS that DURIN uses, behind a port so it can be faked in tests. */
export interface WorkosPort {
  readonly configured: boolean;
  listTotpFactorIds(userId: string): Promise<string[]>;
  enrollTotp(userId: string): Promise<{ factorId: string; qrCode?: string; secret?: string; uri?: string }>;
  challenge(factorId: string): Promise<{ challengeId: string; expiresAt?: Date }>;
  verify(challengeId: string, code: string): Promise<boolean>;
  portalLink(workosOrganizationId: string, intent: 'sso' | 'dsync', returnUrl?: string): Promise<string>;
}

export class RealWorkosPort implements WorkosPort {
  private readonly client?: WorkOS;
  readonly configured: boolean;

  constructor() {
    const apiKey = process.env.WORKOS_API_KEY;
    const clientId = process.env.WORKOS_CLIENT_ID;
    this.configured = !!apiKey && !!clientId;
    if (this.configured) this.client = new WorkOS(apiKey, { clientId });
  }

  private get c(): WorkOS {
    if (!this.client) throw new Error('WorkOS is not configured (WORKOS_API_KEY / WORKOS_CLIENT_ID)');
    return this.client;
  }

  async listTotpFactorIds(userId: string) {
    const page = await this.c.multiFactorAuth.listUserAuthFactors({ userId });
    return page.data.filter((f) => f.type === 'totp').map((f) => f.id);
  }

  async enrollTotp(userId: string) {
    const { authenticationFactor } = await this.c.multiFactorAuth.createUserAuthFactor({
      userId, type: 'totp', totpIssuer: process.env.WORKOS_TOTP_ISSUER || 'DURIN', totpUser: userId,
    });
    const totp = authenticationFactor.totp;
    return { factorId: authenticationFactor.id, qrCode: totp?.qrCode, secret: totp?.secret, uri: totp?.uri };
  }

  async challenge(factorId: string) {
    const ch = await this.c.multiFactorAuth.challengeFactor({ authenticationFactorId: factorId });
    return { challengeId: ch.id, expiresAt: ch.expiresAt };
  }

  async verify(challengeId: string, code: string) {
    const r = await this.c.multiFactorAuth.verifyChallenge({ authenticationChallengeId: challengeId, code });
    return r.valid === true;
  }

  async portalLink(workosOrganizationId: string, intent: 'sso' | 'dsync', returnUrl?: string) {
    const r = await this.c.adminPortal.generateLink({ organization: workosOrganizationId, intent, returnUrl });
    return r.link;
  }
}
