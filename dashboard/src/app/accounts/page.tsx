import { durinFetch, isConfigured, apiBase } from '@/lib/api';

export default async function Page() {
  let rows: Record<string, unknown>[] = [];
  let error: string | null = null;
  if (isConfigured()) {
    try {
      const data = await durinFetch<unknown>('/accounts');
      rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'load failed';
    }
  }
  const fields = ['id', 'code', 'name', 'accountType', 'assetCode'];
  return (
    <div>
      <h1>Accounts</h1>
      <p className="sub">Source: {apiBase()}/accounts</p>
      {!isConfigured() && (
        <div className="note">Set NEXT_PUBLIC_DURIN_API_KEY and NEXT_PUBLIC_DURIN_API_URL to load data.</div>
      )}
      {error && <div className="note">Error: {error}</div>}
      {isConfigured() && !error && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table>
            <thead>
              <tr>{fields.map((f) => <th key={f}>{f}</th>)}</tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={fields.length} className="muted">No rows</td></tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={i}>
                    {fields.map((f) => (
                      <td key={f}>{String(Array.isArray(r[f]) ? (r[f] as string[]).join(', ') : r[f] ?? '—')}</td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
