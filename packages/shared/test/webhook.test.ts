import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from '../src';

const secret = 'whsec_test_secret';
const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.settled' });

describe('webhook signatures', () => {
  it('verifies a freshly signed body', () => {
    expect(verifyWebhookSignature(secret, signWebhook(secret, body, 1000), body, { nowSeconds: 1000 })).toEqual({ valid: true });
  });
  it('rejects a tampered body, wrong secret, and stale timestamps', () => {
    const header = signWebhook(secret, body, 1000);
    expect(verifyWebhookSignature(secret, header, body + ' ', { nowSeconds: 1000 })).toEqual({ valid: false, reason: 'mismatch' });
    expect(verifyWebhookSignature('other', header, body, { nowSeconds: 1000 })).toEqual({ valid: false, reason: 'mismatch' });
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: 1000 + 301 })).toEqual({ valid: false, reason: 'stale' });
    expect(verifyWebhookSignature(secret, header, body, { nowSeconds: 1000 + 300 })).toEqual({ valid: true });
  });
  it('rejects malformed headers', () => {
    for (const h of [undefined, '', 'garbage', 't=abc,v1=zz', 't=1000', 'v1=' + 'a'.repeat(64)]) {
      expect(verifyWebhookSignature(secret, h, body, { nowSeconds: 1000 })).toEqual({ valid: false, reason: 'malformed' });
    }
  });
  it('binds the timestamp into the signature (cannot be replayed with a new t)', () => {
    const header = signWebhook(secret, body, 1000);
    const forged = header.replace('t=1000', 't=2000');
    expect(verifyWebhookSignature(secret, forged, body, { nowSeconds: 2000 })).toEqual({ valid: false, reason: 'mismatch' });
  });
});
