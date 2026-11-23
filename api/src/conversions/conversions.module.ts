import { Module } from '@nestjs/common';
import { ConversionsController } from './conversions.controller';
import { ConversionsService } from './conversions.service';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [ConversionsController],
  providers: [ConversionsService],
  exports: [ConversionsService],
})
export class ConversionsModule {}
