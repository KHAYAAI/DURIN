import { NextRequest, NextResponse } from 'next/server';
import { authkitMiddleware } from '@workos-inc/authkit-nextjs';

/**
 * Every page requires a WorkOS AuthKit session (SSO or password, MFA per the WorkOS environment).
 * The dashboard renders an organisation's ledger, so it must never be reachable anonymously:
 *  - WorkOS configured            -> sign-in required for everything except /callback
 *  - not configured, production   -> fail closed (503)
 *  - not configured, development  -> open, local use only (uses DURIN_API_KEY)
 */
const configured = Boolean(
  process.env.WORKOS_API_KEY &&
    process.env.WORKOS_CLIENT_ID &&
    (process.env.WORKOS_COOKIE_PASSWORD ?? '').length >= 32 &&
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
);

const guarded = configured
  ? authkitMiddleware({
      middlewareAuth: { enabled: true, unauthenticatedPaths: ['/callback'] },
      redirectUri: process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    })
  : null;

export default async function middleware(req: NextRequest, ...rest: unknown[]) {
  if (guarded) return (guarded as unknown as (r: NextRequest, ...a: unknown[]) => Promise<NextResponse>)(req, ...rest);
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Dashboard is not configured: set the WORKOS_* environment variables.', { status: 503 });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
