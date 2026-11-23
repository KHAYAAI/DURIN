import { add, cmp, sub } from '@durin/ledger';

/**
 * SIMULATED custodian balances, per organisation and asset, held in process memory.
 * Sandbox adapters read and write it so reconciliation has an independent "provider-reported"
 * figure to compare with the ledger. It is lost on restart (a restarted sandbox API will report
 * breaks against a persisted ledger — expected, and a reason this is not a custody source).
 */
class SandboxCustody {
  private m = new Map<string, string>();
  private key = (org: string, asset: string) => `${org}:${asset.toUpperCase()}`;
  get(org: string, asset: string): string { return this.m.get(this.key(org, asset)) ?? '0'; }
  credit(org: string, asset: string, amount: string): void { this.m.set(this.key(org, asset), add(this.get(org, asset), amount)); }
  debit(org: string, asset: string, amount: string): void {
    const cur = this.get(org, asset);
    this.m.set(this.key(org, asset), cmp(cur, amount) >= 0 ? sub(cur, amount) : '0');
  }
  private applied = new Set<string>();
  /** Credit exactly once per key, so idempotent replays of a simulated deposit do not double-count. */
  creditOnce(key: string, org: string, asset: string, amount: string): void {
    if (this.applied.has(key)) return;
    this.applied.add(key);
    this.credit(org, asset, amount);
  }
  assets(org: string): string[] {
    return [...this.m.keys()].filter((k) => k.startsWith(`${org}:`)).map((k) => k.slice(org.length + 1));
  }
  /** Test hook: change the reported balance without a matching ledger entry (simulates drift). */
  setRaw(org: string, asset: string, amount: string): void { this.m.set(this.key(org, asset), amount); }
}
export const sandboxCustody = new SandboxCustody();
