import { randomBytes } from 'crypto';
import { sandboxCustody } from '../sandbox-custody';
import {
  LiquidityOrderLookup,
  LiquidityOrderParams,
  LiquidityOrderResult,
  LiquidityPort,
} from './liquidity.port';

export type SandboxFault = 'reject' | 'throw_before' | 'throw_after';

/** SIMULATED liquidity provider. Fills instantly at the quoted amounts. Not a market. */
export class SandboxLiquidityAdapter implements LiquidityPort {
  readonly name = 'sandbox-lp';
  readonly mode = 'sandbox' as const;
  private orders = new Map<string, LiquidityOrderLookup>();
  private fault?: SandboxFault;

  /** Test hook: make the next execute() misbehave. */
  injectFault(f: SandboxFault | undefined) { this.fault = f; }

  async execute(p: LiquidityOrderParams): Promise<LiquidityOrderResult> {
    const key = `${p.organisationId}:${p.clientReference}`;
    const prior = this.orders.get(key);
    if (prior && prior.status !== 'pending') return { status: prior.status as 'filled' | 'rejected', providerRef: prior.providerRef, reason: prior.reason };
    const fault = this.fault; this.fault = undefined;
    if (fault === 'throw_before') throw new Error('LP timeout (order not executed)');
    if (fault === 'reject') {
      const r = { status: 'rejected' as const, reason: 'LP_REJECTED' };
      this.orders.set(key, r);
      return r;
    }
    const providerRef = `sbx_lp_${randomBytes(6).toString('hex')}`;
    this.orders.set(key, { status: 'filled', providerRef });
    // The funds really move at the custodian when the LP settles; mirror that in the sandbox.
    sandboxCustody.debit(p.organisationId, p.sourceAsset, p.sourceAmount);
    sandboxCustody.credit(p.organisationId, p.targetAsset, p.targetAmount);
    if (fault === 'throw_after') throw new Error('LP connection reset after execution');
    return { status: 'filled', providerRef };
  }

  async getOrder(organisationId: string, clientReference: string): Promise<LiquidityOrderLookup> {
    return this.orders.get(`${organisationId}:${clientReference}`) ?? { status: 'not_found' };
  }
}
