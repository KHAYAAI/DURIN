import { load, list } from '@/lib/data';
import { ago, money, short, sumDec } from '@/lib/format';
import { PageHead, Panel, ErrorNote, Kpi } from '@/components/ui';
import { DataGrid } from '@/components/DataGrid';

export const dynamic = 'force-dynamic';
interface Intent { id: string; amount: string; assetCode: string; status: string; description: string | null; customerReference: string | null; createdAt: string; settledAt: string | null }

export default async function Payments() {
  const r = await load<Intent[]>('/payment_intents');
  const items = list<Intent>(r);
  const settled = items.filter((i) => i.status === 'settled');
  const vol = (a: string) => sumDec(settled.filter((i) => i.assetCode === a).map((i) => i.amount));
  const assets = [...new Set(items.map((i) => i.assetCode))].sort();
  return (
    <>
      <PageHead title="Payments" sub="Payment intents and their settlement. Each settlement is one balanced journal." />
      <ErrorNote message={r.error} />
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Kpi label="Intents" value={items.length} /><Kpi label="Settled" value={settled.length} />
        {assets.slice(0, 2).map((a) => <Kpi key={a} label={`Settled volume · ${a}`} value={money(vol(a), 2)} />)}
      </div>
      <Panel title="Payment intents" count={items.length} flush>
        <DataGrid empty="No payment intents yet" cols={[
          { key: 'id', label: 'ID', mono: true }, { key: 'description', label: 'Description' }, { key: 'asset', label: 'Asset', kind: 'asset' }, { key: 'amount', label: 'Amount', align: 'r' },
          { key: 'status', label: 'Status', kind: 'pill', tones: { settled: 'green', pending: 'amber', created: 'blue', cancelled: 'gray', failed: 'red' } }, { key: 'age', label: 'Created' },
        ]} rows={items.map((i) => ({ id: short(i.id), description: i.description ?? i.customerReference ?? '—', asset: i.assetCode, amount: money(i.amount), status: i.status, age: ago(i.createdAt) }))} />
      </Panel>
    </>
  );
}
