/**
 * DURIN chart of accounts — custody-reference model.
 *
 * DURIN does not hold customer funds. Crypto sits with the Layer 1 custodian and fiat with the
 * Layer 2 regulated entity. The ledger therefore records:
 *
 *   CUSTODY-REF-{A}   asset      mirror of what the custodian reports it holds for DURIN's customers
 *   CUST-LIAB-{A}     liability  what DURIN's customers are entitled to (their balance)
 *   CONV-INTRANSIT-{A} liability customer value reserved for an in-flight conversion
 *   LP-CLEARING-{A}   asset      net position with the liquidity provider (may swing either way)
 *   FEE-REVENUE-{A}   revenue    DURIN's earned fees
 *
 * Invariant (checked by reconciliation): CUSTODY-REF balance == custodian-reported balance, and
 * CUSTODY-REF + LP-CLEARING >= CUST-LIAB + CONV-INTRANSIT (no customer entitlement is unbacked).
 */
import { LedgerService } from './ledger.service';

export type Custodian = 'layer1' | 'layer2';

const FIAT = new Set(['ZAR', 'USD']);

export function custodianFor(assetCode: string): Custodian {
  return FIAT.has(assetCode.toUpperCase()) ? 'layer2' : 'layer1';
}

export const chartCode = {
  custodyRef: (a: string) => `CUSTODY-REF-${a.toUpperCase()}`,
  customer: (a: string) => `CUST-LIAB-${a.toUpperCase()}`,
  inTransit: (a: string) => `CONV-INTRANSIT-${a.toUpperCase()}`,
  lpClearing: (a: string) => `LP-CLEARING-${a.toUpperCase()}`,
  feeRevenue: (a: string) => `FEE-REVENUE-${a.toUpperCase()}`,
};

export async function ensureCustodyRef(ledger: LedgerService, orgId: string, asset: string) {
  const a = asset.toUpperCase();
  return ledger.ensureAccount(orgId, {
    code: chartCode.custodyRef(a), name: `Custody reference ${a}`, accountType: 'asset', assetCode: a,
    role: 'custody_ref', custodian: custodianFor(a),
  });
}
export async function ensureCustomer(ledger: LedgerService, orgId: string, asset: string) {
  const a = asset.toUpperCase();
  return ledger.ensureAccount(orgId, {
    code: chartCode.customer(a), name: `Customer balances ${a}`, accountType: 'liability', assetCode: a, role: 'customer',
  });
}
export async function ensureInTransit(ledger: LedgerService, orgId: string, asset: string) {
  const a = asset.toUpperCase();
  return ledger.ensureAccount(orgId, {
    code: chartCode.inTransit(a), name: `Conversion in transit ${a}`, accountType: 'liability', assetCode: a, role: 'in_transit',
  });
}
export async function ensureLpClearing(ledger: LedgerService, orgId: string, asset: string) {
  const a = asset.toUpperCase();
  return ledger.ensureAccount(orgId, {
    code: chartCode.lpClearing(a), name: `Liquidity provider clearing ${a}`, accountType: 'asset', assetCode: a,
    allowNegative: true, role: 'lp_clearing',
  });
}
export async function ensureFeeRevenue(ledger: LedgerService, orgId: string, asset: string) {
  const a = asset.toUpperCase();
  return ledger.ensureAccount(orgId, {
    code: chartCode.feeRevenue(a), name: `Fee revenue ${a}`, accountType: 'revenue', assetCode: a, role: 'fee_revenue',
  });
}
