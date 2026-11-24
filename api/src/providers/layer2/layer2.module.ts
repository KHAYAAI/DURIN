import { Global, Module } from '@nestjs/common';
import { SandboxLayer2Adapter } from './sandbox.layer2';
import { ValrLayer2Adapter } from '../valr/valr.layer2';
import { Layer2Port } from './layer2.port';

export const LAYER2_PORT = Symbol('LAYER2_PORT');

@Global()
@Module({
  providers: [
    {
      provide: LAYER2_PORT,
      useFactory: (): Layer2Port => {
        const mode = process.env.LAYER2_ADAPTER || 'sandbox';
        if (mode === 'valr') return ValrLayer2Adapter.fromEnv();
        // Never fall back silently: an unknown adapter name must not turn into simulated fiat.
        if (mode !== 'sandbox') throw new Error(`LAYER2_ADAPTER=${mode} has no registered adapter`);
        return new SandboxLayer2Adapter();
      },
    },
  ],
  exports: [LAYER2_PORT],
})
export class Layer2Module {}
