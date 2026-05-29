import { describe, expect, it } from 'vitest';
import { earliestTxnDate } from './txnCap';

describe('earliestTxnDate', () => {
  it('returns null when transactions is empty', () => {
    expect(earliestTxnDate([], new Set(['a1']))).toBeNull();
  });

  it('returns null when no transactions belong to scoped accounts', () => {
    const txns = [{ date: '2024-01-15', accountId: 'other' }];
    expect(earliestTxnDate(txns, new Set(['a1']))).toBeNull();
  });

  it('returns the single transaction date when only one matches', () => {
    const txns = [
      { date: '2025-03-10', accountId: 'a1' },
      { date: '2024-01-01', accountId: 'out-of-scope' },
    ];
    expect(earliestTxnDate(txns, new Set(['a1']))).toBe('2025-03-10');
  });

  it('returns the earliest date across multiple matching transactions', () => {
    const txns = [
      { date: '2025-06-01', accountId: 'a1' },
      { date: '2025-01-15', accountId: 'a1' },
      { date: '2025-03-20', accountId: 'a2' },
    ];
    expect(earliestTxnDate(txns, new Set(['a1', 'a2']))).toBe('2025-01-15');
  });

  it('ignores transactions with null or undefined date', () => {
    const txns = [
      { date: null, accountId: 'a1' },
      { date: undefined, accountId: 'a1' },
      { date: '2026-02-01', accountId: 'a1' },
    ];
    expect(earliestTxnDate(txns, new Set(['a1']))).toBe('2026-02-01');
  });

  it('scopes correctly when acctFilter is a single account', () => {
    const txns = [
      { date: '2023-05-01', accountId: 'brk-1' },
      { date: '2024-01-01', accountId: 'brk-2' },
    ];
    // Only brk-2 is in scope
    expect(earliestTxnDate(txns, new Set(['brk-2']))).toBe('2024-01-01');
  });
});
