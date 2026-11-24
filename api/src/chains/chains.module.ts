import { Module } from '@nestjs/common';
import { DepositWatcherService, SOLANA_RPC } from './deposit-watcher.service';
import { EVM_RPC, EvmDepositWatcherService } from './evm-watcher.service';
import { ComplianceModule } from '../compliance/compliance.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({ imports: [WalletsModule, ComplianceModule], providers: [DepositWatcherService, EvmDepositWatcherService, { provide: SOLANA_RPC, useFactory: () => undefined }, { provide: EVM_RPC, useFactory: () => undefined }], exports: [DepositWatcherService, EvmDepositWatcherService] })
export class ChainsModule {}
