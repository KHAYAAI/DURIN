import { Module } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationWorker } from './reconciliation.worker';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [AuthModule, LedgerModule, WebhooksModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationWorker],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
