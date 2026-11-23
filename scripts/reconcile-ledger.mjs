#!/usr/bin/env node
/**
 * Runs DURIN's reconciliation for the organisation that owns the API key and exits non-zero on
 * any break. Replaces the earlier float-based offline comparison: all arithmetic is done by the
 * API in exact decimals, against the custodians' reported balances.
 *
 *   DURIN_API_URL=https://api.example.com/v1 DURIN_API_KEY=dk_live_... node scripts/reconcile-ledger.mjs
 *
 * Needs scopes reconciliation:write and ledger integrity (admin).
 */
const base = (process.env.DURIN_API_URL || 'http://localhost:3000/v1').replace(/\/$/, '');
const key = process.env.DURIN_API_KEY;
if (!key) {
  console.error('Set DURIN_API_KEY');
  process.exit(2);
}
const res = await fetch(`${base}/reconciliation/runs`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.error(`Reconciliation request failed: ${res.status}`);
  process.exit(2);
}
const run = await res.json();
for (const b of run.breaks ?? []) {
  console.log('BREAK', b.kind, b.assetCode, b.custodian, `ledger=${b.ledgerAmount}`, `reported=${b.reportedAmount ?? 'n/a'}`, `delta=${b.delta ?? 'n/a'}`);
}
console.log(JSON.stringify({ status: run.status, source: run.source, breaks: (run.breaks ?? []).length, unresolvedProviderOutcomes: run.summary?.unresolvedProviderOutcomes }));
process.exit(run.status === 'clean' ? 0 : 1);
