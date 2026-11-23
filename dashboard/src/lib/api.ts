import 'server-only';

/**
 * Server-side DURIN API client. `server-only` makes the build fail if this module is ever
 * imported into browser code, so the API key can never be shipped to the client.
 *
 * Configure with DURIN_API_URL and DURIN_API_KEY (deliberately NOT NEXT_PUBLIC_*, which Next.js
 * inlines into browser bundles). Use a key with read-only scopes
 * (organisations:read payments:read conversions:read wallets:read compliance:read).
 */
const BASE = process.env.DURIN_API_URL || 'http://localhost:3000/v1';
const KEY = process.env.DURIN_API_KEY || '';

export async function durinFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}${path.startsWith('/') ? path : `/${path}`}`, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Do not echo response bodies into the UI: they may contain internals.
    throw new Error(`API responded ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function isConfigured() {
  return Boolean(KEY);
}

export function apiBase() {
  return BASE;
}
