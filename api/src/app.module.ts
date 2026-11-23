import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { OrganisationsModule } from './organisations/organisations.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { WebhooksModule } from './webhooks/webhooks.module';
import { LedgerModule } from './ledger/ledger.module';
import { PaymentsModule } from './payments/payments.module';
import { ConversionsModule } from './conversions/conversions.module';
import { WalletsModule } from './wallets/wallets.module';
import { Layer1Module } from './providers/layer1/layer1.module';
import { ComplianceModule } from './compliance/compliance.module';
import { Layer2Module } from './providers/layer2/layer2.module';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { RateLimitGuard } from './hardening/rate-limit.guard';
import { MetaModule } from './meta/meta.module';
import { ProductionSafety } from './hardening/production.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    PrismaModule,
    AuthModule,
    HealthModule,
    OrganisationsModule,
    ApiKeysModule,
    IdempotencyModule,
    WebhooksModule,
    LedgerModule,
    PaymentsModule,
    ConversionsModule,
    Layer1Module,
    WalletsModule,
    ComplianceModule,
    Layer2Module,
    MetaModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
    ProductionSafety,
  ],
})
export class AppModule {}
