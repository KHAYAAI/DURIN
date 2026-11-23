import { BadRequestException } from '@nestjs/common';
import { cmp, decimalPlaces, LedgerInvariantError } from '@durin/ledger';

/** Decimal places allowed per asset (ZAR cents, USDC/USDT micro-units). */
export const ASSET_SCALES: Readonly<Record<string, number>> = {
  ZAR: 2,
  USDC: 6,
  USDT: 6,
};

export function assetScale(assetCode: string): number {
  return ASSET_SCALES[assetCode.toUpperCase()] ?? 18;
}

/**
 * Validates a client-supplied amount: exact decimal string, strictly positive, and not more
 * precise than the asset allows. Throws 400 (never 500) on bad input.
 */
export function assertPositiveAmount(value: string, assetCode?: string): void {
  try {
    if (cmp(value, '0') <= 0) {
      throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'Amount must be positive' });
    }
    if (assetCode && decimalPlaces(value) > assetScale(assetCode)) {
      throw new BadRequestException({
        code: 'INVALID_AMOUNT',
        message: `${assetCode.toUpperCase()} supports at most ${assetScale(assetCode)} decimal places`,
      });
    }
  } catch (e) {
    if (e instanceof LedgerInvariantError) {
      throw new BadRequestException({ code: e.code, message: e.message });
    }
    throw e;
  }
}
