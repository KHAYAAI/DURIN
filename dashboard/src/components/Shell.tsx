import type { ReactNode } from 'react';
import { Nav, Crumbs } from './Nav';
import { AutoRefresh } from './AutoRefresh';

export function Shell({ children, mode, user, signOut }: { children: ReactNode; mode: 'sandbox' | 'live'; user?: string | null; signOut?: () => Promise<void> }) {
  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><rect x="1" y="1" width="24" height="24" rx="2" stroke="#4c90f0" strokeWidth="1.6" /><path d="M7 19V7h5.2a5 5 0 010 12z" stroke="#f1f3f6" strokeWidth="1.8" /><path d="M13 7l6 6" stroke="#4c90f0" strokeWidth="1.8" /></svg>
          <div><b>DURIN</b><small>Control plane</small></div>
        </div>
        <Nav />
        <div className="rail-foot">
          <span className={`pill ${mode === 'sandbox' ? 'amber' : 'green'}`}>{mode === 'sandbox' ? 'Sandbox' : 'Live'}</span>
          <span>{mode === 'sandbox' ? 'Simulated money & providers' : 'Production environment'}</span>
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <Crumbs /><div className="spacer" /><AutoRefresh />
          {user && signOut && <form action={signOut} className="user"><span>{user}</span><button type="submit">Sign out</button></form>}
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
