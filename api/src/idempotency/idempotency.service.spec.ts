import { describe, expect, it } from 'vitest';
import { IdempotencyService } from './idempotency.service';

// Behavioural tests against a real database live in test/idempotency.int.spec.ts.
describe('IdempotencyService.hashRequest', () => {
  const service = new IdempotencyService(undefined as never);

  it('is stable for the same method, URL and body', () => {
    const a = service.hashRequest('POST', '/v1/conversions', { quote_id: 'q1' });
    expect(service.hashRequest('POST', '/v1/conversions', { quote_id: 'q1' })).toBe(a);
  });

  it('differs when the body, URL or method differs', () => {
    const base = service.hashRequest('POST', '/v1/payment_intents/a/cancel', { x: 1 });
    expect(service.hashRequest('POST', '/v1/payment_intents/a/cancel', { x: 2 })).not.toBe(base);
    expect(service.hashRequest('POST', '/v1/payment_intents/b/cancel', { x: 1 })).not.toBe(base);
    expect(service.hashRequest('DELETE', '/v1/payment_intents/a/cancel', { x: 1 })).not.toBe(base);
  });

  it('treats a missing body as null', () => {
    expect(service.hashRequest('POST', '/v1/x', undefined)).toBe(service.hashRequest('POST', '/v1/x', null));
  });
});
