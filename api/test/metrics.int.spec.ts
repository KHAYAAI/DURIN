import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
beforeAll(async () => { process.env.METRICS_TOKEN = 'm'.repeat(32); t = await createTestApp(); });
afterAll(async () => { delete process.env.METRICS_TOKEN; await t?.close(); });

describe('/metrics', () => {
  it('requires the bearer token when one is configured', async () => {
    expect((await request(t.server).get('/metrics')).status).toBe(401);
    expect((await request(t.server).get('/metrics').set('Authorization', 'Bearer wrong')).status).toBe(401);
  });

  it('exposes business gauges and route-template request metrics without tenant data', async () => {
    const { key, orgId } = await bootstrapOrg(t, 'Metrics Org');
    await client(t, key).get('/v1/accounts');
    const res = await request(t.server).get('/metrics').set('Authorization', `Bearer ${'m'.repeat(32)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    for (const name of ['durin_conversions_provider_unknown', 'durin_reconciliation_open_breaks', 'durin_reconciliation_age_seconds', 'durin_webhook_backlog', 'durin_withdrawals_stuck']) {
      expect(res.text).toContain(`\n${name} `);
    }
    expect(res.text).toMatch(/durin_http_requests_total\{method="GET",route="\/v1\/accounts",status="2xx"\} \d+/);
    expect(res.text).not.toContain(orgId);
    expect(res.text).not.toContain(key);
  });
});
