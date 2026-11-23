import { randomUUID } from 'crypto';
import {
  AssetBalance, CreateAddressParams, CreateWalletParams, DepositAddressResult, Layer1Port, WithdrawalParams, WithdrawalResult,
} from './layer1.port';
import type { CustodySnapshot } from '../custody-snapshot';

/**
 * Layer 1 adapter for OpenFireblocks (https://github.com/KHAYAAI/openfireblocks): per-user threshold
 * wallets over the "user wallets" HTTP API (docs/USER-WALLETS-AND-SOLANA-TOKENS.md).
 *
 * WHAT IS SUPPORTED, AND WHAT IS NOT (read before enabling):
 *  - SOLANA only (SOL + SPL tokens such as USDC). The wallet transfer route accepts native EVM sends
 *    only; ERC-20 sends (USDC on Ethereum) are not exposed through `/wallets/:id/transfers`, so this
 *    adapter REFUSES them rather than guessing a route. Set ENABLED_CHAINS=USDC:solana.
 *  - NO DEPOSIT DETECTION: OpenFireblocks emits no inbound-deposit event today. Crediting customers
 *    for deposits needs either such an event or a DURIN-side chain watcher; neither exists yet.
 *  - A transfer that needs human approval (HTTP 202 `pending_approval`) is treated as an UNKNOWN
 *    outcome (this adapter throws): funds stay held and nothing is reversed or retried, until the
 *    `transfer.*` webhooks are handled. Configure the DURIN tenant so its transfers do not need approval,
 *    or accept manual resolution.
 *  - Response shapes were taken from the OpenFireblocks source, not from a live server. VALIDATE
 *    against its staging environment before relying on this (the contract suite in test/contract runs
 *    against a fake that mirrors the documented shapes only).
 */
const SOLANA_CHAINS = new Set(['solana', 'solana-devnet']);
const DEFINITIVE_REJECTIONS = new Set([400, 403, 404, 409, 422]);
const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6, SOL: 9 };

export class ProviderOutcomeUnknown extends Error {}

type Json = Record<string, unknown>;

export class OpenFireblocksLayer1Adapter implements Layer1Port {
  readonly name = 'openfireblocks';
  readonly mode = 'live' as const;

  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; timeoutMs?: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(): OpenFireblocksLayer1Adapter {
    const baseUrl = process.env.OPENFIREBLOCKS_URL;
    const apiKey = process.env.OPENFIREBLOCKS_API_KEY;
    if (!baseUrl || !apiKey) throw new Error('LAYER1_ADAPTER=openfireblocks needs OPENFIREBLOCKS_URL and OPENFIREBLOCKS_API_KEY');
    return new OpenFireblocksLayer1Adapter({ baseUrl, apiKey });
  }

