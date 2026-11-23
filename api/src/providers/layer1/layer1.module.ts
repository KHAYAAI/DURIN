import { Global, Module } from '@nestjs/common';
import { SandboxLayer1Adapter } from './sandbox.layer1';
import { Layer1Port } from './layer1.port';
import { OpenFireblocksLayer1Adapter } from './openfireblocks.layer1';

export const LAYER1_PORT = Symbol('LAYER1_PORT');

@Global()
@Module({
  providers: [
    {
      provide: LAYER1_PORT,
      useFactory: (): Layer1Port => {
        const mode = process.env.LAYER1_ADAPTER || 'sandbox';
        if (mode === 'openfireblocks') return OpenFireblocksLayer1Adapter.fromEnv();
        // Never fall back silently: an unknown adapter name must not turn into simulated custody.
        if (mode !== 'sandbox') throw new Error(`LAYER1_ADAPTER=${mode} has no registered adapter`);
        return new SandboxLayer1Adapter();
      },
    },
  ],
  exports: [LAYER1_PORT],
})
export class Layer1Module {}
