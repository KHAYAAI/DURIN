import type { Metadata } from 'next';
import './globals.css';
import { signOut, withAuth } from '@workos-inc/authkit-nextjs';
import { workosConfigured } from '@/lib/auth';
import { getMode } from '@/lib/mode';

export const metadata: Metadata = {
  title: 'DURIN — Institutional Control Plane',
  description: 'African digital financial infrastructure',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = workosConfigured() ? (await withAuth()).user : null;
  const mode = await getMode();
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">DURIN</div>
            <nav>
              <a href="/">Overview</a>
              <a href="/accounts">Accounts</a>
              <a href="/payments">Payments</a>
              <a href="/conversions">Conversions</a>
              <a href="/compliance">Compliance</a>
              <a href="/developers">Developers</a>
              <a href="/security">Security</a>
            </nav>
            <div className="sidebar-footer">
              <span className="badge">{mode === 'sandbox' ? 'Sandbox' : 'Live'}</span>
              <span className="muted">{mode === 'sandbox' ? 'simulated money movement' : 'live environment'}</span>
              {user && (
                <form action={async () => { 'use server'; await signOut(); }}>
                  <span className="muted">{user.email}</span>
                  <button type="submit">Sign out</button>
                </form>
              )}
            </div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
