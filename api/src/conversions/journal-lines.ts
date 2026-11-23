/**
 * Build balanced multi-asset conversion journal lines.
 * Source legs sum to 0 net; target legs sum to 0 net. Exact decimal arithmetic only.
 *
 * SANDBOX ACCOUNTING ONLY: this models a pure settlement-account swap for demos. A live
 * conversion needs liquidity-provider clearing accounts and receivables (see DATABASE_SCHEMA
 * conversion journals) and must be redesigned before gate G1 opens.
 */
import { cmp, sub } from '@durin/ledger';

export interface SimpleLine {
  accountId: string;
  direction: 'debit' | 'credit';
  amount: string;
  assetCode: string;
}

export function buildConversionLines(params: {
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  targetAmount: string;
  feeAmount: string;
  sourceLiabilityId: string;
  sourceAssetId: string;
  targetLiabilityId: string;
  targetAssetId: string;
  feeRevenueId: string;
}): SimpleLine[] {
  const net = sub(params.sourceAmount, params.feeAmount);
  if (cmp(net, '0') < 0) throw new Error('Fee exceeds source amount');
  const hasFee = cmp(params.feeAmount, '0') > 0;

  const lines: SimpleLine[] = [
    { accountId: params.sourceLiabilityId, direction: 'debit', amount: params.sourceAmount, assetCode: params.sourceAsset },
  ];

  if (hasFee) {
    lines.push({ accountId: params.sourceAssetId, direction: 'credit', amount: net, assetCode: params.sourceAsset });
    lines.push({ accountId: params.feeRevenueId, direction: 'credit', amount: params.feeAmount, assetCode: params.sourceAsset });
  } else {
    lines.push({ accountId: params.sourceAssetId, direction: 'credit', amount: params.sourceAmount, assetCode: params.sourceAsset });
  }

  lines.push({ accountId: params.targetAssetId, direction: 'debit', amount: params.targetAmount, assetCode: params.targetAsset });
  lines.push({ accountId: params.targetLiabilityId, direction: 'credit', amount: params.targetAmount, assetCode: params.targetAsset });

  return lines;
}
