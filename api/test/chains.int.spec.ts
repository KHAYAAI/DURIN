import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapOrg, client, createTestApp, type TestApp } from './helpers/app';
import { WalletsService } from '../src/wallets/wallets.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CHAIN_REGISTRY } from '../src/chains/chain-policy';

let t: TestApp;
let wallets: WalletsService;
let prisma: PrismaService;
beforeAll(async () => {
  t = await createTestApp();
  wallets = t.app.get(WalletsService);
  prisma = t.app.get(PrismaService);
});
afterAll(async () => { await t?.close(); });

const usdcSepolia = CHAIN_REGISTRY.find((e) => e.assetCode === 'USDC' && e.chain === 'ethereum-sepolia')!;

async function setup(name: string, chain = 'ethereum-sepolia') {
  const { key, orgId } = await bootstrapOrg(t, name);
  const w = (await client(t, key).post('/v1/wallets', { label: 'w' })).body;
  const a = await client(t, key).post(`/v1/wallets/${w.id}/addresses`, { assetCode: 'USDC', chain });
  return { key, orgId, wallet: w, addr: a.body, addrStatus: a.status };
}
const custodyBal = async (orgId: string) => {
  const a = await prisma.ledgerAccount.findUnique({ where: { organisationId_code: { organisationId: orgId, code: 'CUST-LIAB-USDC' } }, include: { balances: true } });
  return a?.balances[0]?.available.toFixed() ?? 'none';
};

describe('chain policy over HTTP', () => {
  it('lists enabled chains with native token identifiers', async () => {
    const { key } = await bootstrapOrg(t, 'Chains List');
    const res = await client(t, key).get('/v1/chains');
    expect(res.status).toBe(200);
    expect(res.body.some((c: { chain: string; assetCode: string }) => c.chain === 'ethereum-sepolia' && c.assetCode === 'USDC')).toBe(true);
    expect(res.body.every((c: { tokenContract: string }) => !!c.tokenContract)).toBe(true);
  });

  it('refuses address creation on unknown or disabled chains', async () => {
    const o = await setup('Chains Addr');
    expect(o.addrStatus).toBe(201);
    const bad = await client(t, o.key).post(`/v1/wallets/${o.wallet.id}/addresses`, { assetCode: 'USDC', chain: 'dogechain' });
    expect(bad.status).toBe(422);
    const wrongPair = await client(t, o.key).post(`/v1/wallets/${o.wallet.id}/addresses`, { assetCode: 'USDC', chain: 'tron' });
    expect(wrongPair.status).toBe(422);
  });

  it('validates withdrawal destinations per chain', async () => {
    const o = await setup('Chains Wd');
    await client(t, o.key).post(`/v1/deposit_addresses/${o.addr.id}/simulate_deposit`, { amount: '100' });
    const body = { walletId: o.wallet.id, assetCode: 'USDC', amount: '5', chain: 'ethereum-sepolia' };
    expect((await client(t, o.key).post('/v1/withdrawals', { ...body, destination: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })).status).toBe(400);
    expect((await client(t, o.key).post('/v1/withdrawals', { ...body, destination: '0x00000000000000000000000000000000000000aa' })).status).toBe(201);
  });
});

describe('deposit detection (what a live custody adapter calls)', () => {
  it('credits the native token once, and replays are idempotent', async () => {
    const o = await setup('Dep Credit');
    const d = { txHash: '0xabc1', amount: '25', tokenContract: usdcSepolia.token, confirmations: usdcSepolia.confirmations };
    const first = await wallets.recordDetectedDeposit(o.orgId, o.addr.id, d);
    expect(first.status).toBe('credited');
    const again = await wallets.recordDetectedDeposit(o.orgId, o.addr.id, d);
    expect(again.status).toBe('credited');
    expect(await custodyBal(o.orgId)).toBe('25');
  });

  it('does not credit until the confirmation depth is reached', async () => {
    const o = await setup('Dep Wait');
    const d = { txHash: '0xabc2', amount: '10', tokenContract: usdcSepolia.token };
    expect(await wallets.recordDetectedDeposit(o.orgId, o.addr.id, { ...d, confirmations: 1 })).toMatchObject({ status: 'pending', need: usdcSepolia.confirmations });
    expect(await custodyBal(o.orgId)).toBe('none');
    expect((await wallets.recordDetectedDeposit(o.orgId, o.addr.id, { ...d, confirmations: usdcSepolia.confirmations })).status).toBe('credited');
  });

  it('rejects look-alike and bridged tokens, never credits them, and leaves an audit record', async () => {
    const o = await setup('Dep Reject');
    const wrong = await wallets.recordDetectedDeposit(o.orgId, o.addr.id, { txHash: '0xbad1', amount: '99', tokenContract: '0x0000000000000000000000000000000000000bad', confirmations: 99 });
    expect(wrong).toEqual({ status: 'rejected', reason: 'WRONG_TOKEN' });
    const bridged = await wallets.recordDetectedDeposit(o.orgId, o.addr.id, { txHash: '0xbad2', amount: '99', tokenContract: usdcSepolia.token, tokenSymbol: 'USDC.e', confirmations: 99 });
    expect(bridged).toEqual({ status: 'rejected', reason: 'BRIDGED_TOKEN' });
    expect(await custodyBal(o.orgId)).toBe('none');
    const audits = await prisma.auditLog.findMany({ where: { organisationId: o.orgId, action: 'deposit.rejected' } });
    expect(audits).toHaveLength(2);
  });

  it("another organisation's address is not found", async () => {
    const a = await setup('Dep Tenant A');
    const b = await bootstrapOrg(t, 'Dep Tenant B');
    await expect(wallets.recordDetectedDeposit(b.orgId, a.addr.id, { txHash: '0x1', amount: '1', tokenContract: usdcSepolia.token, confirmations: 99 })).rejects.toThrow();
  });
});
