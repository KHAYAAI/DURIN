import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
  const log = new Logger('Bootstrap');
  log.log(`DURIN API listening on :${port}  (health: /health, version: /v1/version)`);
  log.log(`Mode: ${process.env.NODE_ENV === 'production' ? 'production' : 'sandbox — all money movement is simulated'}`);
}

void bootstrap();
