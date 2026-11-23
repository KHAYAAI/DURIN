import { formatDecimal, parseDecimal } from './decimal';
import { LedgerInvariantError } from './errors';
import type { AccountType, JournalLineInput, PostJournalInput } from './types';

const ASSET_PATTERN = /^[A-Za-z0-9]{2,16}$/;

/**
 * Pure validation of a journal before it touches the database.
 * The database enforces the same rules again with triggers (defence in depth).
 */
export function validateJournalInput(input: PostJournalInput): void {
  if (input.idempotencyKey !== undefined && (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 255)) {
    throw new LedgerInvariantError('INVALID_IDEMPOTENCY_KEY', 'Idempotency key must be 1-255 characters');
  }
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new LedgerInvariantError('EMPTY_JOURNAL', 'A journal needs at least two lines');
  }

  const netByAsset = new Map<string, bigint>();
  for (const line of input.lines) {
    if (line.direction !== 'debit' && line.direction !== 'credit') {
      throw new LedgerInvariantError('INVALID_DIRECTION', `Invalid direction: ${String(line.direction)}`);
    }
    if (typeof line.assetCode !== 'string' || !ASSET_PATTERN.test(line.assetCode)) {
      throw new LedgerInvariantError('INVALID_ASSET', `Invalid asset code: ${String(line.assetCode)}`);
    }
    const amount = parseDecimal(line.amount);
    if (amount <= 0n) {
      throw new LedgerInvariantError('INVALID_AMOUNT', `Line amounts must be strictly positive: ${line.amount}`);
    }
    const asset = line.assetCode.toUpperCase();
    const signed = line.direction === 'debit' ? amount : -amount;
    netByAsset.set(asset, (netByAsset.get(asset) ?? 0n) + signed);
  }

  for (const [asset, net] of netByAsset) {
    if (net !== 0n) {
      throw new LedgerInvariantError('UNBALANCED_JOURNAL', `Debits and credits differ for ${asset}`);
    }
  }
}

/** Account types whose normal balance is a debit. `system` clearing accounts are treated as debit-normal. */
const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set(['asset', 'expense', 'system']);

/**
 * Net change to an account's `available` balance (on its normal side) caused by the given
 * lines. Positive means the balance grows. Matches the database trigger.
 */
export function netAvailableDelta(accountType: AccountType | string, lines: ReadonlyArray<Pick<JournalLineInput, 'direction' | 'amount'>>): string {
  const debitNormal = DEBIT_NORMAL.has(accountType as AccountType);
  let total = 0n;
  for (const line of lines) {
    const amount = parseDecimal(line.amount);
    const increases = (line.direction === 'debit') === debitNormal;
    total += increases ? amount : -amount;
  }
  return formatDecimal(total);
}
