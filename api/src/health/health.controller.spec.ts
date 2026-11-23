import { describe, it, expect } from 'vitest';
import { HealthController } from './health.controller';

const response = () => {
  const res = { code: 200, status(c: number) { res.code = c; return res; } };
  return res;
};

describe('HealthController', () => {
  it('is ok when the database answers', async () => {
    const controller = new HealthController({ $queryRaw: async () => [{ '?column?': 1 }] } as never);
    const res = response();
    const result = await controller.health(res);
    expect(result.status).toBe('ok');
    expect(result.database).toBe('up');
    expect(result.service).toBe('durin-api');
    expect(res.code).toBe(200);
  });

  it('returns 503 and degraded when the database is down', async () => {
    const controller = new HealthController({ $queryRaw: async () => { throw new Error('connection refused'); } } as never);
    const res = response();
    const result = await controller.health(res);
    expect(result.status).toBe('degraded');
    expect(result.database).toBe('down');
    expect(res.code).toBe(503);
  });
});
