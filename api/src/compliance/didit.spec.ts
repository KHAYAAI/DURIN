import { describe, expect, it } from 'vitest';
import { canonicalJson, mapDiditStatus, signDiditV2, verifyDiditSignature } from './didit';

// Vector computed independently with Python: json.dumps(sort_keys, compact, ensure_ascii=False) + HMAC-SHA256.
const body = {
  event_id: '9c0c8b8a-1111-4222-9333-444444444444', webhook_type: 'status.updated', timestamp: 1774970000,
  session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'Approved', vendor_data: 'user-123',
  decision: { z: {}, a: [{ name: 'José', url: 'https://media.didit.me/x' }], b: 1 },
};
const GOLDEN = '5008ab7655af0eb6e65970e2fcb203235a1967505619958166381be7f68eacb4';

describe('Didit X-Signature-V2', () => {
  it('canonicalises with sorted keys, compact output, Unicode and slashes preserved, empty objects kept', () => {
    expect(canonicalJson(body)).toBe('{"decision":{"a":[{"name":"José","url":"https://media.didit.me/x"}],"b":1,"z":{}},"event_id":"9c0c8b8a-1111-4222-9333-444444444444","session_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","status":"Approved","timestamp":1774970000,"vendor_data":"user-123","webhook_type":"status.updated"}');
  });
  it('matches the independent golden signature', () => {
    expect(signDiditV2(body, 'test-secret')).toBe(GOLDEN);
  });
  it('verifies, with secret rotation overlap', () => {
    const base = { body, signature: GOLDEN, timestamp: '1774970000', now: 1774970100 };
    expect(verifyDiditSignature({ ...base, secrets: ['test-secret'] })).toBe(true);
    expect(verifyDiditSignature({ ...base, secrets: ['new', 'test-secret'] })).toBe(true);
  });
  it('rejects wrong secret, tampered body, missing headers, stale timestamps', () => {
    const base = { body, signature: GOLDEN, timestamp: '1774970000', now: 1774970100, secrets: ['test-secret'] };
    expect(verifyDiditSignature({ ...base, secrets: ['other'] })).toBe(false);
    expect(verifyDiditSignature({ ...base, body: { ...body, status: 'Declined' } })).toBe(false);
    expect(verifyDiditSignature({ ...base, signature: undefined })).toBe(false);
    expect(verifyDiditSignature({ ...base, timestamp: undefined })).toBe(false);
    expect(verifyDiditSignature({ ...base, now: 1774970000 + 301 })).toBe(false);
    expect(verifyDiditSignature({ ...base, secrets: [] })).toBe(false);
  });
  it('maps statuses conservatively', () => {
    expect(mapDiditStatus('Approved')).toBe('approved');
    expect(mapDiditStatus('Declined')).toBe('rejected');
    expect(mapDiditStatus('In Review')).toBe('pending');
    expect(mapDiditStatus('Abandoned')).toBe('expired');
    expect(mapDiditStatus('Something New')).toBe('pending');
  });
});
