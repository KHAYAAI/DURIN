import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Webhook signing, shared by the platform (to sign) and by customers (to verify).
 *
 * Header format:  DURIN-Signature: t=<unix seconds>,v1=<hex hmac>
 * Signed payload: "<t>.<raw request body>"  (HMAC-SHA256 with the endpoint's signing secret)
 *
 * Verify against the RAW body bytes, before any JSON parsing. Reject old timestamps to stop
 * replays (default tolerance: 5 minutes).
 */
export const WEBHOOK_SIGNATURE_HEADER = 'DURIN-Signature';
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export function signWebhook(secret: string, body: string, timestampSeconds: number = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export type WebhookVerification = { valid: true } | { valid: false; reason: 'malformed' | 'stale' | 'mismatch' };

export function verifyWebhookSignature(
  secret: string,
  header: string | undefined,
  body: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): WebhookVerification {
  if (!header) return { valid: false, reason: 'malformed' };
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { valid: false, reason: 'malformed' };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - t) > tolerance) return { valid: false, reason: 'stale' };

  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const actual = Buffer.from(v1, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { valid: false, reason: 'mismatch' };
  return { valid: true };
}
