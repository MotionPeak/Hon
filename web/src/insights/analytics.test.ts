import { describe, expect, it } from 'vitest';
import { cycleAnalytics } from './analytics';
import type { Transaction } from '../activity/types';

function txn(over: Partial<Transaction>): Transaction {
  return {
    id: 't', accountId: 'a', externalId: 'x',
    date: '2026-05-10', processedDate: null, amount: -100,
    currency: 'ILS', description: 'Shop', memo: null,
    kind: null, status: null, category: 'Groceries', createdAt: '2025-01-01',
    ...over,
  };
}

describe('cycleAnalytics', () => {
  it('returns 12 months, newest last', () => {
    const out = cycleAnalytics([], 1);
    expect(out).toHaveLength(12);
    // Months strictly increasing.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].month > out[i - 1].month).toBe(true);
    }
  });

  it('sums spending and income into the right month bucket', () => {
    const today = new Date();
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const out = cycleAnalytics([
      txn({ id: 't1', amount: -200, date: `${thisMonth}-10` }),
      txn({ id: 't2', amount: -50, date: `${thisMonth}-15` }),
      txn({ id: 't3', amount: 1500, date: `${thisMonth}-01` }),
    ], 1);
    const current = out.find((m) => m.month === thisMonth);
    expect(current?.spending).toBe(250);
    expect(current?.income).toBe(1500);
  });

  it('skips refund-fold rows (refundForId) and non-ILS', () => {
    const today = new Date();
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const out = cycleAnalytics([
      txn({ id: 't1', amount: -200, date: `${thisMonth}-10` }),
      txn({ id: 't2', amount: -50, date: `${thisMonth}-15`, refundForId: 't1' }),
      txn({ id: 't3', amount: -300, date: `${thisMonth}-20`, currency: 'USD' }),
    ], 1);
    const current = out.find((m) => m.month === thisMonth);
    expect(current?.spending).toBe(200);
  });

  it('skips transactions the isExcluded predicate rejects (card-bill totals)', () => {
    const today = new Date();
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const out = cycleAnalytics([
      txn({ id: 't1', amount: -200, date: `${thisMonth}-10`, description: 'Shop' }),
      txn({ id: 'card', amount: -9000, date: `${thisMonth}-12`, description: 'מקס איט פיננסים' }),
    ], 1, (t) => t.description === 'מקס איט פיננסים');
    const current = out.find((m) => m.month === thisMonth);
    // The ₪9,000 card-bill lump sum is excluded; only the ₪200 shop counts.
    expect(current?.spending).toBe(200);
  });

  it('honours custom monthStartDay for cycle boundaries', () => {
    const today = new Date();
    // Pick a date that's in this calendar month but BEFORE day 20.
    // With monthStartDay=20, it belongs to the previous cycle.
    const day = String(Math.min(15, today.getDate())).padStart(2, '0');
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const cur = `${today.getFullYear()}-${m}-${day}`;
    const out = cycleAnalytics([
      txn({ id: 't1', amount: -100, date: cur }),
    ], 20);
    // The cycle bucket for cur with monthStartDay=20 is one calendar month
    // before the cur-month — the spending should land there, not in this month.
    const thisMonthKey = `${today.getFullYear()}-${m}`;
    const here = out.find((b) => b.month === thisMonthKey);
    expect(here?.spending ?? 0).toBe(0);
  });
});
