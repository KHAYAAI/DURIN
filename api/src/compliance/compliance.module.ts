import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { DiditWebhookController } from './didit.controller';
import { ComplianceService, DIDIT_FETCH } from './compliance.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ComplianceController, DiditWebhookController],
  providers: [ComplianceService, { provide: DIDIT_FETCH, useValue: fetch }],
  exports: [ComplianceService],
})
export class ComplianceModule {}
