'use server';

import { revalidatePath } from 'next/cache';
import { durinFetch } from '@/lib/api';

export type MfaFormState = { message?: string; error?: string; enroll?: { secret?: string; uri?: string; qrCode?: string }; challengeId?: string };

export async function enrollAction(): Promise<MfaFormState> {
  try {
    const r = await durinFetch<{ secret?: string; uri?: string; qrCode?: string }>('/auth/mfa/enroll', { method: 'POST', body: '{}' });
    return { message: 'Scan the QR code (or enter the secret) in your authenticator app, then verify below.', enroll: r };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Enrollment failed' };
  }
}

export async function challengeAction(): Promise<MfaFormState> {
  try {
    const r = await durinFetch<{ challengeId: string }>('/auth/mfa/challenge', { method: 'POST', body: '{}' });
    return { challengeId: r.challengeId, message: 'Enter the 6-digit code from your authenticator app.' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not start a challenge' };
  }
}

export async function verifyAction(_prev: MfaFormState, form: FormData): Promise<MfaFormState> {
  const challengeId = String(form.get('challengeId') ?? '');
  const code = String(form.get('code') ?? '').trim();
  try {
    await durinFetch('/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) });
    revalidatePath('/security');
    return { message: 'Verified. Sensitive actions are unlocked for this session.' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Verification failed', challengeId };
  }
}

export async function ssoPortalAction(): Promise<{ link?: string; error?: string }> {
  try {
    const r = await durinFetch<{ link: string }>('/auth/sso/portal-link', { method: 'POST', body: JSON.stringify({ intent: 'sso' }) });
    return { link: r.link };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not create the SSO setup link' };
  }
}
