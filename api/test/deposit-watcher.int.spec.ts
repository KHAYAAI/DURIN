import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { PrismaService } from '../src/prisma/prisma.service';
import { DepositWatcherService, SOLANA_RPC } from '../src/chains/deposit-watcher.service';
import { SolanaRpc, TOKEN_PROGRAM_ID } from '../src/chains/solana-rpc';
import { CHAIN_REGISTRY } from '../src/chains/chain-policy';

const USDC = CHAIN_REGISTRY.find((e) => e.assetCode === 'USDC' && e.chain === 'solana-devnet')!.token;
const FAKE_MINT = 'So11111111111111111111111111111111111111112';

interface Tx { sig: string; account: string; mint: string; pre: string; post: string; err?: boolean; unavailable?: boolean }
/** A fake Solana JSON-RPC node that serves token accounts, signatures (newest first) and parsed transactions. */
function fakeNode() {
  const accounts = new Map<string, Array<{ pubkey: string; mint: string }>>();
  const txs: Tx[] = [];
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
      const { method, params, id } = JSON.parse(d);
      calls.push(method);
      const ok = (result: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
      if (method === 'getTokenAccountsByOwner') {
        expect(params[1].programId).toBe(TOKEN_PROGRAM_ID);
        return ok({ value: (accounts.get(params[0]) ?? []).map((a) => ({ pubkey: a.pubkey, account: { data: { parsed: { info: { mint: a.mint } } } } })) });
      }
      if (method === 'getSignaturesForAddress') {
        expect(params[1].commitment).toBe('finalized');
        const mine = txs.filter((t) => t.account === params[0]).map((t) => t.sig).reverse(); // newest first
        const stop = params[1].until ? mine.indexOf(params[1].until) : -1;
        const fresh = stop >= 0 ? mine.slice(0, stop) : mine;
        return ok(fresh.map((s) => ({ signature: s, err: txs.find((t) => t.sig === s)!.err ? { InstructionError: 1 } : null })));
      }
      if (method === 'getTransaction') {
        expect(params[1].commitment).toBe('finalized');
        const t = txs.find((x) => x.sig === params[0]);
        if (!t || t.unavailable) return ok(null);
        return ok({
          meta: { err: t.err ? { InstructionError: 1 } : null,
            preTokenBalances: [{ accountIndex: 1, mint: t.mint, uiTokenAmount: { amount: t.pre, decimals: 6 } }],
            postTokenBalances: [{ accountIndex: 1, mint: t.mint, uiTokenAmount: { amount: t.post, decimals: 6 } }] },
          transaction: { message: { accountKeys: [{ pubkey: 'payer' }, { pubkey: t.account }] } },
        });
      }
      res.writeHead(400); res.end();
    });
  });
  return {
    accounts, txs, calls,
    start: async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; },
    stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

const node = fakeNode();
let t: TestApp; let prisma: PrismaService; let watcher: DepositWatcherService;

beforeAll(async () => {
  const url = await node.start();
  t = await createTestApp((b) => b.overrideProvider(SOLANA_RPC).useValue(new SolanaRpc({ url })));
  prisma = t.app.get(PrismaService);
  watcher = t.app.get(DepositWatcherService);
});
afterAll(async () => { await t?.close(); await node.stop(); });

async function setup(name: string) {
  const { key, orgId } = await bootstrapOrg(t, name);
  const w = (await client(t, key).post('/v1/wallets', { label: 'w' })).body;
  const a = (await client(t, key).post(`/v1/wallets/${w.id}/addresses`, { assetCode: 'USDC', chain: 'solana-devnet' })).body;
  const acct = `ATA-${a.id}`;
  node.accounts.set(a.address, [{ pubkey: acct, mint: USDC }]);
  return { key, orgId, addr: a, acct };
}
const bal = async (orgId: string) => {
  const a = await prisma.ledgerAccount.findUnique({ where: { organisationId_code: { organisationId: orgId, code: 'CUST-LIAB-USDC' } }, include: { balances: true } });
  return a?.balances[0]?.available.toFixed() ?? 'none';
};

