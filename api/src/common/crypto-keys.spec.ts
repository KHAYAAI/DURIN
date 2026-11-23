import { describe, it, expect } from 'vitest';
import { generateApiKeySecret, hashApiKey, verifyApiKey, keyPrefixOf } from './crypto-keys';
import { createHash } from 'crypto';

describe('crypto-keys', () => {
  it('generates dk_test secrets', () => {
    const s = generateApiKeySecret('test');
    expect(s.startsWith('dk_test_')).toBe(true);
    expect(keyPrefixOf(s).length).toBe(12);
  });

  it('scrypt hash verifies', () => {
    const s = generateApiKeySecret();
    const h = hashApiKey(s);
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(verifyApiKey(s, h)).toBe(true);
    expect(verifyApiKey(s + 'x', h)).toBe(false);
  });

  it('still verifies legacy sha256', () => {
    const s = 'dk_test_legacyexample000000';
    const legacy = createHash('sha256').update(s).digest('hex');
    expect(verifyApiKey(s, legacy)).toBe(true);
  });
});
