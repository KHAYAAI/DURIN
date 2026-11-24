/** Group thousands in a decimal STRING without converting through a float (amounts are exact decimals). */
export function money(v: unknown, maxFrac = 6): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '−' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${frac ? `.${frac}` : ''}`;
}
export const short = (id: unknown, n = 8) => (typeof id === 'string' && id.length > n + 1 ? `${id.slice(0, n)}…` : String(id ?? '—'));
export function ago(iso: unknown): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN; if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
}
export const clock = (iso: unknown) => { const t = typeof iso === 'string' ? new Date(iso) : null; return t && !Number.isNaN(+t) ? t.toISOString().slice(11, 19) : '—'; };
/** ledger account code → role label (the API list does not return the role). */
export function roleOf(code: string): { label: string; tone: string } {
  if (code.startsWith('CUSTODY-REF')) return { label: 'Custody ref', tone: 'blue' };
  if (code.startsWith('CUST-LIAB')) return { label: 'Customer', tone: 'violet' };
  if (code.startsWith('CONV-INTRANSIT')) return { label: 'In transit', tone: 'amber' };
  if (code.startsWith('LP-CLEARING')) return { label: 'LP clearing', tone: 'gray' };
  if (code.startsWith('FEE-REVENUE')) return { label: 'Fee revenue', tone: 'green' };
  if (code.startsWith('HOUSE-TRADE')) return { label: 'House trading', tone: 'amber' };
  if (code.startsWith('HOUSE-CAPITAL')) return { label: 'House capital', tone: 'green' };
  return { label: 'Ledger', tone: 'gray' };
}
export const toneOf = (status: string): string => ({
  settled: 'green', approved: 'green', clean: 'green', confirmed: 'green', completed: 'green', returned: 'green', active: 'green', paid: 'green', filled: 'green',
  pending: 'amber', processing: 'amber', open: 'amber', submitted: 'amber', under_review: 'amber', detected: 'amber', requires_action: 'amber', quoted: 'blue', accepted: 'blue', created: 'blue',
  failed: 'red', rejected: 'red', breaks: 'red', expired: 'red', cancelled: 'gray', held: 'gray',
} as Record<string, string>)[status.toLowerCase()] ?? 'gray';

/** Exact decimal sum of decimal strings (18 dp, BigInt) — never accumulates float error. */
export function sumDec(values: Array<string | number | null | undefined>): string {
  const ZERO = BigInt(0); let t = ZERO;
  for (const v of values) {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v ?? '0')); if (!m) continue;
    const n = BigInt(m[2]! + (m[3] ?? '').padEnd(18, '0').slice(0, 18)); t += m[1] ? -n : n;
  }
  const neg = t < ZERO; const a = neg ? -t : t; const s = a.toString().padStart(19, '0');
  const i = s.slice(0, s.length - 18); const f = s.slice(s.length - 18).replace(/0+$/, '');
  return `${neg ? '-' : ''}${f ? `${i}.${f}` : i}`;
}
