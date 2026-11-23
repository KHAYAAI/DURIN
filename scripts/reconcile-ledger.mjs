#!/usr/bin/env node
/**
 * Offline reconciliation helper — compares exported ledger balances to provider snapshots.
 * Usage: node scripts/reconcile-ledger.mjs ledger.json provider.json
 * Both files: [{ accountId|address, assetCode, available: "0.00" }]
 */
import { readFileSync } from 'fs';

const [ledgerPath, providerPath] = process.argv.slice(2);
if (!ledgerPath || !providerPath) {
  console.error('Usage: node scripts/reconcile-ledger.mjs ledger.json provider.json');
  process.exit(2);
}
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const provider = JSON.parse(readFileSync(providerPath, 'utf8'));
const key = (r) => `${r.assetCode}:${r.accountId || r.address}`;
const map = new Map(provider.map((r) => [key(r), r]));
let breaks = 0;
for (const row of ledger) {
  const p = map.get(key(row));
  const lv = Number(row.available);
  const pv = p ? Number(p.available) : NaN;
  if (!p || Math.abs(lv - pv) > 1e-8) {
    console.log('BREAK', key(row), 'ledger=', row.available, 'provider=', p?.available ?? 'MISSING');
    breaks++;
  }
}
console.log(JSON.stringify({ checked: ledger.length, breaks }));
process.exit(breaks ? 1 : 0);
