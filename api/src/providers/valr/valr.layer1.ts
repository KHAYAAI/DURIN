import { randomBytes } from 'crypto';
import { ProviderOutcomeUnknown } from '../errors';
import type { CustodySnapshot } from '../custody-snapshot';
import type { AssetBalance, CreateAddressParams, CreateWalletParams, DepositAddressResult, Layer1Port, WithdrawalParams, WithdrawalResult } from '../layer1/layer1.port';
import { ValrClient } from './valr-client';

/**
 * Layer 1 on VALR: one VALR SUBACCOUNT per DURIN wallet (label `durin-<organisationId>-<rand>`), so every
 * customer's balances and deposit addresses are separate and reconcilable per organisation.
 *
 * Requires a PRIMARY-account API key with Trade + Withdraw permissions (subaccount creation and impersonation).
 *
 * IMPORTANT DIFFERENCES FROM A SELF-HOSTED CUSTODIAN
 *  - VALR is a custodial exchange: funds are held by VALR, not in keys DURIN or you control. Whether that
 *    satisfies your custody requirements is a counsel/risk decision.
 *  - VALR's crypto withdrawal API has NO client reference/idempotency key. DURIN never retries a withdrawal whose
 *    outcome is unknown (funds stay held for manual reconciliation against VALR's withdrawal history), but this
 *    adapter cannot make a repeated call safe by itself.
 *  - Withdrawals may need the destination address whitelisted/address-booked in VALR first (verify for your account).
 *  - Network names (`Solana`, `Ethereum`) come from GET /v1/public/currencies `supportedNetworks`; override with
 *    VALR_NETWORK_MAP='{"solana":"Solana"}' if VALR spells them differently. VERIFY before use.
 *  - Deposit detection: poll GET /v1/wallet/crypto/deposit/history or use VALR webhooks (beta). Not built here.
 */
const CRYPTO_ASSETS = new Set(['USDC', 'USDT']);

export class ValrLayer1Adapter implements Layer1Port {
  readonly name = 'valr';
  readonly mode = 'live' as const;
  private readonly networks: Record<string, string>;

  constructor(private readonly client: ValrClient, networks?: Record<string, string>) {
    this.networks = { solana: 'Solana', ethereum: 'Ethereum', 'solana-devnet': 'Solana', ...(networks ?? {}) };
  }

  static fromEnv(): ValrLayer1Adapter {
    return new ValrLayer1Adapter(ValrClient.fromEnv(), process.env.VALR_NETWORK_MAP ? JSON.parse(process.env.VALR_NETWORK_MAP) : undefined);
  }

  async createWallet(params: CreateWalletParams): Promise<{ externalRef: string }> {
    const label = `durin-${params.organisationId}-${randomBytes(4).toString('hex')}`; // letters, digits, hyphens; ≤ 64
    const r = await this.client.request('POST', '/v1/account/subaccount', { body: { label } });
    if (r.status !== 200 || !r.json?.id) throw new Error(`VALR createWallet failed (${r.status})`);
    return { externalRef: String(r.json.id) };
  }

  async createDepositAddress(params: CreateAddressParams): Promise<DepositAddressResult> {
    const chain = (params.chain ?? 'solana').toLowerCase();
    const networkType = this.networks[chain];
    if (!networkType) throw new Error(`VALR adapter has no network mapping for ${chain}`);
    const asset = params.assetCode.toUpperCase();
    if (!CRYPTO_ASSETS.has(asset)) throw new Error(`Unsupported asset ${asset}`);
    const r = await this.client.request('GET', `/v1/wallet/crypto/${asset}/deposit/address?networkType=${encodeURIComponent(networkType)}`, { subAccountId: params.walletExternalRef });
    if (r.status !== 200 || !r.json?.address) throw new Error(`VALR deposit address failed (${r.status})`);
    if (String(r.json.networkType ?? networkType).toLowerCase() !== networkType.toLowerCase()) throw new Error('VALR returned an address on a different network');
    return { address: String(r.json.address), chain, assetCode: asset, providerRef: `${params.walletExternalRef}:${asset}:${networkType}` };
  }

  async getBalances(walletExternalRef: string): Promise<AssetBalance[]> {
    const totals = await this.client.totals([walletExternalRef]);
    return [...totals].filter(([a]) => CRYPTO_ASSETS.has(a)).map(([assetCode, available]) => ({ assetCode, available, chain: 'multi' }));
  }

  async getCustodyBalances(organisationId: string): Promise<CustodySnapshot> {
    const prefix = `durin-${organisationId}-`;
    const ids = (await this.client.listSubaccounts()).filter((s) => s.label.startsWith(prefix)).map((s) => s.id);
    const totals = await this.client.totals(ids);
    return { asOf: new Date(), balances: [...totals].filter(([a]) => CRYPTO_ASSETS.has(a)).map(([assetCode, available]) => ({ assetCode, available })) };
  }

  async requestWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult> {
    const chain = (params.chain ?? 'solana').toLowerCase();
    const networkType = this.networks[chain];
    const asset = params.assetCode.toUpperCase();
    if (!networkType || !CRYPTO_ASSETS.has(asset)) throw new Error(`VALR adapter cannot withdraw ${asset} on ${chain}`);
    const r = await this.client.request('POST', `/v1/wallet/crypto/${asset}/withdraw`, {
      subAccountId: params.walletExternalRef,
      body: { amount: params.amount, address: params.destination, networkType, allowBorrow: false },
    });
    if (r.status === 202 && r.json?.id) return { providerRef: String(r.json.id), status: 'submitted' };
    if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 429) {
      return { providerRef: params.clientReference ?? 'rejected', status: 'failed', failureReason: `VALR ${r.json?.code ?? r.status}: ${String(r.json?.message ?? 'rejected').slice(0, 200)}` };
    }
    // 401/403/429 or anything unexpected: the request may or may not have been processed.
    throw new ProviderOutcomeUnknown(`VALR withdrawal returned ${r.status}`);
  }
}
