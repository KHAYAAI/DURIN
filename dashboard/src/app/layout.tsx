import type { Metadata } from 'next';
import './globals.css';
import { signOut, withAuth } from '@workos-inc/authkit-nextjs';
import { workosConfigured } from '@/lib/auth';
import { getMode } from '@/lib/mode';
import { Shell } from '@/components/Shell';

export const metadata: Metadata = {
  title: 'DURIN — Control plane',
  description: 'Institutional digital financial infrastructure',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = workosConfigured() ? (await withAuth()).user : null;
  const mode = await getMode();
  return (
    <html lang="en">
      <body>
        <Shell mode={mode} user={user?.email ?? null} signOut={user ? async () => { 'use server'; await signOut(); } : undefined}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
