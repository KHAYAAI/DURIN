import { load, list } from '@/lib/data';
import { money, roleOf, clock, short } from '@/lib/format';
import { PageHead, Panel, ErrorNote } from '@/components/ui';
import { DataGrid } from '@/components/DataGrid';

export const dynamic = 'force-dynamic';
interface Acct { id: string; code: string; name: string; accountType: string; assetCode: string; status: string; allowNegative: boolean; balances?: { available: string; pending: string; reserved: string } }
interface Journal { id: string; reference: string | null; description: string | null; postedAt: string; lines: Array<{ accountId: string; direction: string; amount: string; assetCode: string }> }

export default async function Accounts({ searchParams }: { searchParams: { account?: string } }) {
  const [acc, jr] = await Promise.all([load<Acct[]>('/accounts'), load<Journal[]>('/journals?limit=100')]);
  const accounts = list<Acct>(acc), journals = list<Journal>(jr);
  const sel = accounts.find((a) => a.id === searchParams.account);
  const rows = accounts.map((a) => ({
    code: a.code, role: roleOf(a.code).label, assetCode: a.assetCode, accountType: a.accountType,
    available: money(a.balances?.available ?? '0'), reserved: money(a.balances?.reserved ?? '0'), status: a.status,
    _href: `/accounts?account=${a.id}`, _sel: a.id === sel?.id,
  }));
  const postings = sel ? journals.flatMap((j) => j.lines.filter((l) => l.accountId === sel.id).map((l) => ({ at: clock(j.postedAt), dir: l.direction, amount: money(l.amount), ref: short(j.reference ?? j.description ?? j.id, 22) }))) : [];
  return (
    <>
      <PageHead title="Accounts" sub="Chart of accounts and live balances. Custody-reference accounts mirror what custodians hold; DURIN holds no customer funds itself." />
      <ErrorNote message={acc.error} />
      <div className="grid" style={{ gridTemplateColumns: sel ? '2fr 1fr' : '1fr', alignItems: 'start' }}>
        <Panel title="Ledger accounts" count={accounts.length} flush>
          <DataGrid empty="No accounts yet" cols={[
            { key: 'code', label: 'Code', mono: true }, { key: 'role', label: 'Role', kind: 'tag' }, { key: 'assetCode', label: 'Asset', kind: 'asset' },
            { key: 'accountType', label: 'Type' }, { key: 'available', label: 'Available', align: 'r' }, { key: 'reserved', label: 'Reserved', align: 'r' },
            { key: 'status', label: 'Status', kind: 'pill', tones: { active: 'green' } },
          ]} rows={rows} />
        </Panel>
        {sel && (
          <Panel title="Account detail" right={<a href="/accounts">close</a>}>
            <dl className="kv">
              <dt>Code</dt><dd>{sel.code}</dd><dt>Name</dt><dd style={{ fontFamily: 'var(--sans)' }}>{sel.name}</dd>
              <dt>Role</dt><dd>{roleOf(sel.code).label}</dd><dt>Asset</dt><dd>{sel.assetCode}</dd><dt>Type</dt><dd>{sel.accountType}{sel.allowNegative ? ' · may go negative' : ' · never negative'}</dd>
              <dt>Available</dt><dd>{money(sel.balances?.available ?? '0')}</dd><dt>Pending</dt><dd>{money(sel.balances?.pending ?? '0')}</dd><dt>Reserved</dt><dd>{money(sel.balances?.reserved ?? '0')}</dd>
            </dl>
            <div style={{ borderTop: '1px solid var(--line)' }}>
              <div className="panel-h">Recent postings <span className="count">{postings.length}</span></div>
              <DataGrid search={false} empty="No postings in the last 100 journals" cols={[{ key: 'at', label: 'UTC', mono: true }, { key: 'dir', label: 'Dr/Cr', kind: 'pill', tones: { debit: 'blue', credit: 'violet' } }, { key: 'amount', label: 'Amount', align: 'r' }, { key: 'ref', label: 'Reference', mono: true }]} rows={postings} />
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
