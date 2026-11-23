export type LedgerErrorCode =
  | 'EMPTY_JOURNAL'
  | 'INVALID_AMOUNT'
  | 'INVALID_DIRECTION'
  | 'INVALID_ASSET'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'UNBALANCED_JOURNAL';

/** Thrown when an input violates a ledger invariant before it reaches the database. */
export class LedgerInvariantError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerInvariantError';
  }
}
