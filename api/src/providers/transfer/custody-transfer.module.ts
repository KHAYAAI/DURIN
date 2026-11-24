import { Global, Module } from '@nestjs/common';
import { CUSTODY_TRANSFER_PORT, type CustodyTransferPort } from './custody-transfer.port';
import { SandboxCustodyTransferAdapter } from './sandbox.custody-transfer';

@Global()
@Module({
  providers: [{
    provide: CUSTODY_TRANSFER_PORT,
    useFactory: (): CustodyTransferPort => {
      const mode = process.env.CUSTODY_TRANSFER_ADAPTER || 'sandbox';
      if (mode !== 'sandbox') throw new Error(`CUSTODY_TRANSFER_ADAPTER=${mode} has no registered adapter (house dealing and netting stay sandbox-only)`);
      return new SandboxCustodyTransferAdapter();
    },
  }],
  exports: [CUSTODY_TRANSFER_PORT],
})
export class CustodyTransferModule {}
