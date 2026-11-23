import { Global, Module } from '@nestjs/common';
import { LiquidityPort } from './liquidity.port';
import { SandboxLiquidityAdapter } from './sandbox.liquidity';

export const LIQUIDITY_PORT = Symbol('LIQUIDITY_PORT');

@Global()
@Module({
  providers: [
    {
      provide: LIQUIDITY_PORT,
      useFactory: (): LiquidityPort => {
        const mode = process.env.LIQUIDITY_ADAPTER || 'sandbox';
        if (mode !== 'sandbox') {
          throw new Error(`LIQUIDITY_ADAPTER=${mode} has no registered adapter. Implement LiquidityPort for your provider.`);
        }
        return new SandboxLiquidityAdapter();
      },
    },
  ],
  exports: [LIQUIDITY_PORT],
})
export class LiquidityModule {}
