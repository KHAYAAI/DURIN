import { load, list } from '@/lib/data';
import { ago, money, short } from '@/lib/format';
import { PageHead, Panel, ErrorNote, Kpi } from '@/components/ui';
import { DataGrid } from '@/components/DataGrid';

export const dynamic = 'force-dynamic';
type R = Record<string, string | null>;

export default async function Compliance() {
  const [ver, lim, apr, rej, aud] = await Promise.all([
    load<R[]>('/compliance/verifications'), load<R[]>('/compliance/limits'), load<R[]>('/compliance/approvals'),
    load<R[]>('/compliance/rejected-deposits'), load<R[]>('/compliance/audit?limit=50'),
  ]);
  const V = list<R>(ver), L = list<R>(lim), A = list<R>(apr), X = list<R>(rej), U = list<R>(aud);
  const tones = { approved: 'green', pending: 'amber', rejected: 'red', expired: 'red', not_started: 'gray', under_review: 'amber', detected: 'amber', held: 'gray', returned: 'green' };
  return (
    <>
      <PageHead title="Compliance" sub="Identity verification, limits, four-eyes approvals, wrong-token deposits and the audit trail." />
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Kpi label="Verifications" value={V.length} sub={`${V.filter((v) => v.status === 'approved').length} approved`} />
        <Kpi label="Pending approvals" value={A.filter((a) => a.status === 'pending').length} tone={A.some((a) => a.status === 'pending') ? 'alert' : 'ok'} />
        <Kpi label="Active limits" value={L.length} />
        <Kpi label="Wrong-token deposits" value={X.filter((x) => ['detected', 'under_review', 'approved'].includes(String(x.status))).length} sub="awaiting a decision" />
      </div>
      <div className="grid g2" style={{ marginBottom: 12 }}>
        <Panel title="Verifications (KYC / KYB)" count={V.length} flush>
          <ErrorNote message={ver.error} />
          <DataGrid search={false} empty="No verifications" cols={[{ key: 'id', label: 'ID', mono: true }, { key: 'subjectType', label: 'Subject', kind: 'tag' }, { key: 'level', label: 'Level' }, { key: 'provider', label: 'Provider', kind: 'tag' }, { key: 'status', label: 'Status', kind: 'pill', tones }]}
            rows={V.map((v) => ({ id: short(v.id), subjectType: v.subjectType, level: v.level, provider: v.provider, status: v.status }))} />
        </Panel>
        <Panel title="Limits" count={L.length} flush>
          <ErrorNote message={lim.error} />
          <DataGrid search={false} empty="No limits set" cols={[{ key: 'name', label: 'Policy' }, { key: 'assetCode', label: 'Asset', kind: 'asset' }, { key: 'perTx', label: 'Per transaction', align: 'r' }, { key: 'daily', label: 'Daily', align: 'r' }]}
            rows={L.map((l) => ({ name: l.name, assetCode: l.assetCode ?? 'ANY', perTx: money(l.perTxLimit), daily: money(l.dailyLimit) }))} />
        </Panel>
      </div>
      <div className="grid g2" style={{ marginBottom: 12 }}>
        <Panel title="Approvals (four-eyes)" count={A.length} flush>
          <ErrorNote message={apr.error} />
          <DataGrid search={false} empty="No approvals" cols={[{ key: 'id', label: 'ID', mono: true }, { key: 'action', label: 'Action' }, { key: 'status', label: 'Status', kind: 'pill', tones: { pending: 'amber', approved: 'green', rejected: 'red' } }, { key: 'age', label: 'Requested' }]}
            rows={A.map((a) => ({ id: short(a.id), action: a.actionType ?? a.action ?? '—', status: a.status, age: ago(a.createdAt) }))} />
        </Panel>
        <Panel title="Wrong-token deposits" count={X.length} flush>
          <ErrorNote message={rej.error} />
          <DataGrid search={false} empty="None — all deposits were the supported token" cols={[{ key: 'chain', label: 'Chain', kind: 'tag' }, { key: 'token', label: 'Token contract', mono: true }, { key: 'sender', label: 'Sender', mono: true }, { key: 'status', label: 'Status', kind: 'pill', tones }]}
            rows={X.map((x) => ({ chain: x.chain, token: short(x.tokenContract, 12), sender: short(x.sender, 10), status: x.status }))} />
        </Panel>
      </div>
      <Panel title="Audit trail" count={U.length} flush>
        <ErrorNote message={aud.error} />
        <DataGrid empty="No audit events" cols={[{ key: 'age', label: 'When' }, { key: 'action', label: 'Action', mono: true }, { key: 'actor', label: 'Actor', mono: true }, { key: 'resource', label: 'Resource', mono: true }]}
          rows={U.map((u) => ({ age: ago(u.createdAt), action: u.action, actor: `${u.actorType ?? ''}${u.actorId ? `:${short(u.actorId, 14)}` : ''}`, resource: `${u.resourceType ?? ''} ${short(u.resourceId, 8)}` }))} />
      </Panel>
    </>
  );
}
