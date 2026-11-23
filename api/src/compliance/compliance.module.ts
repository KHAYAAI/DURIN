import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { GatesController } from './gates.controller';
import { GatesService } from './gates.service';
import { DiditWebhookController } from './didit.controller';
import { ComplianceService, DIDIT_FETCH } from './compliance.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ComplianceController, DiditWebhookController, GatesController],
  providers: [ComplianceService, GatesService, { provide: DIDIT_FETCH, useValue: fetch }],
  exports: [ComplianceService, GatesService],
})
export class ComplianceModule {}
