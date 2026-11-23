import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { recordRequest } from './metrics/http-metrics';

/** Shared by main.ts and the integration tests so both run the exact same HTTP configuration. */
export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  // Versioned API under /v1; health remains at /health for probes
  app.setGlobalPrefix(process.env.API_PREFIX || 'v1', { exclude: ['health', 'metrics'] });

  // Request metrics: route TEMPLATE (never raw URLs/ids) to keep cardinality bounded.
  app.use((req: { method: string; baseUrl?: string; route?: { path?: string } }, res: { statusCode: number; on(e: string, f: () => void): void }, next: () => void) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
      if (route === '/metrics') return;
      recordRequest(req.method, route, res.statusCode, Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  });

  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  });

  // Server-to-server API: browsers are only allowed from explicitly configured origins.
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length) {
    app.enableCors({
      origin: origins,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    });
  }

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
