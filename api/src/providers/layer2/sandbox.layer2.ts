import { randomBytes } from 'crypto';
import { sandboxCustody } from '../sandbox-custody';
import {
  FiatDepositInstruction,
  FiatPayoutParams,
  FiatPayoutResult,
  Layer2Port,
} from './layer2.port';

/**
 * Sandbox FORGE Mutual / bank adapter.
 * Status: simulated — not connected to a real sponsor bank.
 */
export class SandboxLayer2Adapter implements Layer2Port {
  readonly name = 'forge-mutual-sandbox';
  readonly mode = 'sandbox' as const;

  async createDepositInstruction(params: {
    organisationId: string;
    amount: string;
    currency: 'ZAR' | 'USD';
  }): Promise<FiatDepositInstruction> {
    const ref = `FM-SBX-${randomBytes(4).toString('hex').toUpperCase()}`;
    return {
      reference: ref,
      bankAccountName: 'DURIN Sandbox Collection',
      bankAccountNumber: '0000000000',
      branchCode: '000000',
      amount: params.amount,
      currency: params.currency,
      mode: 'sandbox',
    };
  }

  async initiatePayout(_params: FiatPayoutParams): Promise<FiatPayoutResult> {
    return {
      providerRef: `fm_pay_${randomBytes(6).toString('hex')}`,
      status: 'settled',
    };
  }

  async getCustodyBalances(organisationId: string) {
    return { asOf: new Date(), balances: sandboxCustody.assets(organisationId).filter((a) => a === 'ZAR' || a === 'USD').map((assetCode) => ({ assetCode, available: sandboxCustody.get(organisationId, assetCode) })) };
  }
}
