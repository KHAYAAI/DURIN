import type { CustodySnapshot } from '../custody-snapshot';

/**
 * Layer 1 port — custody / wallet provider abstraction.
 * DURIN never holds private keys. All signing/custody is delegated.
 */

export interface CreateWalletParams {
  organisationId: string;
  label?: string;
}

export interface CreateAddressParams {
  walletExternalRef: string;
  assetCode: string;
  chain?: string;
}

export interface DepositAddressResult {
  address: string;
  chain: string;
  assetCode: string;
  providerRef: string;
}

export interface WithdrawalParams {
  organisationId?: string;
  walletExternalRef: string;
  assetCode: string;
  amount: string;
  destination: string;
  chain?: string;
  /** Caller-chosen id so a provider can de-duplicate retries of the same request. */
  clientReference?: string;
}

export interface WithdrawalResult {
  providerRef: string;
  status: 'submitted' | 'confirmed' | 'failed';
  txHash?: string;
  failureReason?: string;
}

export interface AssetBalance {
  assetCode: string;
  available: string;
  chain: string;
}

export interface Layer1Port {
  readonly name: string;
  readonly mode: 'sandbox' | 'live';

  createWallet(params: CreateWalletParams): Promise<{ externalRef: string }>;
  createDepositAddress(params: CreateAddressParams): Promise<DepositAddressResult>;
  getBalances(walletExternalRef: string): Promise<AssetBalance[]>;
  /** What the custodian itself reports holding for this organisation's customers (used by reconciliation). */
  getCustodyBalances(organisationId: string): Promise<CustodySnapshot>;
  requestWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult>;
  /** Sandbox helper: simulate an inbound deposit detection */
  simulateDeposit?(params: {
    address: string;
    assetCode: string;
    amount: string;
  }): Promise<{ detected: boolean; txHash: string }>;
}
