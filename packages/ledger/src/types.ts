export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'system';
export type Direction = 'debit' | 'credit';

export interface JournalLineInput {
  accountId: string;
  direction: Direction;
  /** Positive decimal string, e.g. "100.50". */
  amount: string;
  assetCode: string;
  metadata?: Record<string, unknown>;
}

export interface PostJournalInput {
  organisationId: string;
  reference?: string;
  description?: string;
  idempotencyKey?: string;
  /** ISO date (YYYY-MM-DD). */
  valueDate?: string;
  lines: JournalLineInput[];
}
