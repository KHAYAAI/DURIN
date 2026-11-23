import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { SecurityHeadersMiddleware } from './hardening/security.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Versioned API under /v1; health remains at /health for probes
  app.setGlobalPrefix(process.env.API_PREFIX || 'v1', {
    exclude: ['health'],
  });

  app.use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`DURIN API listening on http://localhost:${port}`);
  console.log(`Health: GET http://localhost:${port}/health`);
  console.log(`Status: M0 Foundations — scaffold only`);
}

bootstrap();
