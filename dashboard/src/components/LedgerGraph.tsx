import { money } from '@/lib/format';

export interface GraphAmounts { custody: string; lp: string; customer: string; inTransit: string; fees: string }

/**
 * The solvency picture for one asset, as a flow diagram: what backs the books (custody mirror + LP position) on the
 * left, what DURIN owes (customer balances + conversions in transit) on the right. Colour encodes coverage.
 * All values are exact decimal strings; the coverage % is for orientation only (float used for display geometry).
 */
export function LedgerGraph({ asset, a }: { asset: string; a: GraphAmounts }) {
  const n = (s: string) => Number(s) || 0;
  const backing = n(a.custody) + n(a.lp); const owed = n(a.customer) + n(a.inTransit);
  const cover = owed === 0 ? (backing === 0 ? null : 100) : (backing / owed) * 100;
  const tone = cover === null ? '#7d8794' : cover >= 100 ? '#3dcc91' : '#f0707a';
  const box = (x: number, y: number, w: number, label: string, value: string, c: string) => (
    <g key={label}>
      <rect x={x} y={y} width={w} height={46} rx={2} fill="#1e232a" stroke="#2a313a" />
      <rect x={x} y={y} width={3} height={46} fill={c} />
      <text x={x + 12} y={y + 18} fontSize={10} fill="#7d8794" letterSpacing=".08em">{label.toUpperCase()}</text>
      <text x={x + 12} y={y + 36} fontSize={14} fill="#f1f3f6" fontWeight={600}>{money(value, 4)}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 560 150" width="100%" role="img" aria-label={`${asset} ledger coverage`}>
      <defs><marker id={`ar-${asset}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="#7d8794" /></marker></defs>
      <text x={0} y={12} fontSize={11} fill="#b8c0cc" fontWeight={700} letterSpacing=".1em">{asset}</text>
      {box(0, 24, 160, 'Custody (mirror)', a.custody, '#4c90f0')}
      {box(0, 80, 160, 'LP clearing', a.lp, '#7d8794')}
      <path d="M160 47 C 215 47, 215 62, 262 62" stroke="#7d8794" fill="none" markerEnd={`url(#ar-${asset})`} />
      <path d="M160 103 C 215 103, 215 88, 262 88" stroke="#7d8794" fill="none" markerEnd={`url(#ar-${asset})`} />
      <g><rect x={262} y={50} width={96} height={50} rx={2} fill="#181c22" stroke={tone} />
        <text x={310} y={72} textAnchor="middle" fontSize={9.5} fill="#7d8794" letterSpacing=".1em">COVERAGE</text>
        <text x={310} y={91} textAnchor="middle" fontSize={16} fontWeight={700} fill={tone}>{cover === null ? '—' : `${cover.toFixed(cover >= 1000 ? 0 : 1)}%`}</text></g>
      <path d="M358 62 C 405 62, 405 47, 400 47" stroke="#7d8794" fill="none" />
      {box(400, 24, 160, 'Customer balances', a.customer, '#a78bfa')}
      {box(400, 80, 160, 'In transit', a.inTransit, '#f0b24a')}
      <path d="M358 88 C 380 88, 380 103, 400 103" stroke="#7d8794" fill="none" markerEnd={`url(#ar-${asset})`} />
      <text x={0} y={146} fontSize={10} fill="#7d8794">fees earned: {money(a.fees, 4)}</text>
    </svg>
  );
}
