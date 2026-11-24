import { Module } from '@nestjs/common';
import { ConversionsController } from './conversions.controller';
import { NettingService } from './netting.service';
import { ConversionsService } from './conversions.service';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { HouseModule } from '../house/house.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [AuthModule, LedgerModule, WebhooksModule, ComplianceModule, HouseModule],
  controllers: [ConversionsController],
  providers: [ConversionsService, NettingService],
  exports: [ConversionsService],
})
export class ConversionsModule {}
