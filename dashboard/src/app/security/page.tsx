import { durinFetch, ApiError } from '@/lib/api';
import { PageHead, ErrorNote } from '@/components/ui';
import { SecurityPanel } from './panel';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  let status: { verified: boolean; expiresAt: string | null } | null = null;
  let error: string | null = null;
  try { status = await durinFetch('/auth/mfa/status'); }
  catch (e) { error = e instanceof ApiError && e.status === 403 ? 'MFA is available to signed-in users only (not API keys).' : e instanceof Error ? e.message : 'Failed to load'; }
  return (
    <>
      <PageHead title="Security" sub="Multi-factor authentication and single sign-on for this organisation." />
      <ErrorNote message={error} />
      {status && <SecurityPanel verified={status.verified} expiresAt={status.expiresAt} />}
    </>
  );
}
