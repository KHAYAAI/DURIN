/** Available API key scopes */
export const SCOPES = {
  ORGANISATIONS_READ: 'organisations:read',
  API_KEYS_WRITE: 'api_keys:write',
  API_KEYS_READ: 'api_keys:read',
  WEBHOOKS_WRITE: 'webhooks:write',
  WEBHOOKS_READ: 'webhooks:read',
  PAYMENTS_READ: 'payments:read',
  PAYMENTS_WRITE: 'payments:write',
  CONVERSIONS_READ: 'conversions:read',
  CONVERSIONS_WRITE: 'conversions:write',
  WALLETS_READ: 'wallets:read',
  WALLETS_WRITE: 'wallets:write',
  LEDGER_READ: 'ledger:read',
  LEDGER_WRITE: 'ledger:write',
  COMPLIANCE_READ: 'compliance:read',
  COMPLIANCE_WRITE: 'compliance:write',
  ADMIN: 'admin',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** Default scopes for newly created API keys. `admin` is never a default. */
export const DEFAULT_SCOPES: Scope[] = [
  SCOPES.ORGANISATIONS_READ,
  SCOPES.API_KEYS_READ,
  SCOPES.API_KEYS_WRITE,
  SCOPES.WEBHOOKS_READ,
  SCOPES.WEBHOOKS_WRITE,
  SCOPES.LEDGER_READ,
  SCOPES.LEDGER_WRITE,
  SCOPES.PAYMENTS_READ,
  SCOPES.PAYMENTS_WRITE,
  SCOPES.CONVERSIONS_READ,
  SCOPES.CONVERSIONS_WRITE,
  SCOPES.WALLETS_READ,
  SCOPES.WALLETS_WRITE,
  SCOPES.COMPLIANCE_READ,
  SCOPES.COMPLIANCE_WRITE,
];

/** Sandbox bootstrap keys also get admin so the whole API can be exercised end to end. */
export const SANDBOX_BOOTSTRAP_SCOPES: Scope[] = [...DEFAULT_SCOPES, SCOPES.ADMIN];

export const ALL_SCOPES: ReadonlySet<string> = new Set(Object.values(SCOPES));
