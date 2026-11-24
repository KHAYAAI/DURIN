import { Module } from '@nestjs/common';
import { DepositWatcherService, SOLANA_RPC } from './deposit-watcher.service';
import { WalletsModule } from '../wallets/wallets.module';

@Module({ imports: [WalletsModule], providers: [DepositWatcherService, { provide: SOLANA_RPC, useFactory: () => undefined }], exports: [DepositWatcherService] })
export class ChainsModule {}
