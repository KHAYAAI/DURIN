'use client';

import { useState, useTransition } from 'react';
import { challengeAction, enrollAction, ssoPortalAction, verifyAction, type MfaFormState } from './actions';

export function SecurityPanel({ verified, expiresAt }: { verified: boolean; expiresAt: string | null }) {
  const [state, setState] = useState<MfaFormState>({});
  const [portal, setPortal] = useState<{ link?: string; error?: string }>({});
  const [pending, start] = useTransition();

  return (
    <div className="grid">
      <div className="card">
        <div className="label">This session</div>
        <div className="value">{verified ? 'MFA verified' : 'MFA not verified'}</div>
        {expiresAt && <p className="muted">Valid until {new Date(expiresAt).toLocaleTimeString()}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={pending} onClick={() => start(async () => setState(await enrollAction()))}>Set up authenticator</button>
          <button disabled={pending} onClick={() => start(async () => setState(await challengeAction()))}>Verify now</button>
        </div>
        {state.enroll?.qrCode && <img alt="Authenticator QR code" src={state.enroll.qrCode} width={180} height={180} />}
        {state.enroll?.secret && <p className="muted">Secret: <code>{state.enroll.secret}</code></p>}
        {state.challengeId && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              start(async () => setState(await verifyAction(state, form)));
            }}
          >
            <input type="hidden" name="challengeId" value={state.challengeId} />
            <input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" placeholder="123456" required />
            <button disabled={pending} type="submit">Submit</button>
          </form>
        )}
        {state.message && <p>{state.message}</p>}
        {state.error && <p role="alert">{state.error}</p>}
      </div>
      <div className="card">
        <div className="label">Single sign-on</div>
        <p className="muted">Generate a one-time link for your IT administrator to connect your identity provider (SAML / OIDC). Requires admin role and MFA.</p>
        <button disabled={pending} onClick={() => start(async () => setPortal(await ssoPortalAction()))}>Create SSO setup link</button>
        {portal.link && <p><a href={portal.link} rel="noreferrer">Open the setup portal</a></p>}
        {portal.error && <p role="alert">{portal.error}</p>}
      </div>
    </div>
  );
}
