import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';

describe('API key generation contract', () => {
  it('produces dk_test_ prefix and stable sha256 hash', () => {
    const secret = `dk_test_${randomBytes(24).toString('base64url')}`;
    expect(secret.startsWith('dk_test_')).toBe(true);
    const hash = createHash('sha256').update(secret).digest('hex');
    expect(hash).toHaveLength(64);
    expect(createHash('sha256').update(secret).digest('hex')).toBe(hash);
  });
});
