import { randomBytes } from 'crypto';
import { ProviderOutcomeUnknown } from '../errors';
import type { CustodySnapshot } from '../custody-snapshot';
import type { FiatDepositInstruction, FiatPayoutParams, FiatPayoutResult, Layer2Port } from '../layer2/layer2.port';
import { ValrClient } from './valr-client';

/**
 * Layer 2 (rand) on VALR: ZAR deposited with a per-subaccount deposit reference, ZAR withdrawn to a
 * bank account that is ALREADY LINKED in VALR.
 *
 * Boundaries to understand before using:
 *  - ZAR held in VALR is held by VALR (a regulated exchange), not in a bank account DURIN controls. Whether this
 *    meets the "no customer fiat deposits" boundary is a counsel question.
 *  - Payouts only go to bank accounts linked in VALR. Linking from the API is OFF by default
 *    (VALR_ALLOW_API_BANK_LINKING) because it is a fraud-sensitive action; an unlinked beneficiary is a definitive rejection.
 *  - VALR's collection bank account details are not returned by the API: set VALR_ZAR_DEPOSIT_BANK
 *    ('{"bankAccountName":"…","bankAccountNumber":"…","branchCode":"…"}') from VALR's onboarding documents.
 *  - The fiat withdrawal API has no client reference: an unknown outcome is held and reconciled manually.
 */
export class ValrLayer2Adapter implements Layer2Port {
  readonly name = 'valr-zar';
  readonly mode = 'live' as const;

  constructor(
    private readonly client: ValrClient,
    private readonly opts: { depositBank: { bankAccountName: string; bankAccountNumber: string; branchCode?: string }; allowApiBankLinking?: boolean },
  ) {}

  static fromEnv(): ValrLayer2Adapter {
    const bank = process.env.VALR_ZAR_DEPOSIT_BANK;
    if (!bank) throw new Error('LAYER2_ADAPTER=valr needs VALR_ZAR_DEPOSIT_BANK (VALR collection account details)');
    return new ValrLayer2Adapter(ValrClient.fromEnv(), { depositBank: JSON.parse(bank), allowApiBankLinking: process.env.VALR_ALLOW_API_BANK_LINKING === 'true' });
  }

  /** One ZAR subaccount per organisation (label durin-<org>-zar), created on first use. */
  private async subaccountFor(organisationId: string): Promise<string> {
    const label = `durin-${organisationId}-zar`;
    const existing = (await this.client.listSubaccounts()).find((s) => s.label === label);
    if (existing) return existing.id;
    const r = await this.client.request('POST', '/v1/account/subaccount', { body: { label } });
    if (r.status === 200 && r.json?.id) return String(r.json.id);
    if (r.status === 403 && r.json?.code === -11132) { // raced with another creator
      const again = (await this.client.listSubaccounts()).find((s) => s.label === label);
      if (again) return again.id;
    }
    throw new Error(`VALR could not create the ZAR subaccount (${r.status})`);
  }

  async createDepositInstruction(params: { organisationId: string; amount: string; currency: 'ZAR' | 'USD' }): Promise<FiatDepositInstruction> {
    if (params.currency !== 'ZAR') throw new Error('VALR Layer 2 adapter supports ZAR only');
    const sub = await this.subaccountFor(params.organisationId);
    const r = await this.client.request('GET', '/v1/wallet/fiat/ZAR/deposit/reference', { subAccountId: sub });
    if (r.status !== 200 || !r.json?.reference) throw new Error(`VALR deposit reference failed (${r.status})`);
    return { reference: String(r.json.reference), ...this.opts.depositBank, amount: params.amount, currency: 'ZAR', mode: 'live' };
  }

  async initiatePayout(params: FiatPayoutParams): Promise<FiatPayoutResult> {
    if (params.currency !== 'ZAR') throw new Error('VALR Layer 2 adapter supports ZAR only');
    const sub = await this.subaccountFor(params.organisationId);
    const accounts = await this.client.request('GET', '/v1/wallet/fiat/ZAR/accounts', { subAccountId: sub });
    if (accounts.status !== 200 || !Array.isArray(accounts.json)) throw new Error(`VALR bank accounts failed (${accounts.status})`);
    const linked = (accounts.json as Array<{ id: string; accountNumber: string; branchCode?: string }>)
      .find((a) => a.accountNumber === params.beneficiaryAccount && (!params.beneficiaryBranch || a.branchCode === params.beneficiaryBranch));
    if (!linked) {
      if (!this.opts.allowApiBankLinking) return { providerRef: `rej_${randomBytes(4).toString('hex')}`, status: 'failed', failureReason: 'BENEFICIARY_NOT_LINKED: link this bank account in VALR first' };
      return { providerRef: `rej_${randomBytes(4).toString('hex')}`, status: 'failed', failureReason: 'API bank linking is not implemented' };
    }
    const w = await this.client.request('POST', '/v1/wallet/fiat/ZAR/withdraw', { subAccountId: sub, body: { linkedBankAccountId: linked.id, amount: params.amount, fast: true, allowBorrow: false } });
    if (w.status === 202 && w.json?.id) return { providerRef: String(w.json.id), status: 'accepted' };
    if (w.status >= 400 && w.status < 500 && ![401, 403, 429].includes(w.status)) {
      return { providerRef: `rej_${randomBytes(4).toString('hex')}`, status: 'failed', failureReason: `VALR ${w.json?.code ?? w.status}: ${String(w.json?.message ?? 'rejected').slice(0, 200)}` };
    }
    throw new ProviderOutcomeUnknown(`VALR fiat withdrawal returned ${w.status}`);
  }

  async getCustodyBalances(organisationId: string): Promise<CustodySnapshot> {
    const ids = (await this.client.listSubaccounts()).filter((s) => s.label.startsWith(`durin-${organisationId}-`)).map((s) => s.id);
    const totals = await this.client.totals(ids);
    return { asOf: new Date(), balances: [...totals].filter(([a]) => a === 'ZAR').map(([assetCode, available]) => ({ assetCode, available })) };
  }
}
