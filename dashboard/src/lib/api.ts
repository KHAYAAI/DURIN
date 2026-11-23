import 'server-only';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { workosConfigured } from './auth';

/**
 * Server-side DURIN API client. `server-only` makes the build fail if this module is ever
 * imported into browser code.
 *
 * With WorkOS configured, calls are made AS THE SIGNED-IN USER: their AuthKit access token is the
 * bearer credential, so the API enforces that user's organisation, role-derived scopes and MFA
 * step-up. No long-lived API key is held by the dashboard. Without WorkOS (local development
 * only) it falls back to DURIN_API_KEY.
 */
const BASE = process.env.DURIN_API_URL || 'http://localhost:3000/v1';
const DEV_KEY = process.env.DURIN_API_KEY || '';

async function bearer(): Promise<string | null> {
  if (workosConfigured()) {
    const { accessToken } = await withAuth({ ensureSignedIn: true });
    return accessToken;
  }
  return process.env.NODE_ENV === 'production' ? null : DEV_KEY || null;
}

export class ApiError extends Error {
  constructor(public status: number, public code?: string) {
    super(`API responded ${status}${code ? ` (${code})` : ''}`);
  }
}

export async function durinFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = await bearer();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path.startsWith('/') ? path : `/${path}`}`, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Only the machine-readable code is surfaced; response bodies may contain internals.
    let code: string | undefined;
    try {
      const j = (await res.json()) as { code?: string; message?: { code?: string } | string };
      code = j.code ?? (typeof j.message === 'object' ? j.message?.code : undefined);
    } catch { /* ignore */ }
    throw new ApiError(res.status, code);
  }
  return res.json() as Promise<T>;
}

export function isConfigured() {
  return workosConfigured() || Boolean(DEV_KEY);
}

export function apiBase() {
  return BASE;
}
