import { createHash, randomBytes, timingSafeEqual, scryptSync } from 'crypto';

/**
 * API key hashing.
 * Prefer scrypt (Node built-in, memory-hard) — no external argon2 binary required in constrained envs.
 * Format: scrypt$N$r$p$salt_b64$hash_b64
 * Legacy SHA-256 hex still verified for keys created before upgrade.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

export function generateApiKeySecret(env: 'test' | 'live' = 'test'): string {
  return `dk_${env}_${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(raw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(raw, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyApiKey(raw: string, stored: string): boolean {
  try {
    if (stored.startsWith('scrypt$')) {
      const parts = stored.split('$');
      if (parts.length !== 6) return false;
      const N = parseInt(parts[1], 10);
      const r = parseInt(parts[2], 10);
      const p = parseInt(parts[3], 10);
      const salt = Buffer.from(parts[4], 'base64url');
      const expected = Buffer.from(parts[5], 'base64url');
      const actual = scryptSync(raw, salt, expected.length, { N, r, p });
      return timingSafeEqual(actual, expected);
    }
    // Legacy SHA-256
    const legacy = createHash('sha256').update(raw).digest('hex');
    const a = Buffer.from(legacy, 'hex');
    const b = Buffer.from(stored, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function keyPrefixOf(raw: string): string {
  return raw.slice(0, 12);
}
