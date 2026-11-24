/** Minimal Ethereum JSON-RPC client; only FINALIZED data is ever read. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export interface EvmLog { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }

export function addressTopic(address: string): string {
  return `0x${'0'.repeat(24)}${address.toLowerCase().replace(/^0x/, '')}`;
}

export class EvmRpc {
  constructor(private readonly cfg: { url: string; headers?: Record<string, string> }, private readonly fetchImpl: typeof fetch = fetch) {}
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.cfg.url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(this.cfg.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`EVM RPC ${method} HTTP ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error) throw new Error(`EVM RPC ${method}: ${j.error.message ?? 'error'}`);
    return j.result as T;
  }
  async finalizedBlock(): Promise<number> {
    const b = await this.call<{ number: string } | null>('eth_getBlockByNumber', ['finalized', false]);
    if (!b) throw new Error('node has no finalized block');
    return Number(BigInt(b.number));
  }
  /** All ERC-20 Transfer events TO `address`, from every token contract, in [from, to]. */
  transfersTo(address: string, from: number, to: number): Promise<EvmLog[]> {
    return this.call('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TRANSFER_TOPIC, null, addressTopic(address)] }]);
  }
}
