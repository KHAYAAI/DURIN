import { durinFetch, isConfigured } from '@/lib/api';

export default async function OverviewPage() {
  let accounts: unknown[] = [];
  let payments: unknown[] = [];
  let conversions: unknown[] = [];
  let approvals: unknown[] = [];
  let error: string | null = null;

  if (isConfigured()) {
    try {
      const [a, p, c, ap] = await Promise.all([
        durinFetch<unknown[]>('/accounts').catch(() => []),
        durinFetch<unknown[]>('/payment_intents').catch(() => []),
        durinFetch<unknown[]>('/conversions').catch(() => []),
        durinFetch<unknown[]>('/compliance/approvals').catch(() => []),
      ]);
      accounts = Array.isArray(a) ? a : [];
      payments = Array.isArray(p) ? p : [];
      conversions = Array.isArray(c) ? c : [];
      approvals = Array.isArray(ap) ? ap : [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load';
    }
  }

  return (
    <div>
      <h1>Overview</h1>
      <p className="sub">Institutional control plane — sandbox environment</p>
      <div className="grid">
        <div className="card">
          <div className="label">Ledger accounts</div>
          <div className="value">{isConfigured() ? accounts.length : '—'}</div>
        </div>
        <div className="card">
          <div className="label">Payment intents</div>
          <div className="value">{isConfigured() ? payments.length : '—'}</div>
        </div>
        <div className="card">
          <div className="label">Conversions</div>
          <div className="value">{isConfigured() ? conversions.length : '—'}</div>
        </div>
        <div className="card">
          <div className="label">Pending approvals</div>
          <div className="value">
            {isConfigured()
              ? (approvals as { status?: string }[]).filter((x) => x.status === 'pending').length
              : '—'}
          </div>
        </div>
      </div>
      {!isConfigured() && (
        <div className="note">
          Set <code>NEXT_PUBLIC_DURIN_API_URL</code> (e.g. http://localhost:3000/v1) and{' '}
          <code>NEXT_PUBLIC_DURIN_API_KEY</code> to load live sandbox data.
        </div>
      )}
      {error && <div className="note">API error: {error}</div>}
      {isConfigured() && !error && (
        <div className="note">
          <span className="badge">Connected</span> Data loaded from DURIN API (sandbox).
        </div>
      )}
    </div>
  );
}
