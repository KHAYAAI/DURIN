import 'server-only';

/**
 * Dashboard authentication is WorkOS AuthKit (SSO + MFA). Configure ALL of:
 *   WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD (>= 32 chars), NEXT_PUBLIC_WORKOS_REDIRECT_URI
 * In production the dashboard refuses to serve without them (see middleware.ts).
 */
export function workosConfigured(): boolean {
  return Boolean(
    process.env.WORKOS_API_KEY &&
      process.env.WORKOS_CLIENT_ID &&
      (process.env.WORKOS_COOKIE_PASSWORD ?? '').length >= 32 &&
      process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
  );
}
