import { randomBytes } from 'crypto';
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

  async createWallet(params: CreateWalletParams): Promise<{ externalRef: string }> {
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

  async requestWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult> {
    const map = this.balances.get(params.walletExternalRef) ?? new Map();
    const current = Number(map.get(params.assetCode.toUpperCase()) ?? '0');
    const amount = Number(params.amount);
    if (amount > current) {
      // In pure sandbox we still "submit" — platform ledger enforces funds
    }
    const txHash = `0xsim${randomBytes(16).toString('hex')}`;
    const next = Math.max(0, current - amount);
    map.set(params.assetCode.toUpperCase(), next.toFixed(8));
    this.balances.set(params.walletExternalRef, map);

    return {
      providerRef: `sbx_wd_${randomBytes(6).toString('hex')}`,
      status: 'confirmed',
      txHash,
    };
  }

  async simulateDeposit(params: {
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
