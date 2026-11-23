import { durinFetch, isConfigured } from '@/lib/api';

export default async function OverviewPage() {
  let accounts: unknown[] = [];
  let payments: unknown[] = [];
  let conversions: unknown[] = [];
  let approvals: unknown[] = [];
  let error: string | null = null;

  if (isConfigured()) {
    try {
      // Failures are surfaced, never turned into zeros: an outage must not look like an empty ledger.
      const results = await Promise.allSettled([
        durinFetch<unknown[]>('/accounts'),
        durinFetch<unknown[]>('/payment_intents'),
        durinFetch<unknown[]>('/conversions'),
        durinFetch<unknown[]>('/compliance/approvals'),
      ]);
      const list = (r: PromiseSettledResult<unknown[]>) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []);
      accounts = list(results[0]);
      payments = list(results[1]);
      conversions = list(results[2]);
      approvals = list(results[3]);
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      if (failed.length) error = `${failed.length} of 4 requests failed (${failed[0]!.reason instanceof Error ? failed[0]!.reason.message : 'unknown error'})`;
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
          Set <code>DURIN_API_URL</code> (e.g. http://localhost:3000/v1) and{' '}
          <code>DURIN_API_KEY</code> to load live sandbox data.
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
