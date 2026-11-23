import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { AuthController } from './auth.controller';
import { MfaService } from './mfa.service';
import { RealWorkosPort, WORKOS_KEYS, WORKOS_PORT } from './workos.port';
import { WorkosAuthService, workosJwksProvider } from './workos-auth.service';

@Module({
  controllers: [AuthController],
  providers: [
    ApiKeyGuard,
    MfaService,
    WorkosAuthService,
    { provide: WORKOS_PORT, useFactory: () => new RealWorkosPort() },
    { provide: WORKOS_KEYS, useFactory: () => workosJwksProvider() },
  ],
  exports: [ApiKeyGuard, WorkosAuthService, MfaService, WORKOS_PORT],
})
export class AuthModule {}
