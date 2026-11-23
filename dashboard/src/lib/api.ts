const BASE = process.env.NEXT_PUBLIC_DURIN_API_URL || 'http://localhost:3000/v1';
const KEY = process.env.NEXT_PUBLIC_DURIN_API_KEY || '';

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
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export function isConfigured() {
  return Boolean(KEY);
}

export function apiBase() {
  return BASE;
}
