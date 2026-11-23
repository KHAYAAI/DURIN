import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Reversible encryption for secrets we must be able to read back (e.g. webhook signing
 * secrets). AES-256-GCM with a random 96-bit IV per value. Format: v1.<iv>.<tag>.<ciphertext>.
 *
 * The key comes from DURIN_ENCRYPTION_KEY (32 random bytes, base64). It is required in
 * production. Outside production a fixed development key is used, with a warning.
 */
let warnedAboutDevKey = false;

function encryptionKey(): Buffer {
  const configured = process.env.DURIN_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32) throw new Error('DURIN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    return key;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DURIN_ENCRYPTION_KEY is required in production');
  }
  if (!warnedAboutDevKey) {
    warnedAboutDevKey = true;
    console.warn('[durin] DURIN_ENCRYPTION_KEY is not set; using an insecure development key.');
  }
  return createHash('sha256').update('durin-development-only-key').digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(encrypted: string): string {
  const [version, iv, tag, ciphertext] = encrypted.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
