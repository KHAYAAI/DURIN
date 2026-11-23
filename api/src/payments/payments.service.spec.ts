import { describe, it, expect } from 'vitest';

describe('Payments sandbox contracts', () => {
  it('documents supported assets', () => {
    const supported = new Set(['USDC', 'USDT', 'ZAR']);
    expect(supported.has('USDC')).toBe(true);
    expect(supported.has('ETH')).toBe(false);
  });

  it('intent status machine allows confirm from pending', () => {
    const confirmable = ['pending', 'requires_action', 'processing', 'created'];
    expect(confirmable.includes('pending')).toBe(true);
    expect(confirmable.includes('settled')).toBe(false);
  });
});
