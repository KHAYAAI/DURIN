import { Global, Module } from '@nestjs/common';
import { SandboxLayer2Adapter } from './sandbox.layer2';
import { Layer2Port } from './layer2.port';

export const LAYER2_PORT = Symbol('LAYER2_PORT');

@Global()
@Module({
  providers: [
    {
      provide: LAYER2_PORT,
      useFactory: (): Layer2Port => {
        const mode = process.env.LAYER2_ADAPTER || 'sandbox';
        if (mode !== 'sandbox') {
          console.warn(`LAYER2_ADAPTER=${mode} not configured; using sandbox (FORGE Mutual live adapter awaiting credentials)`);
        }
        return new SandboxLayer2Adapter();
      },
    },
  ],
  exports: [LAYER2_PORT],
})
export class Layer2Module {}
