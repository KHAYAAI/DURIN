import { load, list } from '@/lib/data';
import { apiBase } from '@/lib/api';
import { PageHead, Panel, ErrorNote, Pill } from '@/components/ui';
import { DataGrid } from '@/components/DataGrid';

export const dynamic = 'force-dynamic';
type R = Record<string, unknown>;

export default async function Developers() {
  const [me, keys, hooks] = await Promise.all([load<{ authMethod: string; scopes: string[]; mfa: { verified: boolean } | null }>('/auth/me'), load<R[]>('/api_keys'), load<R[]>('/webhook_endpoints')]);
  return (
    <>
      <PageHead title="Developers" sub="Credentials, webhooks and the API contract." />
      <div className="grid g3" style={{ marginBottom: 12 }}>
        <Panel title="API base"><div className="mono" style={{ wordBreak: 'break-all' }}>{apiBase()}</div><p className="muted" style={{ margin: '10px 0 0' }}><a href={`${apiBase()}/openapi.yaml`}>OpenAPI (YAML)</a> · money is always a decimal string · writes accept an <code>Idempotency-Key</code></p></Panel>
        <Panel title="This session">
          {me.error ? <span className="muted">{me.error}</span> : <><div style={{ marginBottom: 8 }}><Pill tone="blue">{me.data?.authMethod === 'workos' ? 'signed-in user' : 'API key'}</Pill> {me.data?.mfa && <Pill tone={me.data.mfa.verified ? 'green' : 'amber'}>{me.data.mfa.verified ? 'MFA verified' : 'MFA not verified'}</Pill>}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{(me.data?.scopes ?? []).map((s) => <span key={s} className="tag">{s}</span>)}</div></>}
        </Panel>
        <Panel title="Conventions"><ul className="muted" style={{ margin: 0, paddingLeft: 16 }}><li>Webhooks are signed: <code>DURIN-Signature</code></li><li>Deliveries are at-least-once</li><li>Sensitive actions need MFA for signed-in users</li></ul></Panel>
      </div>
      <div className="grid g2">
        <Panel title="API keys" count={list(keys).length} flush>
          <ErrorNote message={keys.error ? `${keys.error} (needs the api_keys:read scope)` : null} />
          <DataGrid search={false} empty="No keys visible" cols={[{ key: 'name', label: 'Name' }, { key: 'keyPrefix', label: 'Prefix', mono: true }, { key: 'scopes', label: 'Scopes' }]} rows={list<R>(keys).map((k) => ({ name: String(k.name), keyPrefix: String(k.keyPrefix ?? ''), scopes: Array.isArray(k.scopes) ? `${(k.scopes as string[]).length} scopes` : '' }))} />
        </Panel>
        <Panel title="Webhook endpoints" count={list(hooks).length} flush>
          <ErrorNote message={hooks.error ? `${hooks.error} (needs the webhooks:read scope)` : null} />
          <DataGrid search={false} empty="No endpoints registered" cols={[{ key: 'url', label: 'URL', mono: true }, { key: 'events', label: 'Events' }, { key: 'status', label: 'Status', kind: 'pill', tones: { active: 'green' } }]} rows={list<R>(hooks).map((h) => ({ url: String(h.url), events: Array.isArray(h.events) ? (h.events as string[]).join(', ') : '', status: String(h.status ?? 'active') }))} />
        </Panel>
      </div>
    </>
  );
}
