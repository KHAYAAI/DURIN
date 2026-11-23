import { describe, it, expect } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns ok status', () => {
    const controller = new HealthController();
    const result = controller.health();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('durin-api');
    expect(result.milestone).toBe('M0');
  });
});
