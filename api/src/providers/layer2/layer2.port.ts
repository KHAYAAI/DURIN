/**
 * Layer 2 port — regulated fiat / FORGE Mutual bank interface.
 * DURIN never holds customer fiat deposits; it instructs Layer 2.
 */

export interface FiatDepositInstruction {
  reference: string;
  bankAccountName: string;
  bankAccountNumber: string;
  branchCode?: string;
  amount: string;
  currency: 'ZAR' | 'USD';
  mode: 'sandbox' | 'live';
}

export interface FiatPayoutParams {
  organisationId: string;
  amount: string;
  currency: 'ZAR' | 'USD';
  beneficiaryName: string;
  beneficiaryAccount: string;
  beneficiaryBranch?: string;
  reference?: string;
}

export interface FiatPayoutResult {
  providerRef: string;
  status: 'accepted' | 'settled' | 'failed';
  failureReason?: string;
}

export interface Layer2Port {
  readonly name: string;
  readonly mode: 'sandbox' | 'live';

  createDepositInstruction(params: {
    organisationId: string;
    amount: string;
    currency: 'ZAR' | 'USD';
  }): Promise<FiatDepositInstruction>;

  initiatePayout(params: FiatPayoutParams): Promise<FiatPayoutResult>;

  getSettlementBalance?(currency: 'ZAR' | 'USD'): Promise<{ available: string }>;
}
