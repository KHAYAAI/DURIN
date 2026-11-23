import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DURIN — Institutional Control Plane',
  description: 'African digital financial infrastructure',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
            </nav>
            <div className="sidebar-footer">
              <span className="badge">Sandbox</span>
              <span className="muted">simulated money movement</span>
            </div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
