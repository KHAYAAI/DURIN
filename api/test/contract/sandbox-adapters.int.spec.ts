import { randomUUID } from 'crypto';
import { layer1Contract, layer2Contract, liquidityContract } from './adapter-contracts';
import { SandboxLayer1Adapter } from '../../src/providers/layer1/sandbox.layer1';
import { SandboxLayer2Adapter } from '../../src/providers/layer2/sandbox.layer2';
import { SandboxLiquidityAdapter } from '../../src/providers/liquidity/sandbox.liquidity';

layer1Contract('sandbox', async () => ({ port: new SandboxLayer1Adapter(), org: randomUUID() }));
layer2Contract('sandbox', async () => ({ port: new SandboxLayer2Adapter(), org: randomUUID() }));
liquidityContract('sandbox', async () => ({ port: new SandboxLiquidityAdapter(), org: randomUUID() }));

// A live adapter's spec would look like (run only against the vendor's SANDBOX environment):
//   if (process.env.LIVE_ADAPTER_CONTRACT === '1') layer1Contract('openfireblocks', async () => ({ port: new LiveLayer1(...), org: process.env.CONTRACT_ORG! }));
