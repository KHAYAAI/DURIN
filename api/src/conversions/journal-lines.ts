/**
 * Conversion journals (custody-reference model; see ledger/chart.ts).
 *
 *  reserve:  Dr CUST-LIAB-src S          / Cr CONV-INTRANSIT-src S
 *  release:  Dr CONV-INTRANSIT-src S     / Cr CUST-LIAB-src S             (LP rejected / not executed)
 *  fill:     src: Dr CONV-INTRANSIT-src S / Cr LP-CLEARING-src N, Cr FEE-REVENUE-src F
 *            tgt: Dr LP-CLEARING-tgt T    / Cr CUST-LIAB-tgt T            (customer credited on DELIVERY)
 *  settle:   src: Dr LP-CLEARING-src N    / Cr CUSTODY-REF-src N          (funds left custody)
 *            tgt: Dr CUSTODY-REF-tgt T    / Cr LP-CLEARING-tgt T          (funds arrived in custody)
 *
 * S = source amount, F = fee, N = S - F (sent to the LP), T = target amount. Each journal balances
 * per asset. Exact decimal arithmetic only.
 */
import { cmp, sub } from '@durin/ledger';

export interface SimpleLine {
  accountId: string;
  direction: 'debit' | 'credit';
  amount: string;
  assetCode: string;
}

export interface ConversionAccounts {
  srcCustomer: string; srcInTransit: string; srcLp: string; srcFee: string; srcCustody: string;
  tgtCustomer: string; tgtLp: string; tgtCustody: string;
}

export function reserveLines(a: ConversionAccounts, asset: string, source: string): SimpleLine[] {
  return [
    { accountId: a.srcCustomer, direction: 'debit', amount: source, assetCode: asset },
    { accountId: a.srcInTransit, direction: 'credit', amount: source, assetCode: asset },
  ];
}

export function releaseLines(a: ConversionAccounts, asset: string, source: string): SimpleLine[] {
  return [
    { accountId: a.srcInTransit, direction: 'debit', amount: source, assetCode: asset },
    { accountId: a.srcCustomer, direction: 'credit', amount: source, assetCode: asset },
  ];
}

export function fillLines(a: ConversionAccounts, p: { sourceAsset: string; targetAsset: string; source: string; fee: string; target: string }): SimpleLine[] {
  const net = sub(p.source, p.fee);
  if (cmp(net, '0') < 0) throw new Error('Fee exceeds source amount');
  const lines: SimpleLine[] = [
    { accountId: a.srcInTransit, direction: 'debit', amount: p.source, assetCode: p.sourceAsset },
  ];
  if (cmp(net, '0') > 0) lines.push({ accountId: a.srcLp, direction: 'credit', amount: net, assetCode: p.sourceAsset });
  if (cmp(p.fee, '0') > 0) lines.push({ accountId: a.srcFee, direction: 'credit', amount: p.fee, assetCode: p.sourceAsset });
  lines.push({ accountId: a.tgtLp, direction: 'debit', amount: p.target, assetCode: p.targetAsset });
  lines.push({ accountId: a.tgtCustomer, direction: 'credit', amount: p.target, assetCode: p.targetAsset });
  return lines;
}

export function settleLines(a: ConversionAccounts, p: { sourceAsset: string; targetAsset: string; source: string; fee: string; target: string }): SimpleLine[] {
  const net = sub(p.source, p.fee);
  const lines: SimpleLine[] = [];
  if (cmp(net, '0') > 0) {
    lines.push({ accountId: a.srcLp, direction: 'debit', amount: net, assetCode: p.sourceAsset });
    lines.push({ accountId: a.srcCustody, direction: 'credit', amount: net, assetCode: p.sourceAsset });
  }
  lines.push({ accountId: a.tgtCustody, direction: 'debit', amount: p.target, assetCode: p.targetAsset });
  lines.push({ accountId: a.tgtLp, direction: 'credit', amount: p.target, assetCode: p.targetAsset });
  return lines;
}
