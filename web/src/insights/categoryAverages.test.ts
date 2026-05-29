import { describe, expect, it } from 'vitest';
import { categoryAverages } from './categoryAverages';
import type { Transaction } from '../activity/types';

function txn(over: Partial<Transaction>): Transaction {
  return {
    id: 't', accountId: 'a', externalId: 'x',
    date: '2026-03-10', processedDate: null, amount: -100,
    currency: 'ILS', description: 'Shop', memo: null,
    kind: null, status: null, category: 'Groceries', createdAt: '2025-01-01',
    ...over,
  };
}

const NONE = () => false;

describe('categoryAverages', () => {
  it('averages spending over the N cycles before the displayed month', () => {
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100, category: 'Groceries' }),
      txn({ id: 'b', date: '2026-04-10', amount: -300, category: 'Groceries' }),
      txn({ id: 'c', date: '2026-05-10', amount: -999, category: 'Groceries' }),
    ];
    const { avgSpending, avgByCat } = categoryAverages(txns, 1, NONE, 2, '2026-05');
    expect(avgSpending).toBe(200);
    expect(avgByCat.get('Groceries')).toBe(200);
  });

  it('ignores cycles outside the window', () => {
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100 }),
      txn({ id: 'b', date: '2026-04-10', amount: -300 }),
    ];
    const { avgSpending } = categoryAverages(txns, 1, NONE, 1, '2026-05');
    expect(avgSpending).toBe(300);
  });

  it('counts only cycles with spending > 0 (skips empty pre-history months)', () => {
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100, category: 'Food' }),
      txn({ id: 'b', date: '2026-04-10', amount: -300, category: 'Food' }),
    ];
    const { avgSpending, avgByCat } = categoryAverages(txns, 1, NONE, 3, '2026-05');
    expect(avgSpending).toBe(200);
    expect(avgByCat.get('Food')).toBe(200);
  });

  it('divides a category by the qualifying-cycle count even when it has no spend some months', () => {
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100, category: 'Food' }),
      txn({ id: 'b', date: '2026-04-10', amount: -300, category: 'Food' }),
      txn({ id: 'c', date: '2026-04-15', amount: -500, category: 'Rent' }),
    ];
    const { avgByCat } = categoryAverages(txns, 1, NONE, 2, '2026-05');
    expect(avgByCat.get('Rent')).toBe(250);
    expect(avgByCat.get('Food')).toBe(200);
  });

  it('skips refund-fold, non-ILS, income, and excluded rows', () => {
    const txns = [
      txn({ id: 'a', date: '2026-04-10', amount: -200, category: 'Food' }),
      txn({ id: 'r', date: '2026-04-11', amount: -50, refundForId: 'a' }),
      txn({ id: 'u', date: '2026-04-12', amount: -300, currency: 'USD' }),
      txn({ id: 'i', date: '2026-04-13', amount: 5000 }),
      txn({ id: 'x', date: '2026-04-14', amount: -900, description: 'CARDBILL' }),
    ];
    const isExcluded = (t: Transaction) => t.description === 'CARDBILL';
    const { avgSpending, avgByCat } = categoryAverages(txns, 1, isExcluded, 1, '2026-05');
    expect(avgSpending).toBe(200);
    expect(avgByCat.get('Food')).toBe(200);
  });

  it('returns null avg and empty map when no qualifying cycles exist', () => {
    const { avgSpending, avgByCat } = categoryAverages([], 1, NONE, 6, '2026-05');
    expect(avgSpending).toBeNull();
    expect(avgByCat.size).toBe(0);
  });

  it('treats windowMonths < 1 as exactly 1 (only the cycle before the displayed month)', () => {
    // Feb -100, Mar -200, Apr -300, displayed May. A window of exactly 1 sees
    // only April → 300. Any clamp > 1 (e.g. to 3) would average Feb+Mar+Apr → 200.
    const txns = [
      txn({ id: 'a', date: '2026-02-10', amount: -100 }),
      txn({ id: 'b', date: '2026-03-10', amount: -200 }),
      txn({ id: 'c', date: '2026-04-10', amount: -300 }),
    ];
    const { avgSpending } = categoryAverages(txns, 1, NONE, 0, '2026-05');
    expect(avgSpending).toBe(300);
  });

  it('buckets a null category under "Other"', () => {
    const txns = [
      txn({ id: 'a', date: '2026-04-10', amount: -250, category: null }),
    ];
    const { avgByCat } = categoryAverages(txns, 1, NONE, 1, '2026-05');
    expect(avgByCat.get('Other')).toBe(250);
  });
});
