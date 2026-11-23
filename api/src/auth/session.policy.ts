/**
 * Dashboard session / MFA policy (engineering standard for high auth readiness).
 *
 * API access: bearer API keys (scrypt-hashed).
 * Dashboard access (when UI login is enabled):
 *  - Email + password (argon2id / scrypt) OR SSO (OIDC)
 *  - MFA required for: api_keys:write, compliance approvals, withdrawals above limit
 *  - Session TTL 8h, absolute 24h; rotate on privilege elevation
 *
 * Status: policy encoded; full SSO/MFA UI is dashboard-side (NextAuth/Auth.js recommended).
 */
export const DASHBOARD_AUTH_POLICY = {
  sessionTtlHours: 8,
  absoluteTtlHours: 24,
  mfaRequiredActions: [
    'api_keys:write',
    'compliance:write',
    'wallets:write',
    'admin',
  ],
  passwordHashing: 'scrypt-or-argon2id',
  sso: 'oidc-optional',
} as const;
