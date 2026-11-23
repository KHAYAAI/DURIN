import { Module } from '@nestjs/common';
import { ConversionsController } from './conversions.controller';
import { ConversionsService } from './conversions.service';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [AuthModule, LedgerModule, WebhooksModule, ComplianceModule],
  controllers: [ConversionsController],
  providers: [ConversionsService],
  exports: [ConversionsService],
})
export class ConversionsModule {}
