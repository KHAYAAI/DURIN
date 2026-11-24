import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { HouseService } from './house.service';
import { HouseExecutor } from './house-executor.service';
import { HouseController } from './house.controller';

@Module({
  imports: [AuthModule, LedgerModule, ComplianceModule],
  controllers: [HouseController],
  providers: [HouseService, HouseExecutor],
  exports: [HouseService, HouseExecutor],
})
export class HouseModule {}
