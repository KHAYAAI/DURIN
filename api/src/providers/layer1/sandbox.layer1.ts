import { randomBytes } from 'crypto';
import { cmp, sub } from '@durin/ledger';
import { sandboxCustody } from '../sandbox-custody';
import {
  AssetBalance,
  CreateAddressParams,
  CreateWalletParams,
  DepositAddressResult,
  Layer1Port,
  WithdrawalParams,
  WithdrawalResult,
} from './layer1.port';

/**
 * Sandbox Layer 1 adapter.
 * Status: simulated — no real keys, no chain broadcast.
 */
export class SandboxLayer1Adapter implements Layer1Port {
  readonly name = 'sandbox';
  readonly mode = 'sandbox' as const;

  private balances = new Map<string, Map<string, string>>(); // walletRef -> asset -> amount
  private withdrawals = new Map<string, WithdrawalResult>(); // clientReference -> result (provider-side idempotency)

  async createWallet(_params: CreateWalletParams): Promise<{ externalRef: string }> {
    const externalRef = `sbx_wallet_${randomBytes(8).toString('hex')}`;
    this.balances.set(externalRef, new Map());
    return { externalRef };
  }

  async createDepositAddress(params: CreateAddressParams): Promise<DepositAddressResult> {
    const chain = params.chain ?? 'ethereum-sepolia';
    const suffix = randomBytes(10).toString('hex');
    const address =
      chain.includes('solana')
        ? `Sbx${suffix}`
        : `0xSBX${suffix}`;
    return {
      address,
      chain,
      assetCode: params.assetCode.toUpperCase(),
      providerRef: `sbx_addr_${suffix}`,
    };
  }

  async getBalances(walletExternalRef: string): Promise<AssetBalance[]> {
    const map = this.balances.get(walletExternalRef) ?? new Map();
    return [...map.entries()].map(([assetCode, available]) => ({
      assetCode,
      available,
      chain: 'ethereum-sepolia',
    }));
  }

  async getCustodyBalances(organisationId: string) {
    return { asOf: new Date(), balances: sandboxCustody.assets(organisationId).filter((a) => a !== 'ZAR' && a !== 'USD').map((assetCode) => ({ assetCode, available: sandboxCustody.get(organisationId, assetCode) })) };
  }

  async requestWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult> {
    const dedupeKey = params.clientReference ? `${params.organisationId ?? ''}:${params.clientReference}` : undefined;
    const prior = dedupeKey ? this.withdrawals.get(dedupeKey) : undefined;
    if (prior) return prior;
    const map = this.balances.get(params.walletExternalRef) ?? new Map();
    const current = map.get(params.assetCode.toUpperCase()) ?? '0';
    // In pure sandbox we still "submit" when the simulated balance is short; the platform
    // ledger is what enforces customer funds. The simulated balance floors at zero.
    const next = cmp(current, params.amount) >= 0 ? sub(current, params.amount) : '0';
    if (params.organisationId) sandboxCustody.debit(params.organisationId, params.assetCode, params.amount);
    const txHash = `0xsim${randomBytes(16).toString('hex')}`;
    map.set(params.assetCode.toUpperCase(), next);
    this.balances.set(params.walletExternalRef, map);

    const result: WithdrawalResult = {
      providerRef: `sbx_wd_${randomBytes(6).toString('hex')}`,
      status: 'confirmed',
      txHash,
    };
    if (dedupeKey) this.withdrawals.set(dedupeKey, result);
    return result;
  }

  async simulateDeposit(_params: {
    address: string;
    assetCode: string;
    amount: string;
  }): Promise<{ detected: boolean; txHash: string }> {
    return {
      detected: true,
      txHash: `0xdep${randomBytes(16).toString('hex')}`,
    };
  }
}
