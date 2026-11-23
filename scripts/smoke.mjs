#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING DURIN API (sandbox mode).
 * Usage: node scripts/smoke.mjs [baseUrl]     (default http://localhost:3000)
 *
 * Creates a throwaway organisation, then exercises payments, conversion, wallet deposit and
 * withdrawal, and finishes by asking the ledger to verify its own integrity.
 */
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
let key;
const results = [];

async function call(method, path, body, idem) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(idem ? { 'Idempotency-Key': idem } : {}),
      ...(process.env.BOOTSTRAP_TOKEN && path === '/v1/organisations' ? { 'X-Bootstrap-Token': process.env.BOOTSTRAP_TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

const health = await call('GET', '/health');
check('health is ok with database up', health.status === 200 && health.body.database === 'up', JSON.stringify(health));

const org = await call('POST', '/v1/organisations', { name: `Smoke ${Date.now()}` });
check('create organisation', org.status === 201, JSON.stringify(org.body));
key = org.body.apiKey?.secret;

const intent = await call('POST', '/v1/payment_intents', { amount: '250.00', assetCode: 'USDC' }, 'smoke-pi');
check('create payment intent', intent.status === 201 && intent.body.status === 'pending');
const settled = await call('POST', `/v1/payment_intents/${intent.body.id}/simulate_confirm`);
check('settle payment (simulated)', settled.body.status === 'settled');

const quote = await call('POST', '/v1/quotes', { sourceAsset: 'ZAR', targetAsset: 'USDC', sourceAmount: '10000' });
check('quote ZAR->USDC is exact', quote.body.feeAmount === '30' && quote.body.targetAmount === '538.91838', JSON.stringify(quote.body));
const conv = await call('POST', '/v1/conversions', { quoteId: quote.body.id }, 'smoke-conv');
check('convert (simulated)', conv.body.status === 'settled');
const replay = await call('POST', '/v1/conversions', { quoteId: quote.body.id }, 'smoke-conv');
check('conversion replay returns the same conversion', replay.body.id === conv.body.id);

const wallet = await call('POST', '/v1/wallets', { label: 'smoke' });
const addr = await call('POST', `/v1/wallets/${wallet.body.id}/addresses`, { assetCode: 'USDC' });
const dep = await call('POST', `/v1/deposit_addresses/${addr.body.id}/simulate_deposit`, { amount: '100' });
check('simulated deposit', dep.status === 201);
const wd = await call('POST', '/v1/withdrawals', { walletId: wallet.body.id, assetCode: 'USDC', amount: '40', destination: '0x00000000000000000000000000000000000000aa' }, 'smoke-wd');
check('withdrawal confirmed', wd.body.status === 'confirmed', JSON.stringify(wd.body));
const over = await call('POST', '/v1/withdrawals', { walletId: wallet.body.id, assetCode: 'USDC', amount: '1000000', destination: '0x00000000000000000000000000000000000000aa' });
check('overdraw is refused', over.status === 400 && over.body.code === 'NEGATIVE_BALANCE');

const accounts = await call('GET', '/v1/accounts');
const usdc = accounts.body.find((a) => a.code === 'CUST-LIAB-USDC');
check('customer USDC balance = 250 + 538.91838 + 100 - 40', usdc?.balances.available === '848.91838', JSON.stringify(usdc?.balances));

const integrity = await call('GET', '/v1/ledger/integrity');
check('ledger integrity report is healthy', integrity.body.healthy === true, JSON.stringify(integrity.body));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
