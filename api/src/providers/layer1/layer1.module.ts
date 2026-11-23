import { Global, Module } from '@nestjs/common';
import { SandboxLayer1Adapter } from './sandbox.layer1';
import { Layer1Port } from './layer1.port';

export const LAYER1_PORT = Symbol('LAYER1_PORT');

@Global()
@Module({
  providers: [
    {
      provide: LAYER1_PORT,
      useFactory: (): Layer1Port => {
        const mode = process.env.LAYER1_ADAPTER || 'sandbox';
        if (mode !== 'sandbox') {
          // Live adapters registered when credentials exist
          console.warn(`LAYER1_ADAPTER=${mode} not configured; falling back to sandbox`);
        }
        return new SandboxLayer1Adapter();
      },
    },
  ],
  exports: [LAYER1_PORT],
})
export class Layer1Module {}
