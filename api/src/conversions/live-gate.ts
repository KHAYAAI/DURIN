import { ForbiddenException } from '@nestjs/common';
import { isSandboxMode } from '../common/sandbox';

/**
 * Gate G1 (regulatory approval for live conversion). In production a conversion is refused
 * unless an operator has explicitly set CONVERSION_LIVE_ENABLED=true AFTER counsel sign-off.
 * The flag is deliberately separate from NODE_ENV so deploying to production never enables it.
 */
export function assertConversionAllowed(adapterMode: 'sandbox' | 'live'): void {
  if (isSandboxMode()) return;
  if (process.env.CONVERSION_LIVE_ENABLED !== 'true') {
    throw new ForbiddenException({
      code: 'AWAITING_REGULATORY_APPROVAL',
      message: 'Live conversion is disabled until gate G1 (counsel sign-off) is recorded by setting CONVERSION_LIVE_ENABLED=true.',
    });
  }
  if (adapterMode !== 'live') {
    throw new ForbiddenException({
      code: 'LIVE_PROVIDER_REQUIRED',
      message: 'Live conversion requires a live liquidity adapter.',
    });
  }
}
