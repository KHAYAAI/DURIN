import { createHmac } from 'crypto';
import { ProviderOutcomeUnknown } from '../errors';

/**
 * Signed VALR REST client (https://docs.valr.com). Request signing per VALR's docs: HMAC-SHA512 over
 * timestamp(ms) + VERB + path(with query) + body + subaccountId, hex; headers X-VALR-API-KEY,
 * X-VALR-SIGNATURE, X-VALR-TIMESTAMP and, when impersonating a subaccount, X-VALR-SUB-ACCOUNT-ID.
 *
 * Failure model: a transport error/timeout or a 5xx on a WRITE is an UNKNOWN outcome (thrown as
 * ProviderOutcomeUnknown). 4xx responses are definitive and returned to the caller.
 */
export interface ValrConfig { baseUrl: string; apiKey: string; apiSecret: string; timeoutMs?: number }
export interface ValrResponse { status: number; json: any }

export function signValr(secret: string, timestamp: string, verb: string, path: string, body: string, subAccountId = ''): string {
  return createHmac('sha512', secret).update(timestamp).update(verb.toUpperCase()).update(path).update(body).update(subAccountId).digest('hex');
}

export class ValrClient {
  constructor(private readonly cfg: ValrConfig, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  static fromEnv(): ValrClient {
    const { VALR_API_KEY: apiKey, VALR_API_SECRET: apiSecret } = process.env;
    if (!apiKey || !apiSecret) throw new Error('VALR adapters need VALR_API_KEY and VALR_API_SECRET');
    return new ValrClient({ baseUrl: process.env.VALR_BASE_URL || 'https://api.valr.com', apiKey, apiSecret });
  }

  async request(verb: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { body?: unknown; subAccountId?: string } = {}): Promise<ValrResponse> {
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const ts = String(this.now());
    const sub = opts.subAccountId ?? '';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-VALR-API-KEY': this.cfg.apiKey,
      'X-VALR-TIMESTAMP': ts,
      'X-VALR-SIGNATURE': signValr(this.cfg.apiSecret, ts, verb, path, body, sub),
    };
    if (sub) headers['X-VALR-SUB-ACCOUNT-ID'] = sub;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        method: verb, headers, body: body || undefined, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
      });
    } catch (e) {
      if (verb === 'GET') throw new Error(`VALR ${verb} ${path.split('?')[0]}: ${e instanceof Error ? e.message : 'network error'}`);
      throw new ProviderOutcomeUnknown(`VALR ${verb} ${path.split('?')[0]}: ${e instanceof Error ? e.message : 'network error'}`);
    }
    let json: any = {};
    try { json = await res.json(); } catch { /* empty body */ }
    if (res.status >= 500 && verb !== 'GET') throw new ProviderOutcomeUnknown(`VALR ${verb} ${path.split('?')[0]} returned ${res.status}`);
    return { status: res.status, json };
  }

  /** Subaccount id for a label prefix lookup (primary key only). */
  async listSubaccounts(): Promise<Array<{ id: string; label: string }>> {
    const r = await this.request('GET', '/v1/account/subaccounts');
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`VALR list subaccounts failed (${r.status})`);
    return r.json;
  }

  /** Sum of `total` (available + reserved) per currency across the given subaccounts, as decimal strings. */
  async totals(subAccountIds: string[]): Promise<Map<string, string>> {
    const totals = new Map<string, bigint>();
    for (const id of subAccountIds) {
      const r = await this.request('GET', '/v1/account/balances?excludeZeroBalances=true', { subAccountId: id });
      if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`VALR balances failed (${r.status})`);
      for (const b of r.json) {
        if (typeof b.currency !== 'string' || typeof b.total !== 'string') throw new Error('VALR returned a malformed balance');
        totals.set(b.currency.toUpperCase(), (totals.get(b.currency.toUpperCase()) ?? 0n) + toScaled(b.total));
      }
    }
    return new Map([...totals].map(([k, v]) => [k, fromScaled(v)]));
  }
}

const SCALE = 18;
export function toScaled(v: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m) throw new Error(`Invalid decimal ${v}`);
  const frac = (m[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE);
  const n = BigInt(m[2]! + frac);
  return m[1] ? -n : n;
}
export function fromScaled(v: bigint): string {
  const neg = v < 0n; const a = neg ? -v : v;
  const s = a.toString().padStart(SCALE + 1, '0');
  const i = s.slice(0, s.length - SCALE); const f = s.slice(s.length - SCALE).replace(/0+$/, '');
  return `${neg ? '-' : ''}${f ? `${i}.${f}` : i}`;
}
