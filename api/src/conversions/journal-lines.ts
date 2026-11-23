/**
 * Build balanced multi-asset conversion journal lines.
 * Source legs sum to 0 net; target legs sum to 0 net.
 */

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
  const fee = Number(params.feeAmount);
  const src = Number(params.sourceAmount);
  const net = src - fee;
  if (net < 0) throw new Error('Fee exceeds source amount');

  const netStr = trimNum(net);
  const feeStr = trimNum(fee);
  const srcStr = trimNum(src);
  const tgtStr = trimNum(Number(params.targetAmount));

  const lines: SimpleLine[] = [];

  // Source asset balanced block
  lines.push({
    accountId: params.sourceLiabilityId,
    direction: 'debit',
    amount: srcStr,
    assetCode: params.sourceAsset,
  });

  if (fee > 0) {
    lines.push({
      accountId: params.sourceAssetId,
      direction: 'credit',
      amount: netStr,
      assetCode: params.sourceAsset,
    });
    lines.push({
      accountId: params.feeRevenueId,
      direction: 'credit',
      amount: feeStr,
      assetCode: params.sourceAsset,
    });
  } else {
    lines.push({
      accountId: params.sourceAssetId,
      direction: 'credit',
      amount: srcStr,
      assetCode: params.sourceAsset,
    });
  }

  // Target asset balanced block
  lines.push({
    accountId: params.targetAssetId,
    direction: 'debit',
    amount: tgtStr,
    assetCode: params.targetAsset,
  });
  lines.push({
    accountId: params.targetLiabilityId,
    direction: 'credit',
    amount: tgtStr,
    assetCode: params.targetAsset,
  });

  return lines;
}

function trimNum(n: number): string {
  return n.toFixed(8).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}