describe('Solana deposit watcher', () => {
  it('credits a finalized USDC deposit exactly once, from the balance change, and not again on later ticks', async () => {
    const o = await setup('Watch Credit');
    node.txs.push({ sig: `s1-${o.addr.id}`, account: o.acct, mint: USDC, pre: '0', post: '2500000' });
    const r1 = await watcher.tick();
    expect(r1.errors).toBe(0);
    expect(await bal(o.orgId)).toBe('2.5');
    await watcher.tick(); await watcher.tick();
    expect(await bal(o.orgId)).toBe('2.5');
    // a second deposit is picked up from the cursor onward
    node.txs.push({ sig: `s2-${o.addr.id}`, account: o.acct, mint: USDC, pre: '2500000', post: '3000001' });
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('3.000001');
    const cursor = await prisma.chainCursor.findFirstOrThrow({ where: { depositAddressId: o.addr.id } });
    expect(cursor.lastSignature).toBe(`s2-${o.addr.id}`);
  });

  it('ignores failed transactions and outgoing movements (balance decreases)', async () => {
    const o = await setup('Watch Ignore');
    node.txs.push({ sig: `f1-${o.addr.id}`, account: o.acct, mint: USDC, pre: '0', post: '9000000', err: true });
    node.txs.push({ sig: `o1-${o.addr.id}`, account: o.acct, mint: USDC, pre: '5000000', post: '1000000' });
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('none');
  });

  it('never credits a look-alike or bridged mint, and records it for operators', async () => {
    const o = await setup('Watch Wrong Mint');
    node.accounts.set(o.addr.address, [{ pubkey: o.acct, mint: USDC }, { pubkey: `${o.acct}-fake`, mint: FAKE_MINT }]);
    node.txs.push({ sig: `w1-${o.addr.id}`, account: `${o.acct}-fake`, mint: FAKE_MINT, pre: '0', post: '777000000' });
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('none');
    const audits = await prisma.auditLog.findMany({ where: { organisationId: o.orgId, action: 'deposit.rejected' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ reason: 'WRONG_TOKEN', tokenContract: FAKE_MINT });
    await watcher.tick();
    expect(await prisma.auditLog.count({ where: { organisationId: o.orgId, action: 'deposit.rejected' } })).toBe(1);
  });

  it('a transaction that is not retrievable yet delays the deposit but never skips it', async () => {
    const o = await setup('Watch Delay');
    const tx: Tx = { sig: `d1-${o.addr.id}`, account: o.acct, mint: USDC, pre: '0', post: '1000000', unavailable: true };
    node.txs.push(tx);
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('none');
    expect(await prisma.chainCursor.count({ where: { depositAddressId: o.addr.id } })).toBe(0);
    tx.unavailable = false;
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('1');
  });

  it('an RPC outage is reported as an error and credits nothing; recovery catches up', async () => {
    const o = await setup('Watch Outage');
    node.txs.push({ sig: `x1-${o.addr.id}`, account: o.acct, mint: USDC, pre: '0', post: '4000000' });
    const down = new DepositWatcherService(prisma, t.app.get(DepositWatcherService)['wallets'], new SolanaRpc({ url: 'http://127.0.0.1:1' }));
    const r = await down.tick();
    expect(r.errors).toBeGreaterThan(0);
    expect(await bal(o.orgId)).toBe('none');
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('4');
  });

  it('credits are isolated per organisation', async () => {
    const a = await setup('Watch Tenant A'); const b = await setup('Watch Tenant B');
    node.txs.push({ sig: `t1-${a.addr.id}`, account: a.acct, mint: USDC, pre: '0', post: '1500000' });
    await watcher.tick();
    expect(await bal(a.orgId)).toBe('1.5');
    expect(await bal(b.orgId)).toBe('none');
  });
});
