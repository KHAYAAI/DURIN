import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { signValr } from '../../src/providers/valr/valr-client';

/** A fake VALR that VERIFIES request signatures and mirrors the documented response shapes. */
export interface FakeValr {
  url: string; close(): Promise<void>; secret: string;
  orders: Map<string, { orderId: string; pair: string; side: string; baseAmount: string; status: string; sub: string }>;
  placeCalls: number; withdrawals: Array<{ sub: string; asset: string; amount: string; address: string; networkType: string }>;
  failNextOrder?: 'insufficient' | '500'; balances: Map<string, Array<{ currency: string; available: string; reserved: string; total: string }>>;
  fiatWithdrawals: number; linked: Array<{ id: string; accountNumber: string; branchCode: string }>;
}

export async function startFakeValr(apiKey = 'k'.repeat(64), secret = 's'.repeat(64)): Promise<FakeValr> {
  const state: FakeValr = { url: '', secret, orders: new Map(), placeCalls: 0, withdrawals: [], balances: new Map(), fiatWithdrawals: 0, linked: [{ id: 'bank1', accountNumber: '62792461544', branchCode: '250655' }], close: async () => undefined };
  const subs: Array<{ id: string; label: string }> = [{ id: '0', label: 'Primary' }];
  const server: Server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const path = req.url!; const sub = String(req.headers['x-valr-sub-account-id'] ?? '');
      const ts = String(req.headers['x-valr-timestamp'] ?? '');
      const want = signValr(secret, ts, req.method!, path, raw, sub);
      if (req.headers['x-valr-api-key'] !== apiKey || req.headers['x-valr-signature'] !== want) return send(403, { code: -1, message: 'bad signature' });
      const body = raw ? JSON.parse(raw) : {};
      const u = new URL(path, 'http://x'); const p = u.pathname.split('/').filter(Boolean);
      const key = `${p[0]}/${p[1]}`;
      if (req.method === 'POST' && u.pathname === '/v1/account/subaccount') { const id = String(1000 + subs.length); subs.push({ id, label: body.label }); return send(200, { id }); }
      if (req.method === 'GET' && u.pathname === '/v1/account/subaccounts') return send(200, subs);
      if (req.method === 'GET' && u.pathname === '/v1/account/balances') return send(200, state.balances.get(sub) ?? []);
      if (req.method === 'GET' && /\/v1\/wallet\/crypto\/\w+\/deposit\/address/.test(u.pathname)) return send(200, { currency: p[3], address: `ADDR-${sub}-${p[3]}`, networkType: u.searchParams.get('networkType') });
      if (req.method === 'POST' && /\/v1\/wallet\/crypto\/\w+\/withdraw$/.test(u.pathname)) {
        if (String(body.address).startsWith('BAD')) return send(400, { code: -113, message: 'Invalid address' });
        if (String(body.address).startsWith('BOOM')) return send(500, {});
        state.withdrawals.push({ sub, asset: p[3]!, amount: body.amount, address: body.address, networkType: body.networkType }); return send(202, { id: randomUUID() });
      }
      if (req.method === 'GET' && u.pathname === '/v1/wallet/fiat/ZAR/deposit/reference') return send(200, { reference: `REF${sub}` });
      if (req.method === 'GET' && u.pathname === '/v1/wallet/fiat/ZAR/accounts') return send(200, state.linked);
      if (req.method === 'POST' && u.pathname === '/v1/wallet/fiat/ZAR/withdraw') { state.fiatWithdrawals++; return send(202, { id: randomUUID() }); }
      if (req.method === 'POST' && /\/v1\/simple\/\w+\/quote$/.test(u.pathname)) return send(200, { id: 'q1', payAmount: body.payAmount, receiveAmount: body.side === 'BUY' ? String(Number(body.payAmount) / 18.5) : String(Number(body.payAmount) * 18.4), fee: '0.1', feeCurrency: 'USDC' });
      if (req.method === 'POST' && u.pathname === '/v2/orders/market') {
        state.placeCalls++;
        if (state.failNextOrder === '500') { state.failNextOrder = undefined; return send(500, {}); }
        if (state.failNextOrder === 'insufficient') { state.failNextOrder = undefined; return send(400, { code: -6, message: 'Insufficient Balance' }); }
        if (state.orders.has(body.customerOrderId)) return send(400, { code: -1, message: 'Duplicate customerOrderId' });
        const o = { orderId: randomUUID(), pair: body.pair, side: body.side, baseAmount: body.baseAmount, status: 'Filled', sub };
        state.orders.set(body.customerOrderId, o); return send(201, { id: o.orderId });
      }
      if (req.method === 'GET' && key === 'v1/orders' && p[3] === 'customerorderid') {
        const o = state.orders.get(p[4]!);
        if (!o) return send(400, { code: -1, message: 'Invalid Order.' });
        return send(200, { orderId: o.orderId, orderStatusType: o.status, currencyPair: o.pair, customerOrderId: p[4], failedReason: '' });
      }
      if (req.method === 'GET' && u.pathname.startsWith('/v1/orders/history/summary/customerorderid/')) {
        const o = state.orders.get(p[5]!); if (!o) return send(400, { code: -1 });
        return send(200, { orderId: o.orderId, orderStatusType: o.status, averagePrice: '18.5', total: '1850', totalExecutedQuantity: o.baseAmount, totalFee: '0.1', feeCurrency: 'USDC' });
      }
      return send(404, { code: -404, message: `no route ${req.method} ${u.pathname}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); });
  return state;
}
