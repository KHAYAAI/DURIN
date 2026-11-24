import { Injectable } from '@nestjs/common';
import { add, cmp, sub } from '@durin/ledger';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { GatesService } from '../compliance/gates.service';
import { chartCode, custodianFor, ensureCustodyRef } from '../ledger/chart';

export type HouseMode = 'off' | 'inventory' | 'netting' | 'both';
export type Route = 'provider' | 'house' | 'netted';

export function houseConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = (env.HOUSE_DEALING ?? 'off') as HouseMode;
  if (!['off', 'inventory', 'netting', 'both'].includes(mode)) throw new Error(`HOUSE_DEALING must be off|inventory|netting|both (got ${mode})`);
  const limits = env.HOUSE_LIMITS ? (JSON.parse(env.HOUSE_LIMITS) as Record<string, { max?: string; min?: string }>) : {};
  return { mode, limits, windowSeconds: Number(env.NETTING_WINDOW_SECONDS ?? 5) };
}

const STABLES = new Set(['USDC', 'USDT']);

/**
 * DURIN's own (house) organisation: the counterparty when conversions are filled from own inventory (G3) or matched
 * internally (G2). Everything here is CLOSED unless (1) HOUSE_DEALING enables it, (2) a house organisation exists, and
 * (3) a valid, human-recorded gate approval (G2/G3) covers the assets. Nothing in this class moves money.
 *
 * House accounts per asset: CUSTODY-REF (what the custodians hold for the house), HOUSE-TRADE (trading clearing; its
 * ZAR balance is realised P&L, a non-zero stablecoin balance is an open position), HOUSE-CAPITAL (equity injected).
 */
@Injectable()
export class HouseService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly gates: GatesService) {}

  async houseOrgId(): Promise<string | null> {
    const h = await this.prisma.organisation.findFirst({ where: { isHouse: true, status: 'active' }, select: { id: true } });
    return h?.id ?? null;
  }

  async accounts(houseOrg: string, asset: string) {
    const a = asset.toUpperCase();
    const custody = await ensureCustodyRef(this.ledger, houseOrg, a);
    const trading = await this.ledger.ensureAccount(houseOrg, { code: `HOUSE-TRADE-${a}`, name: `House trading clearing ${a}`, accountType: 'revenue', assetCode: a, allowNegative: true, role: 'house_trading' });
    const capital = await this.ledger.ensureAccount(houseOrg, { code: `HOUSE-CAPITAL-${a}`, name: `House capital ${a}`, accountType: 'equity', assetCode: a, role: 'house_capital' });
    return { custody, trading, capital };
  }

  async balance(accountId: string): Promise<string> {
    const b = await this.prisma.balance.findUnique({ where: { accountId } });
    return b ? b.available.toFixed() : '0';
  }

  /** Is the pair eligible for house handling at all (ZAR ⇄ a supported stablecoin)? */
  private zarStablePair(src: string, tgt: string): { base: string } | null {
    const s = src.toUpperCase(), t = tgt.toUpperCase();
    if (s === 'ZAR' && STABLES.has(t)) return { base: t };
    if (t === 'ZAR' && STABLES.has(s)) return { base: s };
    return null;
  }

  /** Can the house fill this conversion from its own inventory, within limits? (src arrives, tgt leaves) */
  async canFillFromInventory(houseOrg: string, srcAsset: string, srcAmount: string, tgtAsset: string, tgtAmount: string): Promise<{ ok: boolean; reason?: string }> {
    const cfg = houseConfig();
    const tgt = await this.accounts(houseOrg, tgtAsset); const src = await this.accounts(houseOrg, srcAsset);
    const tgtHeld = await this.balance(tgt.custody.id);
    const tgtMin = cfg.limits[tgtAsset.toUpperCase()]?.min ?? '0';
    if (cmp(sub(tgtHeld, tgtAmount), tgtMin) < 0) return { ok: false, reason: 'INSUFFICIENT_INVENTORY' };
    const srcMax = cfg.limits[srcAsset.toUpperCase()]?.max;
    if (srcMax && cmp(add(await this.balance(src.custody.id), srcAmount), srcMax) > 0) return { ok: false, reason: 'INVENTORY_LIMIT' };
    return { ok: true };
  }

  /** Decide how a freshly reserved conversion is executed. Always falls back to the external provider. */
  async routeFor(c: { sourceAsset: string; targetAsset: string; netSource: string; target: string }): Promise<Route> {
    const cfg = houseConfig();
    if (cfg.mode === 'off') return 'provider';
    const pair = this.zarStablePair(c.sourceAsset, c.targetAsset);
    if (!pair) return 'provider';
    const house = await this.houseOrgId();
    if (!house) return 'provider';
    const assets = [c.sourceAsset, c.targetAsset];
    if ((cfg.mode === 'inventory' || cfg.mode === 'both') && (await this.gates.isOpen(house, 'G3', assets))) {
      if ((await this.canFillFromInventory(house, c.sourceAsset, c.netSource, c.targetAsset, c.target)).ok) return 'house';
    }
    if ((cfg.mode === 'netting' || cfg.mode === 'both') && (await this.gates.isOpen(house, 'G2', assets))) return 'netted';
    return 'provider';
  }

  /** Operator capital injection record (Dr custody / Cr capital). The physical funds must already be at the custodian. */
  async recordCapital(houseOrg: string, asset: string, amount: string, evidenceRef: string) {
    const a = await this.accounts(houseOrg, asset);
    const j = await this.ledger.postJournal(houseOrg, {
      reference: `house-capital:${evidenceRef}`, description: `House capital ${amount} ${asset.toUpperCase()} (${evidenceRef})`,
      lines: [
        { accountId: a.custody.id, direction: 'debit', amount, assetCode: asset.toUpperCase() },
        { accountId: a.capital.id, direction: 'credit', amount, assetCode: asset.toUpperCase() },
      ],
    }, `house-capital-${evidenceRef}`);
    return { journalId: j.id, custodian: custodianFor(asset) };
  }

  async position(houseOrg: string) {
    const rows = await this.prisma.ledgerAccount.findMany({ where: { organisationId: houseOrg, role: { in: ['custody_ref', 'house_trading', 'house_capital'] } }, include: { balances: true }, orderBy: { code: 'asc' } });
    const batches = await this.prisma.nettingBatch.groupBy({ by: ['status'], _count: true });
    return {
      organisationId: houseOrg,
      mode: houseConfig().mode,
      accounts: rows.map((r) => ({ code: r.code, role: r.role, assetCode: r.assetCode, balance: r.balances[0]?.available.toFixed() ?? '0' })),
      limits: houseConfig().limits,
      nettingBatches: Object.fromEntries(batches.map((b) => [b.status, b._count])),
      codes: { custody: chartCode.custodyRef('X') },
    };
  }
}
