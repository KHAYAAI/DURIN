import { load, list } from '@/lib/data';
import { clock, money, roleOf, short, sumDec } from '@/lib/format';
import { Kpi, Panel, PageHead, ErrorNote, Pill, Banner } from '@/components/ui';
import { LedgerGraph, type GraphAmounts } from '@/components/LedgerGraph';

export const dynamic = 'force-dynamic';
interface Acct { id: string; code: string; assetCode: string; balances?: { available: string } }
interface Journal { id: string; reference: string | null; description: string | null; postedAt: string; lines: Array<{ assetCode: string; amount: string; direction: string }> }
interface Conv { id: string; status: string; providerUnknown?: boolean; executionMode?: string }
interface Version { mode: string; production_ready: boolean; capabilities: Record<string, { status: string; live?: string }>; gates?: Record<string, string> }

export default async function Overview() {
  const [acc, jr, cv, ver, rec, appr, rej] = await Promise.all([
    load<Acct[]>('/accounts'), load<Journal[]>('/journals?limit=12'), load<Conv[]>('/conversions'), load<Version>('/version'),
    load<{ status: string; source: string; breaks: unknown[]; checkedAt: string } | null>('/reconciliation/runs/latest'),
    load<Array<{ status: string }>>('/compliance/approvals'), load<Array<{ status: string }>>('/compliance/rejected-deposits'),
  ]);
  const accounts = list<Acct>(acc), convs = list<Conv>(cv), journals = list<Journal>(jr);
  const sum = (prefix: string, asset: string) => sumDec(accounts.filter((x) => x.code === `${prefix}-${asset}`).map((x) => x.balances?.available));
  const assets = [...new Set(accounts.map((x) => x.assetCode))].sort();
  const amounts = (a: string): GraphAmounts => ({ custody: sum('CUSTODY-REF', a), lp: sum('LP-CLEARING', a), customer: sum('CUST-LIAB', a), inTransit: sum('CONV-INTRANSIT', a), fees: sum('FEE-REVENUE', a) });
  const unknown = convs.filter((c) => c.providerUnknown).length;
  const pendingAppr = list<{ status: string }>(appr).filter((a) => a.status === 'pending').length;
  const rejOpen = list<{ status: string }>(rej).filter((r) => ['detected', 'under_review', 'approved'].includes(r.status)).length;
  const breaks = rec.data?.breaks?.length ?? 0; const run = rec.data;
  const v = ver.data;
  const attention = [
    { n: unknown, label: 'Conversions with an unknown provider outcome', tone: 'red', href: '/conversions' },
    { n: breaks, label: 'Open reconciliation breaks', tone: 'red', href: '/reconciliation' },
    { n: pendingAppr, label: 'Approvals waiting for a decision', tone: 'amber', href: '/compliance' },
    { n: rejOpen, label: 'Wrong-token deposits awaiting a decision', tone: 'amber', href: '/compliance' },
  ];
  const errors = [acc.error, cv.error].filter(Boolean)[0] ?? null;
  return (
    <>
      <PageHead title="Operations" sub="Solvency, activity and items that need a person" />
      {v?.mode === 'sandbox' && <Banner kind="sandbox"><b>SANDBOX</b> All balances, providers and prices on this screen are simulated.</Banner>}
      <ErrorNote message={errors} />
      <div className="grid g5" style={{ marginBottom: 12 }}>
        <Kpi label="Ledger accounts" value={accounts.length} sub={`${assets.length} asset${assets.length === 1 ? '' : 's'}`} />
        <Kpi label="Conversions" value={convs.length} sub={`${convs.filter((c) => c.status === 'settled').length} settled`} />
        <Kpi label="Unknown outcomes" value={unknown} sub="funds held, never retried" tone={unknown ? 'alert' : 'ok'} />
        <Kpi label="Reconciliation" value={run ? run.status : '—'} sub={run ? `${run.source} · ${breaks} break${breaks === 1 ? '' : 's'}` : rec.error ?? 'no runs yet'} tone={run && run.status !== 'clean' ? 'alert' : 'ok'} />
        <Kpi label="Needs attention" value={attention.reduce((n, a) => n + a.n, 0)} sub="across the queues →" tone={attention.some((a) => a.n && a.tone === 'red') ? 'alert' : 'ok'} />
      </div>
      <div className="grid g2" style={{ marginBottom: 12 }}>
        <Panel title="Ledger coverage" right={<span className="muted">custody + LP position vs customer obligations</span>}>
          {assets.length === 0 ? <div className="empty">No balances yet — the ledger is empty.</div> : (
            <div className="grid" style={{ gridTemplateColumns: '1fr', gap: 18 }}>{assets.map((a) => <LedgerGraph key={a} asset={a} a={amounts(a)} />)}</div>
          )}
        </Panel>
        <Panel title="Needs attention" flush>
          <ul className="attn">{attention.map((a) => (
            <li key={a.label}><span className="n" style={{ color: a.n ? (a.tone === 'red' ? 'var(--red)' : 'var(--amber)') : 'var(--muted)' }}>{a.n}</span><a href={a.href} className="dim">{a.label}</a></li>
          ))}</ul>
        </Panel>
      </div>
      <div className="grid g2">
        <Panel title="Recent ledger activity" count={journals.length} flush>
          {journals.length === 0 ? <div className="empty">No journals posted yet.</div> : (
            <ul className="feed">{journals.map((j) => {
              const assetsIn = [...new Set(j.lines.map((l) => l.assetCode))].join(' · ');
              return <li key={j.id}><time>{clock(j.postedAt)}</time><div><div className="t">{j.description ?? j.reference ?? 'Journal'}</div><div className="d mono">{short(j.reference ?? j.id, 38)}</div></div><span className="tag asset">{assetsIn}</span></li>;
            })}</ul>
          )}
        </Panel>
        <Panel title="Platform readiness" flush right={v ? <Pill tone={v.production_ready ? 'green' : 'amber'}>{v.production_ready ? 'production ready' : 'not production-ready'}</Pill> : undefined}>
          {!v ? <div className="empty">{ver.error ?? 'No data'}</div> : (
            <table className="grid-t"><tbody>
              {Object.entries(v.capabilities).map(([k, c]) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td className="r"><Pill>{c.status}</Pill></td></tr>)}
              {Object.entries(v.gates ?? {}).map(([k, g]) => <tr key={k}><td className="muted">{k.replace(/_/g, ' ')}</td><td className="r dim">{g}</td></tr>)}
            </tbody></table>
          )}
        </Panel>
      </div>
    </>
  );
}
void roleOf; void money;
