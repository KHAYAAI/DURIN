import { SetMetadata } from '@nestjs/common';

export const REQUIRE_MFA_KEY = 'require_mfa';
/** Dashboard users (WorkOS tokens) must hold a fresh, session-bound TOTP verification. API keys are exempt. */
export const RequireMfa = () => SetMetadata(REQUIRE_MFA_KEY, true);