  private async http(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'X-API-Key': this.cfg.apiKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
      });
    } catch (e) {
      // Timeout / network: for a write the request may have been processed.
      throw new ProviderOutcomeUnknown(`openfireblocks ${method} ${path}: ${e instanceof Error ? e.message : 'network error'}`);
    }
    let json: Json = {};
    try { json = (await res.json()) as Json; } catch { /* empty body */ }
    return { status: res.status, json };
  }

  async createWallet(params: CreateWalletParams): Promise<{ externalRef: string }> {
    const externalRef = `durin:${params.organisationId}:${randomUUID()}`;
    const { status, json } = await this.http('POST', '/wallets', { externalRef, label: params.label?.slice(0, 120), blockchains: ['solana'] });
    if (status !== 201 && status !== 200) throw new Error(`openfireblocks createWallet failed (${status})`);
    const id = (json.wallet_id ?? json.walletId) as string | undefined;
    if (!id) throw new Error('openfireblocks createWallet: no wallet id in response');
    // The port's externalRef is OpenFireblocks' wallet id (used in every later call).
    return { externalRef: id };
  }

  async createDepositAddress(params: CreateAddressParams): Promise<DepositAddressResult> {
    const chain = (params.chain ?? 'solana').toLowerCase();
    if (!SOLANA_CHAINS.has(chain)) throw new Error(`openfireblocks adapter supports Solana only (got ${chain})`);
    const { status, json } = await this.http('GET', `/wallets/${encodeURIComponent(params.walletExternalRef)}/addresses`);
    if (status !== 200) throw new Error(`openfireblocks addresses failed (${status})`);
    const entry = ((json.chains as Json[] | undefined) ?? []).find((c) => c.blockchain === 'solana');
    if (!entry || entry.status !== 'active') throw new Error('Solana key is not active yet (DKG ceremony pending); retry shortly');
    const address = firstAddress(entry.addresses);
    if (!address) throw new Error('openfireblocks returned no Solana address');
    return { address, chain, assetCode: params.assetCode.toUpperCase(), providerRef: String(entry.key_id ?? params.walletExternalRef) };
  }

  async getBalances(walletExternalRef: string): Promise<AssetBalance[]> {
    const { status, json } = await this.http('GET', `/wallets/${encodeURIComponent(walletExternalRef)}/balances`);
    if (status !== 200) throw new Error(`openfireblocks balances failed (${status})`);
    return flattenBalances(json).map((b) => ({ assetCode: b.asset, available: b.available, chain: 'solana' }));
  }

  /** Sum of what OpenFireblocks reports for every DURIN wallet of this organisation (external_ref `durin:<org>:*`). */
  async getCustodyBalances(organisationId: string): Promise<CustodySnapshot> {
    const prefix = `durin:${organisationId}:`;
    const totals = new Map<string, bigint>();
    let before: string | undefined;
    for (let page = 0; page < 200; page++) {
      const { status, json } = await this.http('GET', `/wallets?limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (status !== 200) throw new Error(`openfireblocks list wallets failed (${status})`);
      for (const w of (json.wallets as Json[] | undefined) ?? []) {
        if (typeof w.external_ref !== 'string' || !w.external_ref.startsWith(prefix)) continue;
        const bal = await this.http('GET', `/wallets/${encodeURIComponent(String(w.wallet_id))}/balances`);
        if (bal.status !== 200) throw new Error(`openfireblocks balances failed (${bal.status})`);
        for (const b of flattenBalances(bal.json)) {
          if (b.asset === 'SOL') continue; // gas balance is not a customer asset
          totals.set(b.asset, (totals.get(b.asset) ?? 0n) + b.units * 10n ** BigInt(18 - b.decimals));
        }
      }
      before = (json.next as string | null | undefined) ?? undefined;
      if (!before) break;
      if (page === 199) throw new Error('openfireblocks wallet listing did not terminate');
    }
    // The provider returns no timestamp, so asOf is the time WE read it: freshness is only as good as that.
    return { asOf: new Date(), balances: [...totals].map(([assetCode, v]) => ({ assetCode, available: fromScaled(v) })) };
  }

  async requestWithdrawal(params: WithdrawalParams): Promise<WithdrawalResult> {
    const chain = (params.chain ?? 'solana').toLowerCase();
    if (!SOLANA_CHAINS.has(chain)) throw new Error(`openfireblocks adapter supports Solana only (got ${chain})`);
    const asset = params.assetCode.toUpperCase();
    const decimals = DECIMALS[asset];
    if (!decimals || asset === 'SOL') throw new Error(`Unsupported asset ${asset}`);
    const units = toUnits(params.amount, decimals);

    const { status, json } = await this.http('POST', `/wallets/${encodeURIComponent(params.walletExternalRef)}/transfers`, {
      blockchain: 'solana', destination: params.destination, amount: units, token: asset, idempotencyKey: params.clientReference,
    });

    if (status === 202 || json.status === 'pending_approval') {
      throw new ProviderOutcomeUnknown(`openfireblocks transfer needs approval (approvalId ${String(json.approvalId ?? 'unknown')}); not auto-resolved`);
    }
    if (status === 200 && json.status === 'completed') {
      const result = (json.result ?? {}) as Json;
      const txHash = (result.signature ?? result.transaction_hash ?? result.txHash ?? result.hash) as string | undefined;
      // "completed" = signed and relayed. Finality is not confirmed here, so report `submitted`.
      return { providerRef: String(result.request_id ?? result.requestId ?? params.clientReference ?? txHash ?? 'unknown'), status: 'submitted', txHash };
    }
    if (DEFINITIVE_REJECTIONS.has(status)) {
      return { providerRef: params.clientReference ?? 'rejected', status: 'failed', failureReason: String(json.error ?? json.message ?? `rejected (${status})`).slice(0, 300) };
    }
    // 5xx, 401, anything unexpected: do not guess.
    throw new ProviderOutcomeUnknown(`openfireblocks transfer returned ${status}`);
  }
}

function firstAddress(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const a = firstAddress(x); if (a) return a; } return undefined; }
  if (v && typeof v === 'object') {
    const o = v as Json;
    for (const k of ['address', 'solana', 'base58']) { const a = firstAddress(o[k]); if (a) return a; }
  }
  return undefined;
}

function flattenBalances(json: Json): Array<{ asset: string; units: bigint; decimals: number; available: string }> {
  const out: Array<{ asset: string; units: bigint; decimals: number; available: string }> = [];
  for (const c of (json.chains as Json[] | undefined) ?? []) {
    if (c.error || c.blockchain !== 'solana') continue;
    for (const b of (c.balances as Json[] | undefined) ?? []) {
      if (b.error) throw new Error(`openfireblocks could not read ${String(b.asset)} balance: ${String(b.error)}`);
      const decimals = Number(b.decimals);
      if (typeof b.asset !== 'string' || !/^\d+$/.test(String(b.amount)) || !Number.isInteger(decimals)) throw new Error('openfireblocks returned a malformed balance');
      const units = BigInt(String(b.amount));
      out.push({ asset: b.asset.toUpperCase(), units, decimals, available: fromUnits(units, decimals) });
    }
  }
  return out;
}

export function toUnits(amount: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) throw new Error('Invalid amount');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const units = BigInt(m[1]! + frac.padEnd(decimals, '0'));
  if (units <= 0n) throw new Error('Amount must be positive');
  return units.toString();
}

export function fromUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, '0');
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

/** Scale-18 bigint (as accumulated above) → decimal string. */
function fromScaled(v: bigint): string { return fromUnits(v, 18); }
