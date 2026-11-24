import { load, list } from '@/lib/data';
import { ago, money, short } from '@/lib/format';
import { PageHead, Panel, ErrorNote, Kpi, Pill } from '@/components/ui';
import { DataGrid } from '@/components/DataGrid';

export const dynamic = 'force-dynamic';
interface Conv { id: string; status: string; sourceAsset: string; targetAsset: string; sourceAmount: string; targetAmount: string; feeAmount: string; rate: string; executionMode?: string; providerUnknown?: boolean; failureReason?: string | null; createdAt: string; settledAt?: string | null }
interface Journal { reference: string | null; postedAt: string }

export default async function Conversions({ searchParams }: { searchParams: { id?: string } }) {
  const [cv, jr] = await Promise.all([load<Conv[]>('/conversions'), load<Journal[]>('/journals?limit=100')]);
  const convs = list<Conv>(cv), journals = list<Journal>(jr);
  const sel = convs.find((c) => c.id === searchParams.id);
  const count = (s: string) => convs.filter((c) => c.status === s).length;
  const rows = convs.map((c) => ({
    id: short(c.id), pair: `${c.sourceAsset} → ${c.targetAsset}`, source: money(c.sourceAmount), target: money(c.targetAmount), fee: `${money(c.feeAmount)} ${c.sourceAsset}`,
    route: c.executionMode ?? 'provider', status: c.providerUnknown ? 'unknown outcome' : c.status, age: ago(c.createdAt), _href: `/conversions?id=${c.id}`, _sel: c.id === sel?.id,
  }));
  const has = (suffix: string) => !!sel && journals.some((j) => j.reference === `conversion:${sel.id}:${suffix}`);
  const steps = sel ? [
    { l: 'Quote accepted', done: true }, { l: 'Funds reserved', done: has('reserve') || sel.status !== 'quoted' },
    { l: sel.executionMode === 'house' ? 'House fill' : sel.executionMode === 'netted' ? 'Netted + hedged' : 'Provider fill', done: has('fill') },
    { l: 'Settled at custody', done: has('settle') },
  ] : [];
  return (
    <>
      <PageHead title="Conversions" sub="ZAR ⇄ stablecoin. Reserve → fill → settle; an unknown provider outcome keeps funds reserved and is never retried." />
      <ErrorNote message={cv.error} />
      <div className="grid g5" style={{ marginBottom: 12 }}>
        <Kpi label="Total" value={convs.length} /><Kpi label="Settled" value={count('settled')} /><Kpi label="Processing" value={count('processing')} />
        <Kpi label="Failed" value={count('failed')} /><Kpi label="Unknown outcome" value={convs.filter((c) => c.providerUnknown).length} tone={convs.some((c) => c.providerUnknown) ? 'alert' : 'ok'} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: sel ? '2fr 1fr' : '1fr', alignItems: 'start' }}>
        <Panel title="All conversions" count={convs.length} flush>
          <DataGrid empty="No conversions yet" cols={[
            { key: 'id', label: 'ID', mono: true }, { key: 'pair', label: 'Pair', kind: 'tag' }, { key: 'source', label: 'Source', align: 'r' }, { key: 'target', label: 'Target', align: 'r' },
            { key: 'fee', label: 'Fee', align: 'r' }, { key: 'route', label: 'Route', kind: 'tag' },
            { key: 'status', label: 'Status', kind: 'pill', tones: { settled: 'green', processing: 'amber', failed: 'red', 'unknown outcome': 'red', quoted: 'blue' } }, { key: 'age', label: 'Created' },
          ]} rows={rows} />
        </Panel>
        {sel && (
          <Panel title="Conversion detail" right={<a href="/conversions">close</a>}>
            <div className="steps">{steps.map((s) => <div key={s.l} className={`st ${s.done ? 'done' : ''} ${sel.status === 'failed' && !s.done ? 'bad' : ''}`}>{s.l}</div>)}</div>
            <dl className="kv" style={{ borderTop: '1px solid var(--line)' }}>
              <dt>ID</dt><dd>{sel.id}</dd><dt>Status</dt><dd><Pill>{sel.providerUnknown ? 'unknown outcome' : sel.status}</Pill></dd>
              <dt>Pays</dt><dd>{money(sel.sourceAmount)} {sel.sourceAsset}</dd><dt>Receives</dt><dd>{money(sel.targetAmount)} {sel.targetAsset}</dd>
              <dt>Rate</dt><dd>{money(sel.rate)}</dd><dt>Fee</dt><dd>{money(sel.feeAmount)} {sel.sourceAsset}</dd><dt>Route</dt><dd>{sel.executionMode ?? 'provider'}</dd>
              {sel.failureReason && <><dt>Failure</dt><dd>{sel.failureReason}</dd></>}
              <dt>Created</dt><dd>{sel.createdAt}</dd>{sel.settledAt && <><dt>Settled</dt><dd>{sel.settledAt}</dd></>}
            </dl>
          </Panel>
        )}
      </div>
    </>
  );
}
