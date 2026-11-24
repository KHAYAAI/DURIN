import { load, list } from '@/lib/data';
import { ago, money, sumDec } from '@/lib/format';
import { PageHead, Panel, ErrorNote, Banner, Kpi, Pill, Bar } from '@/components/ui';
import { DataGrid } from '@/components/DataGrid';

export const dynamic = 'force-dynamic';
interface Run { status: string; source: 'simulated' | 'live'; checkedAt: string; note?: string; summary: { assets: Array<Record<string, string>>; ledgerIntegrityHealthy: boolean; unresolvedProviderOutcomes: number }; breaks: Array<{ id: string; kind: string; assetCode: string; custodian: string; ledgerAmount: string; reportedAmount: string | null; delta: string | null; status: string; note: string | null }> }

export default async function Reconciliation() {
  const [r, b] = await Promise.all([load<Run | null>('/reconciliation/runs/latest'), load<Run['breaks']>('/reconciliation/breaks?status=open')]);
  const run = r.data; const open = list<Run['breaks'][number]>(b);
  const ratio = (x: Record<string, string>) => { const owed = Number(x.customer) + Number(x.inTransit); const back = Number(x.reportedCustody) + Number(x.lpClearing); return owed === 0 ? 100 : (back / owed) * 100; };
  return (
    <>
      <PageHead title="Reconciliation" sub="The ledger's custody mirror compared with what each custodian itself reports. A break is evidence, never something to net away." />
      <ErrorNote message={r.error} />
      {run?.source === 'simulated' && <Banner kind="sandbox"><b>SIMULATED</b> Compared against simulated custodian balances. A clean result here is not evidence of real custody.</Banner>}
      {!run && !r.error && <Banner kind="sandbox">No reconciliation has run yet. Run one with <code>POST /v1/reconciliation/runs</code>.</Banner>}
      {run && (
        <>
          <div className="grid g4" style={{ marginBottom: 12 }}>
            <Kpi label="Status" value={run.status} tone={run.status === 'clean' ? 'ok' : 'alert'} sub={`checked ${ago(run.checkedAt)}`} />
            <Kpi label="Open breaks" value={open.length} tone={open.length ? 'alert' : 'ok'} />
            <Kpi label="Ledger integrity" value={run.summary.ledgerIntegrityHealthy ? 'healthy' : 'DRIFT'} tone={run.summary.ledgerIntegrityHealthy ? 'ok' : 'alert'} sub="balances re-derived from journal lines" />
            <Kpi label="Unresolved outcomes" value={run.summary.unresolvedProviderOutcomes} tone={run.summary.unresolvedProviderOutcomes ? 'alert' : 'ok'} />
          </div>
          <Panel title="Custody coverage by asset" count={run.summary.assets.length} flush>
            <table className="grid-t"><thead><tr><th>Asset</th><th>Custodian</th><th className="r">Ledger custody</th><th className="r">Reported custody</th><th className="r">Customers + in transit</th><th style={{ width: 160 }}>Coverage</th><th>Match</th></tr></thead>
              <tbody>{run.summary.assets.length === 0 ? <tr><td colSpan={7} className="empty">No custody accounts yet</td></tr> : run.summary.assets.map((x) => {
                const c = ratio(x); const match = x.ledgerCustody === x.reportedCustody;
                return <tr key={x.assetCode! + x.custodian}><td><span className="tag asset">{x.assetCode}</span></td><td className="dim">{x.custodian}</td><td className="num">{money(x.ledgerCustody)}</td><td className="num">{money(x.reportedCustody)}</td><td className="num">{money(sumDec([x.customer, x.inTransit]))}</td>
                  <td><Bar value={Math.min(100, c)} tone={c >= 100 ? 'green' : 'red'} /></td><td><Pill tone={match ? 'green' : 'red'}>{match ? 'matches' : 'differs'}</Pill></td></tr>;
              })}</tbody></table>
          </Panel>
        </>
      )}
      <div style={{ height: 12 }} />
      <Panel title="Open breaks" count={open.length} flush>
        <DataGrid empty="No open breaks" search={false} cols={[
          { key: 'kind', label: 'Kind', kind: 'pill', tones: { custody_mismatch: 'red', insolvent: 'red', provider_error: 'amber' } }, { key: 'asset', label: 'Asset', kind: 'asset' }, { key: 'custodian', label: 'Custodian' },
          { key: 'ledger', label: 'Ledger', align: 'r' }, { key: 'reported', label: 'Reported', align: 'r' }, { key: 'delta', label: 'Delta', align: 'r' }, { key: 'note', label: 'Note' },
        ]} rows={open.map((x) => ({ kind: x.kind, asset: x.assetCode, custodian: x.custodian, ledger: money(x.ledgerAmount), reported: money(x.reportedAmount), delta: money(x.delta), note: x.note }))} />
      </Panel>
    </>
  );
}
