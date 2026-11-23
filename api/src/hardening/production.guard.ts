import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Fail closed at startup in production: refuse to boot with sandbox adapters bound, missing
 * secrets, or dangerous development flags. Every problem is reported at once.
 */
@Injectable()
export class ProductionSafety implements OnModuleInit {
  private readonly log = new Logger('ProductionSafety');

  onModuleInit() {
    if (process.env.NODE_ENV !== 'production') {
      this.log.log('Non-production mode — sandbox adapters, simulated endpoints and dev defaults allowed');
      return;
    }

    const errors: string[] = [];
    const override = process.env.ALLOW_SANDBOX_IN_PRODUCTION === 'true';

    if (!process.env.DATABASE_URL) errors.push('DATABASE_URL is required');

    const encryptionKey = process.env.DURIN_ENCRYPTION_KEY;
    if (!encryptionKey || Buffer.from(encryptionKey, 'base64').length !== 32) {
      errors.push('DURIN_ENCRYPTION_KEY must be set to 32 random bytes, base64-encoded');
    }
    if ((process.env.BOOTSTRAP_TOKEN ?? '').length < 24) {
      errors.push('BOOTSTRAP_TOKEN must be set (at least 24 characters) to gate organisation creation');
    }
    if (process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true') {
      this.log.warn('ALLOW_PRIVATE_WEBHOOK_TARGETS is ignored in production');
    }

    // Identity: KYC/KYB must come from Didit, and the webhook must be authenticable.
    if (process.env.VERIFICATION_PROVIDER !== 'didit') errors.push('VERIFICATION_PROVIDER must be "didit" in production');
    else {
      if (!process.env.DIDIT_API_KEY) errors.push('DIDIT_API_KEY is required');
      if (!process.env.DIDIT_WEBHOOK_SECRET) errors.push('DIDIT_WEBHOOK_SECRET is required');
      if (!process.env.DIDIT_WORKFLOW_KYB || !process.env.DIDIT_WORKFLOW_KYC) errors.push('DIDIT_WORKFLOW_KYB and DIDIT_WORKFLOW_KYC are required');
    }
    // Dashboard users authenticate with WorkOS tokens; the API must be able to verify them.
    if (!process.env.WORKOS_CLIENT_ID) errors.push('WORKOS_CLIENT_ID is required (verifies dashboard tokens)');
    if (!process.env.WORKOS_API_KEY) errors.push('WORKOS_API_KEY is required (MFA challenges, SSO portal links)');
    if (process.env.CONVERSION_LIVE_ENABLED === 'true') {
      this.log.warn('CONVERSION_LIVE_ENABLED=true — gate G1 asserted by operator; ensure counsel sign-off is recorded');
    }

    if (override) {
      this.log.warn('ALLOW_SANDBOX_IN_PRODUCTION=true — sandbox override engaged (dangerous; staging only)');
    } else {
      if ((process.env.LAYER1_ADAPTER || 'sandbox') === 'sandbox') errors.push('LAYER1_ADAPTER must not be sandbox in production');
      if ((process.env.LAYER2_ADAPTER || 'sandbox') === 'sandbox') errors.push('LAYER2_ADAPTER must not be sandbox in production');
      if ((process.env.LIQUIDITY_ADAPTER || 'sandbox') === 'sandbox') errors.push('LIQUIDITY_ADAPTER must not be sandbox in production');
    }

    if (errors.length) {
      this.log.error(errors.join('; '));
      throw new Error(`Production safety check failed: ${errors.join('; ')}`);
    }
    this.log.log('Production safety checks passed');
  }
}
