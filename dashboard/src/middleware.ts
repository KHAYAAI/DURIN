import { NextRequest, NextResponse } from 'next/server';

/**
 * Access gate for the whole dashboard (HTTP Basic). The dashboard renders an organisation's
 * ledger using a server-held API key, so it must never be reachable anonymously.
 *
 *  - DASHBOARD_PASSWORD set     -> credentials required (user: DASHBOARD_USER, default "admin")
 *  - not set, production        -> fail closed (503)
 *  - not set, development       -> open, for local use only
 *
 * This is an interim gate. It is NOT the SSO + MFA login the dashboard auth policy calls for;
 * serve it over HTTPS only and put it behind your identity provider / VPN until that exists.
 */
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function middleware(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Dashboard is not configured: set DASHBOARD_PASSWORD.', { status: 503 });
    }
    return NextResponse.next();
  }

  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      const split = decoded.indexOf(':');
      const user = decoded.slice(0, split);
      const pass = decoded.slice(split + 1);
      const [userOk, passOk] = await Promise.all([
        digest(user).then(async (d) => constantTimeEqual(d, await digest(process.env.DASHBOARD_USER || 'admin'))),
        digest(pass).then(async (d) => constantTimeEqual(d, await digest(password))),
      ]);
      if (userOk && passOk) return NextResponse.next();
    } catch {
      /* fall through to 401 */
    }
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="DURIN dashboard", charset="UTF-8"' },
  });
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
