import { durinFetch, ApiError } from '@/lib/api';
import { SecurityPanel } from './panel';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  let status: { verified: boolean; expiresAt: string | null } | null = null;
  let error: string | null = null;
  try {
    status = await durinFetch('/auth/mfa/status');
  } catch (e) {
    error = e instanceof ApiError && e.status === 403 ? 'MFA is only available to signed-in users (not API keys).' : e instanceof Error ? e.message : 'Failed to load';
  }
  return (
    <div>
      <h1>Security</h1>
      <p className="sub">Multi-factor authentication and single sign-on</p>
      {error && <div className="card" role="alert">{error}</div>}
      {status && <SecurityPanel verified={status.verified} expiresAt={status.expiresAt} />}
    </div>
  );
}
