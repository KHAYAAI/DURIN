import { createServer, type IncomingMessage, type Server } from 'http';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';

/**
 * A fake OpenFireblocks that mirrors the shapes documented in docs/USER-WALLETS-AND-SOLANA-TOKENS.md and
 * the gateway source. It proves the adapter's logic and the DURIN-side contract; it does NOT prove the
 * real service behaves identically — that needs a run against OpenFireblocks staging.
 */
export interface FakeOfb { url: string; close(): Promise<void>; wallets: Map<string, Wallet>; transferCalls: number; seed(walletRef: string, usdcUnits: string): void; }
interface Wallet { wallet_id: string; external_ref: string; usdc: bigint; address: string }

const read = (req: IncomingMessage) => new Promise<Record<string, unknown>>((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(d ? JSON.parse(d) : {})); });

export async function startFakeOfb(apiKey = 'ofb-test'): Promise<FakeOfb> {
  const wallets = new Map<string, Wallet>();
  const idem = new Map<string, unknown>();
  const state = { transferCalls: 0 };
  const server: Server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-api-key'] !== apiKey) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url!, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = req.method === 'POST' ? await read(req) : {};
    if (parts[0] !== 'wallets') return send(404, {});
    if (req.method === 'POST' && parts.length === 1) {
      const w: Wallet = { wallet_id: randomUUID(), external_ref: String(body.externalRef), usdc: 0n, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
      wallets.set(w.wallet_id, w);
      return send(201, { wallet_id: w.wallet_id, external_ref: w.external_ref, status: 'active', keys: [{ blockchain: 'solana', status: 'active', address: w.address }] });
    }
    if (req.method === 'GET' && parts.length === 1) return send(200, { wallets: [...wallets.values()].map((w) => ({ wallet_id: w.wallet_id, external_ref: w.external_ref })), next: null });
    const w = wallets.get(parts[1]!);
    if (!w) return send(404, { error: 'no such wallet' });
    if (parts[2] === 'addresses') return send(200, { wallet_id: w.wallet_id, external_ref: w.external_ref, chains: [{ blockchain: 'solana', key_id: 'k1', status: 'active', addresses: { address: w.address } }] });
    if (parts[2] === 'balances') return send(200, { wallet_id: w.wallet_id, external_ref: w.external_ref, chains: [{ blockchain: 'solana', balances: [{ asset: 'SOL', amount: '5000000', decimals: 9 }, { asset: 'USDC', amount: w.usdc.toString(), decimals: 6 }] }] });
    if (parts[2] === 'transfers' && req.method === 'POST') {
      state.transferCalls++;
      const key = String(body.idempotencyKey ?? '');
      if (key && idem.has(key)) return send(200, idem.get(key));
      if (body.destination === 'PENDING1111111111111111111111111111111111') return send(202, { status: 'pending_approval', approvalId: 'ap1', requiredApprovals: 2 });
      if (body.destination === 'DENIED11111111111111111111111111111111111') return send(403, { error: 'policy denied' });
      if (body.destination === 'BOOM111111111111111111111111111111111111') return send(500, { error: 'boom' });
      const out = { status: 'completed', result: { signature: `sig-${randomUUID()}`, request_id: randomUUID() } };
      if (key) idem.set(key, out);
      return send(200, out);
    }
    return send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, wallets,
    get transferCalls() { return state.transferCalls; },
    seed: (ref, units) => { const w = [...wallets.values()].find((x) => x.wallet_id === ref); if (w) w.usdc = BigInt(units); },
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  } as FakeOfb;
}
