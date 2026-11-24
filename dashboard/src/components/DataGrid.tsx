'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';

export interface Col { key: string; label: string; align?: 'r'; mono?: boolean; kind?: 'pill' | 'tag' | 'asset' | 'bar'; tones?: Record<string, string> }
type Row = Record<string, string | number | boolean | null | undefined>;

/** Searchable, sortable, dense table. Rows are plain strings (amounts stay exact decimals; sorting is numeric only when both sides parse). */
export function DataGrid({ cols, rows, empty = 'No records', search = true }: { cols: Col[]; rows: Row[]; empty?: string; search?: boolean }) {
  const [q, setQ] = useState(''); const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const shown = useMemo(() => {
    let r = rows;
    if (q) { const n = q.toLowerCase(); r = r.filter((x) => cols.some((c) => String(x[c.key] ?? '').toLowerCase().includes(n))); }
    if (sort) r = [...r].sort((a, b) => {
      const x = String(a[sort.key] ?? ''), y = String(b[sort.key] ?? '');
      const nx = Number(x.replace(/[ −]/g, (m) => (m === '−' ? '-' : ''))), ny = Number(y.replace(/[ −]/g, (m) => (m === '−' ? '-' : '')));
      return (Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '' ? nx - ny : x.localeCompare(y)) * sort.dir;
    });
    return r;
  }, [rows, q, sort, cols]);
  return (
    <div>
      {search && <div className="tools"><input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter rows" /><span className="muted">{shown.length} of {rows.length}</span></div>}
      <table className="grid-t">
        <thead><tr>{cols.map((c) => <th key={c.key} className={c.align} onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: 1 }))}>{c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</th>)}</tr></thead>
        <tbody>
          {shown.length === 0 ? <tr><td colSpan={cols.length} className="empty">{empty}</td></tr> : shown.map((r, i) => (
            <tr key={i} className={r._sel ? 'sel' : ''}>
              {cols.map((c) => {
                const v = r[c.key]; const text = v === null || v === undefined || v === '' ? '—' : String(v);
                const cell = c.kind === 'pill' ? <span className={`pill ${c.tones?.[text.toLowerCase()] ?? 'gray'}`}>{text.replace(/_/g, ' ')}</span>
                  : c.kind === 'asset' ? <span className="tag asset">{text}</span> : c.kind === 'tag' ? <span className="tag">{text}</span> : text;
                return <td key={c.key} className={`${c.align ?? ''} ${c.mono || c.align === 'r' ? 'mono' : ''}`}>{r._href && c === cols[0] ? <Link href={String(r._href)} className="row">{cell}</Link> : cell}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
