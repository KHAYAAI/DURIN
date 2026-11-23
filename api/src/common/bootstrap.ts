import { ForbiddenException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Organisation creation is an operator action. If BOOTSTRAP_TOKEN is set, the caller must send it
 * in `X-Bootstrap-Token`. In production a token is mandatory; without one creation is disabled.
 * Outside production and without a token, creation is open for local development.
 */
export function assertBootstrapAllowed(provided?: string): void {
  const required = process.env.BOOTSTRAP_TOKEN;
  if (!required) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException({ code: 'BOOTSTRAP_DISABLED', message: 'Organisation creation is disabled' });
    }
    return;
  }
  const digest = (v: string) => createHash('sha256').update(v).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(required))) {
    throw new ForbiddenException({ code: 'BOOTSTRAP_FORBIDDEN', message: 'Invalid bootstrap token' });
  }
}
