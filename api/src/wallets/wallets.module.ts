import { Module } from '@nestjs/common';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { Layer1Module } from '../providers/layer1/layer1.module';

@Module({
  imports: [AuthModule, LedgerModule, Layer1Module, ComplianceModule, WebhooksModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
