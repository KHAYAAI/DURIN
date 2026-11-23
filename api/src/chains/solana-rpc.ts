/** Minimal Solana JSON-RPC client (finalized commitment only). `fetchImpl` is injectable for tests. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface TokenAccount { pubkey: string; mint: string }
export interface SignatureInfo { signature: string; err: unknown | null }
export interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
export interface ParsedTx {
  meta: { err: unknown | null; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction: { message: { accountKeys: Array<string | { pubkey: string }> } };
}

export class SolanaRpc {
  constructor(private readonly cfg: { url: string; headers?: Record<string, string> }, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cfg.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Solana RPC ${method} HTTP ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error) throw new Error(`Solana RPC ${method}: ${j.error.message ?? 'error'}`);
    return j.result as T;
  }

  /** Every SPL token account the owner holds (any mint), so look-alike or bridged mints can be audited. */
  async tokenAccountsByOwner(owner: string): Promise<TokenAccount[]> {
    const r = await this.call<{ value: Array<{ pubkey: string; account: { data: { parsed: { info: { mint: string } } } } }> }>(
      'getTokenAccountsByOwner', [owner, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    return (r.value ?? []).map((v) => ({ pubkey: v.pubkey, mint: v.account.data.parsed.info.mint }));
  }

  /** Newest first. */
  signatures(address: string, opts: { until?: string; before?: string; limit: number }): Promise<SignatureInfo[]> {
    return this.call('getSignaturesForAddress', [address, { commitment: 'finalized', limit: opts.limit, ...(opts.until ? { until: opts.until } : {}), ...(opts.before ? { before: opts.before } : {}) }]);
  }

  transaction(signature: string): Promise<ParsedTx | null> {
    return this.call('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  }
}
