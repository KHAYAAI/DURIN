'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const I = (d: string) => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const ITEMS: Array<{ h?: string; href?: string; label?: string; icon?: string }> = [
  { h: 'Operations' },
  { href: '/', label: 'Overview', icon: 'M2 8l6-5 6 5M3.5 7v6h9V7' },
  { href: '/conversions', label: 'Conversions', icon: 'M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3' },
  { href: '/payments', label: 'Payments', icon: 'M2 4h12v8H2zM2 7h12' },
  { h: 'Ledger' },
  { href: '/accounts', label: 'Accounts', icon: 'M3 3h10v10H3zM3 7h10M7 7v6' },
  { href: '/reconciliation', label: 'Reconciliation', icon: 'M3 8l3 3 7-7' },
  { h: 'Risk & compliance' },
  { href: '/compliance', label: 'Compliance', icon: 'M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z' },
  { h: 'Platform' },
  { href: '/developers', label: 'Developers', icon: 'M5 4L2 8l3 4M11 4l3 4-3 4M9 3l-2 10' },
  { href: '/security', label: 'Security', icon: 'M4 7V5a4 4 0 018 0v2M3 7h10v7H3z' },
];
export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {ITEMS.map((it, i) => it.h ? <h6 key={i}>{it.h}</h6> : (
        <Link key={it.href} href={it.href!} className={(it.href === '/' ? path === '/' : path.startsWith(it.href!)) ? 'active' : ''}>{I(it.icon!)}<span>{it.label}</span></Link>
      ))}
    </nav>
  );
}
export function Crumbs() {
  const path = usePathname();
  const seg = path.split('/').filter(Boolean);
  return <div className="crumbs">DURIN <span> / </span><b>{seg.length ? seg[0]![0]!.toUpperCase() + seg[0]!.slice(1) : 'Overview'}</b></div>;
}
