import { describe, expect, it } from 'vitest';
import { LedgerInvariantError, netAvailableDelta, validateJournalInput, type PostJournalInput } from '../src';

const base = (lines: PostJournalInput['lines']): PostJournalInput => ({ organisationId: 'org', lines });
const line = (direction: 'debit' | 'credit', amount: string, assetCode = 'ZAR', accountId = 'a') => ({ accountId, direction, amount, assetCode });

function code(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof LedgerInvariantError ? e.code : 'OTHER';
  }
  return undefined;
}

describe('validateJournalInput', () => {
  it('accepts a balanced journal', () => {
    expect(code(() => validateJournalInput(base([line('debit', '100.50'), line('credit', '100.50', 'ZAR', 'b')])))).toBeUndefined();
  });

  it('accepts a multi-asset journal balanced per asset', () => {
    const lines = [line('debit', '10000', 'ZAR', 'a'), line('credit', '10000', 'ZAR', 'b'), line('debit', '540', 'USDC', 'c'), line('credit', '540', 'USDC', 'd')];
    expect(code(() => validateJournalInput(base(lines)))).toBeUndefined();
  });

  it('rejects debits and credits that only balance across assets', () => {
    const lines = [line('debit', '100', 'ZAR'), line('credit', '100', 'USDC', 'b')];
    expect(code(() => validateJournalInput(base(lines)))).toBe('UNBALANCED_JOURNAL');
  });

  it('rejects unbalanced, single-line, zero, negative and malformed amounts', () => {
    expect(code(() => validateJournalInput(base([line('debit', '10'), line('credit', '9', 'ZAR', 'b')])))).toBe('UNBALANCED_JOURNAL');
    expect(code(() => validateJournalInput(base([line('debit', '10')])))).toBe('EMPTY_JOURNAL');
    expect(code(() => validateJournalInput(base([line('debit', '0'), line('credit', '0', 'ZAR', 'b')])))).toBe('INVALID_AMOUNT');
    expect(code(() => validateJournalInput(base([line('debit', '-5'), line('credit', '-5', 'ZAR', 'b')])))).toBe('INVALID_AMOUNT');
    expect(code(() => validateJournalInput(base([line('debit', '1e3'), line('credit', '1e3', 'ZAR', 'b')])))).toBe('INVALID_AMOUNT');
  });

  it('rejects bad directions, assets and idempotency keys', () => {
    expect(code(() => validateJournalInput(base([{ ...line('debit', '1'), direction: 'up' as never }, line('credit', '1', 'ZAR', 'b')])))).toBe('INVALID_DIRECTION');
    expect(code(() => validateJournalInput(base([line('debit', '1', 'Z!'), line('credit', '1', 'Z!', 'b')])))).toBe('INVALID_ASSET');
    expect(code(() => validateJournalInput({ ...base([line('debit', '1'), line('credit', '1', 'ZAR', 'b')]), idempotencyKey: '' }))).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('is not fooled by float-like sums', () => {
    const lines = [line('debit', '0.1', 'ZAR', 'a'), line('debit', '0.2', 'ZAR', 'b'), line('credit', '0.3', 'ZAR', 'c')];
    expect(code(() => validateJournalInput(base(lines)))).toBeUndefined();
  });
});

describe('netAvailableDelta', () => {
  const lines = [{ direction: 'debit' as const, amount: '100' }, { direction: 'credit' as const, amount: '30.5' }];
  it('grows debit-normal accounts on debits', () => {
    expect(netAvailableDelta('asset', lines)).toBe('69.5');
    expect(netAvailableDelta('expense', lines)).toBe('69.5');
    expect(netAvailableDelta('system', lines)).toBe('69.5');
  });
  it('grows credit-normal accounts on credits', () => {
    expect(netAvailableDelta('liability', lines)).toBe('-69.5');
    expect(netAvailableDelta('revenue', lines)).toBe('-69.5');
    expect(netAvailableDelta('equity', lines)).toBe('-69.5');
  });
});
