import { describe, expect, it } from 'vitest';
import { detectMerchants, LOAN_GROUP_KEY, type RecurringData } from './helpers';
import type { Transaction } from '../activity/types';
import type { Category } from '../settings/CategoriesPanel';

// Banks post a single loan instalment as several lines with different
// descriptions (principal / interest / fee), often under different categories.
// detectMerchants collapses every line whose description names a loan
// (הלוואה/הלואה) into ONE "Loan" row whose monthly = the latest cycle's sum.

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: 'id', accountId: 'a', externalId: 'x',
    date: '2026-06-10', processedDate: null,
    amount: -100, currency: 'ILS',
    description: 'desc', memo: null, kind: null, status: null,
    category: null, createdAt: '2025-01-01',
    ...over,
  } as Transaction;
}

const CATEGORIES = [
  { name: 'Fees', catGroup: 'fixed', color: '#000', emoji: '💸' },
  { name: 'Housing', catGroup: 'fixed', color: '#000', emoji: '🏠' },
] as unknown as Category[];

function data(transactions: Transaction[]): RecurringData {
  return {
    transactions, categories: CATEGORIES,
    frequencies: {}, splits: {}, shareAmounts: {}, cancelled: {},
  };
}

describe('detectMerchants — loan grouping', () => {
  it('merges principal + interest + fee into one Loan row summing the latest cycle', () => {
    const { rows } = detectMerchants(data([
      // May instalment
      tx({ id: 'm1', date: '2026-05-10', amount: -1036.07, description: 'הלוואה - תשלום קרן', category: null }),
      tx({ id: 'm2', date: '2026-05-10', amount: -640.04, description: 'הלוואה-תשלום 108', category: 'Fees' }),
      tx({ id: 'm3', date: '2026-05-10', amount: -70.42, description: 'ריבית על הלוואה 00880 28/04', category: null }),
      // June instalment
      tx({ id: 'j1', date: '2026-06-10', amount: -1036.07, description: 'הלוואה - תשלום קרן', category: null }),
      tx({ id: 'j2', date: '2026-06-10', amount: -640.04, description: 'הלוואה-תשלום 108', category: 'Fees' }),
      tx({ id: 'j3', date: '2026-06-10', amount: -70.42, description: 'ריבית על הלוואה 00880 28/05', category: null }),
    ]), 1);

    const loans = rows.filter((r) => r.key === LOAN_GROUP_KEY);
    expect(loans).toHaveLength(1);
    expect(loans[0].lastChargeAbs).toBeCloseTo(1746.53, 2);
    expect(loans[0].monthlyShare).toBeCloseTo(1746.53, 2);
    expect(loans[0].category).toBe('Fees');
    // The standalone ₪640 fee line must NOT survive as its own row.
    const strays = rows.filter((r) => r.key !== LOAN_GROUP_KEY
      && Math.abs(r.lastChargeAbs - 640.04) < 0.01);
    expect(strays).toHaveLength(0);
  });

  it('counts only repayments — a positive disbursement never inflates the sum', () => {
    const { rows } = detectMerchants(data([
      tx({ id: 'm', date: '2026-05-10', amount: -1000, description: 'הלוואה תשלום', category: 'Fees' }),
      tx({ id: 'j', date: '2026-06-10', amount: -1000, description: 'הלוואה תשלום', category: 'Fees' }),
      tx({ id: 'd', date: '2026-06-15', amount: 5000, description: 'קבלת הלוואה', category: 'Fees' }),
    ]), 1);
    const loan = rows.find((r) => r.key === LOAN_GROUP_KEY);
    expect(loan?.lastChargeAbs).toBeCloseTo(1000, 2);
  });

  it('still needs 2+ cycles — a one-off loan charge is not treated as recurring', () => {
    const { rows } = detectMerchants(data([
      tx({ id: 'one', date: '2026-06-10', amount: -1500, description: 'הלוואה תשלום', category: 'Fees' }),
    ]), 1);
    expect(rows.some((r) => r.key === LOAN_GROUP_KEY)).toBe(false);
  });

  it('leaves non-loan fixed merchants as their own rows', () => {
    const { rows } = detectMerchants(data([
      tx({ id: 'a1', date: '2026-05-03', amount: -300, description: 'ארנונה', category: 'Housing' }),
      tx({ id: 'a2', date: '2026-06-03', amount: -300, description: 'ארנונה', category: 'Housing' }),
    ]), 1);
    expect(rows.some((r) => r.key === LOAN_GROUP_KEY)).toBe(false);
    expect(rows.some((r) => r.desc === 'ארנונה')).toBe(true);
  });
});
