import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

describe('Idempotency request hash', () => {
  it('is stable for same method/path/body', () => {
    const hash = (method: string, path: string, body: unknown) =>
      createHash('sha256')
        .update(JSON.stringify({ method, path, body: body ?? null }))
        .digest('hex');

    const a = hash('POST', '/v1/conversions', { quote_id: 'q1' });
    const b = hash('POST', '/v1/conversions', { quote_id: 'q1' });
    const c = hash('POST', '/v1/conversions', { quote_id: 'q2' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
