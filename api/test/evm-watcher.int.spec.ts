import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { PrismaService } from '../src/prisma/prisma.service';
import { EVM_RPC, EvmDepositWatcherService } from '../src/chains/evm-watcher.service';
import { EvmRpc, TRANSFER_TOPIC, addressTopic } from '../src/chains/evm-rpc';
import { CHAIN_REGISTRY } from '../src/chains/chain-policy';

const USDC = CHAIN_REGISTRY.find((e) => e.assetCode === 'USDC' && e.chain === 'ethereum-sepolia')!.token;
const FAKE = '0x00000000000000000000000000000000deadbeef';
const SENDER = '0x00000000000000000000000000000000000000cc';
const hex = (n: number | bigint) => `0x${n.toString(16)}`;

function fakeNode() {
  const logs: Array<{ address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }> = [];
  const state = { finalized: 10_000, calls: [] as string[], failLogs: false };
  const server: Server = createServer((req, res) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
      const { method, params, id } = JSON.parse(d); state.calls.push(method);
      const ok = (result: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
      if (method === 'eth_getBlockByNumber') { expect(params[0]).toBe('finalized'); return ok({ number: hex(state.finalized) }); }
      if (method === 'eth_getLogs') {
        if (state.failLogs) { res.writeHead(500); return res.end(); }
        const f = params[0]; const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
        expect(f.topics[0]).toBe(TRANSFER_TOPIC);
        return ok(logs.filter((l) => l.topics[2] === f.topics[2] && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to));
      }
      res.writeHead(400); res.end();
    });
  });
  return { logs, state, start: async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
const node = fakeNode();
let t: TestApp; let prisma: PrismaService; let watcher: EvmDepositWatcherService;
beforeAll(async () => {
  const url = await node.start();
  t = await createTestApp((b) => b.overrideProvider(EVM_RPC).useValue(new EvmRpc({ url })));
  prisma = t.app.get(PrismaService); watcher = t.app.get(EvmDepositWatcherService);
});
afterAll(async () => { await t?.close(); await node.stop(); });

async function setup(name: string) {
  const { key, orgId } = await bootstrapOrg(t, name);
  const w = (await client(t, key).post('/v1/wallets', { label: 'w' })).body;
  const a = (await client(t, key).post(`/v1/wallets/${w.id}/addresses`, { assetCode: 'USDC', chain: 'ethereum-sepolia' })).body;
  // The sandbox adapter's address is not hex: give it a real-looking EVM address for the log filter.
  const address = `0x${a.id.replace(/-/g, '').slice(0, 40)}`;
  await prisma.depositAddress.update({ where: { id: a.id }, data: { address } });
  return { orgId, addrId: a.id, address };
}
const transfer = (o: { address: string }, token: string, amount: bigint, block: number, tx: string, idx = 0, topics?: string[]) => node.logs.push({
  address: token, topics: topics ?? [TRANSFER_TOPIC, addressTopic(SENDER), addressTopic(o.address)], data: `0x${amount.toString(16).padStart(64, '0')}`,
  blockNumber: hex(block), transactionHash: tx, logIndex: hex(idx),
});
const bal = async (orgId: string) => (await prisma.ledgerAccount.findUnique({ where: { organisationId_code: { organisationId: orgId, code: 'CUST-LIAB-USDC' } }, include: { balances: true } }))?.balances[0]?.available.toFixed() ?? 'none';

describe('EVM deposit watcher', () => {
  it('credits finalized native-USDC transfers once; later ticks and restarts do not double-credit', async () => {
    const o = await setup('Evm Credit');
    transfer(o, USDC, 2_500_000n, 9_990, `0xtx1-${o.addrId}`);
    expect((await watcher.tick()).errors).toBe(0);
    expect(await bal(o.orgId)).toBe('2.5');
    await watcher.tick(); await watcher.tick();
    expect(await bal(o.orgId)).toBe('2.5');
    node.state.finalized = 10_010;
    transfer(o, USDC, 1_000_001n, 10_005, `0xtx2-${o.addrId}`);
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('3.500001');
    expect((await prisma.chainCursor.findFirstOrThrow({ where: { depositAddressId: o.addrId } })).lastSignature).toBe('10010');
    node.state.finalized = 10_000;
  });

  it('two transfers inside one transaction are both credited (log index is part of the key)', async () => {
    const o = await setup('Evm Multi');
    transfer(o, USDC, 1_000_000n, 9_980, `0xmulti-${o.addrId}`, 0); transfer(o, USDC, 2_000_000n, 9_980, `0xmulti-${o.addrId}`, 1);
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('3');
  });

  it('a look-alike token is never credited; it becomes a rejected deposit with the sender, once', async () => {
    const o = await setup('Evm Wrong');
    transfer(o, FAKE, 777_000_000n, 9_970, `0xbad-${o.addrId}`);
    await watcher.tick(); await watcher.tick();
    expect(await bal(o.orgId)).toBe('none');
    const rows = await prisma.rejectedDeposit.findMany({ where: { organisationId: o.orgId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'WRONG_TOKEN', tokenContract: FAKE, baseUnits: '777000000', sender: SENDER });
  });

  it('ignores zero-value transfers and NFT (4-topic) transfers', async () => {
    const o = await setup('Evm Ignore');
    transfer(o, USDC, 0n, 9_960, `0xzero-${o.addrId}`);
    transfer(o, USDC, 5_000_000n, 9_961, `0xnft-${o.addrId}`, 0, [TRANSFER_TOPIC, addressTopic(SENDER), addressTopic(o.address), hex(1).padStart(66, '0')]);
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('none');
    expect(await prisma.rejectedDeposit.count({ where: { organisationId: o.orgId } })).toBe(0);
  });

  it('an RPC failure credits nothing and does not move the cursor; recovery catches up', async () => {
    const o = await setup('Evm Outage');
    transfer(o, USDC, 4_000_000n, 9_950, `0xout-${o.addrId}`);
    node.state.failLogs = true;
    const r = await watcher.tick();
    expect(r.errors).toBeGreaterThan(0);
    expect(await bal(o.orgId)).toBe('none');
    expect(await prisma.chainCursor.count({ where: { depositAddressId: o.addrId } })).toBe(0);
    node.state.failLogs = false;
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('4');
  });

  it('only finalized blocks are read: a transfer above the finalized height waits', async () => {
    const o = await setup('Evm Finality');
    transfer(o, USDC, 6_000_000n, 10_050, `0xfin-${o.addrId}`);
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('none');
    node.state.finalized = 10_100;
    await watcher.tick();
    expect(await bal(o.orgId)).toBe('6');
    node.state.finalized = 10_000;
  });
});
