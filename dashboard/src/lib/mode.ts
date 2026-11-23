import 'server-only';

/** Environment banner derived from the API's own /health, never assumed. */
export async function getMode(): Promise<'sandbox' | 'live'> {
  try {
    const base = (process.env.DURIN_API_URL || 'http://localhost:3000/v1').replace(/\/v1\/?$/, '');
    const res = await fetch(`${base}/health`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const j = (await res.json()) as { mode?: string };
    return j.mode === 'production' ? 'live' : 'sandbox';
  } catch {
    return 'sandbox';
  }
}
