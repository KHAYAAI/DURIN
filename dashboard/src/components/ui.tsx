import type { ReactNode } from 'react';
import { toneOf } from '@/lib/format';

export function Panel({ title, count, right, children, flush }: { title: string; count?: number | string; right?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-h"><span>{title}</span>{count !== undefined && <span className="count">{count}</span>}{right && <span className="right">{right}</span>}</div>
      <div className={`panel-b${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}
export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'alert' | 'ok' }) {
  return <div className={`panel kpi ${tone ?? ''}`}><div className="k">{label}</div><div className="v">{value}</div>{sub && <div className="s">{sub}</div>}</div>;
}
export function Pill({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`pill ${tone ?? toneOf(String(children))}`}>{String(children).replace(/_/g, ' ')}</span>;
}
export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="spacer" />{right}</div>;
}
export function Banner({ kind, children }: { kind: 'sandbox' | 'live' | 'error'; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}
export function ErrorNote({ message }: { message: string | null }) { return message ? <Banner kind="error">⚠ {message}</Banner> : null; }
export function Bar({ value, tone }: { value: number; tone?: 'green' | 'red' | 'amber' }) {
  return <div className={`bar ${tone ?? ''}`}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}
