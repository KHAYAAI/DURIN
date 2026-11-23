import { ForbiddenException } from '@nestjs/common';

/**
 * Sandbox behaviour (simulated deposits, auto-funding, sandbox FX) is only allowed outside
 * production. `ALLOW_SANDBOX_IN_PRODUCTION=true` is an explicit, logged override for staging.
 */
export function isSandboxMode(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.ALLOW_SANDBOX_IN_PRODUCTION === 'true';
}

/** Fail closed: simulated money movement must never run against a production environment. */
export function assertSandboxOnly(feature: string): void {
  if (!isSandboxMode()) {
    throw new ForbiddenException({
      code: 'AWAITING_REGULATORY_APPROVAL',
      message: `${feature} is simulated and unavailable in production. Live operation is awaiting regulatory approval (gate G1) and live provider adapters.`,
    });
  }
}
