import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

/**
 * Environment for integration tests. Must be set before the application modules are imported
 * (some settings are read once at import time).
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DURIN_TEST_APP_URL;
process.env.RATE_LIMIT_PER_MINUTE = '1000000';
process.env.WEBHOOK_WORKER = 'false';
process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = 'true';
delete process.env.BOOTSTRAP_TOKEN;

export interface TestApp {
  app: NestExpressApplication;
  server: ReturnType<NestExpressApplication['getHttpServer']>;
  close(): Promise<void>;
}

export async function createTestApp(configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder): Promise<TestApp> {
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/app.config');
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (configure) builder = configure(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return { app, server: app.getHttpServer(), close: () => app.close() };
}

/** Thin authenticated client over supertest. */
export function client(t: TestApp, key?: string) {
  const withAuth = (r: request.Test, idem?: string) => {
    if (key) r.set('Authorization', `Bearer ${key}`);
    if (idem) r.set('Idempotency-Key', idem);
    return r;
  };
  return {
    get: (path: string) => withAuth(request(t.server).get(path)),
    post: (path: string, body?: object, idem?: string) => withAuth(request(t.server).post(path).send(body ?? {}), idem),
    del: (path: string) => withAuth(request(t.server).delete(path)),
  };
}

/** Creates an organisation through the public bootstrap endpoint and returns its admin key. */
export async function bootstrapOrg(t: TestApp, name = 'Test Org') {
  const res = await request(t.server).post('/v1/organisations').send({ name });
  if (res.status !== 201) throw new Error(`bootstrap failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { orgId: res.body.organisation.id as string, key: res.body.apiKey.secret as string, keyId: res.body.apiKey.id as string };
}
