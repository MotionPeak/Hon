import { describe, it, expect } from 'vitest';
import { categorySpend, buildPieCats, savedThisCycle } from './spend';
import type { Transaction } from '../activity/types';
import type { Category } from '../settings/CategoriesPanel';

function txn(over: Partial<Transaction>): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    accountId: 'a', externalId: 'e', date: '2026-05-10',
    processedDate: null, amount: -100, currency: 'ILS',
    description: 'x', memo: null, kind: null, status: null,
    category: 'Groceries', createdAt: '', ...over,
  };
}

const noExclude = (): boolean => false;

describe('categorySpend', () => {
  it('sums ILS expenses per category for the cycle, ignoring income', () => {
    const txns = [
      txn({ amount: -100, category: 'Groceries' }),
      txn({ amount: -50, category: 'Groceries' }),
      txn({ amount: -30, category: 'Transport' }),
      txn({ amount: 5000, category: 'Salary' }), // income — ignored
    ];
    const r = categorySpend(txns, '2026-05', 1, noExclude);
    expect(r.total).toBe(180);
    expect(r.byCat.get('Groceries')).toBe(150);
    expect(r.byCat.get('Transport')).toBe(30);
    expect(r.byCat.has('Salary')).toBe(false);
  });

  it('skips non-ILS, refund-fold, excluded and off-cycle rows', () => {
    const txns = [
      txn({ amount: -100, currency: 'USD' }),
      txn({ amount: -100, refundForId: 'r1' }),
      txn({ amount: -100, description: 'CARD BILL' }),
      txn({ amount: -100, date: '2026-04-10' }), // previous cycle
    ];
    const isExcluded = (t: Transaction): boolean => (t.description ?? '').includes('CARD');
    const r = categorySpend(txns, '2026-05', 1, isExcluded);
    expect(r.total).toBe(0);
  });

  it('falls back to Uncategorized when category is empty', () => {
    const r = categorySpend([txn({ amount: -20, category: null })], '2026-05', 1, noExclude);
    expect(r.byCat.get('Uncategorized')).toBe(20);
  });
});

describe('buildPieCats', () => {
  const cats: Category[] = [
    { name: 'Groceries', emoji: '🛒', color: '#f00', catGroup: 'essential' } as Category,
  ];

  it('sorts biggest-first and attaches colour/emoji + change vs last cycle', () => {
    const txns = [
      txn({ amount: -200, category: 'Groceries', date: '2026-05-10' }),
      txn({ amount: -90, category: 'Transport', date: '2026-05-10' }),
      txn({ amount: -100, category: 'Groceries', date: '2026-04-10' }), // prev cycle
    ];
    const { cats: out, total } = buildPieCats(txns, cats, 1, noExclude, '2026-05', '2026-04');
    expect(total).toBe(290);
    expect(out[0].category).toBe('Groceries');
    expect(out[0].color).toBe('#f00');
    expect(out[0].emoji).toBe('🛒');
    expect(out[0].changePct).toBeCloseTo(100); // 100 → 200
    expect(out[1].category).toBe('Transport');
    expect(out[1].changePct).toBeNull(); // no prior spend
  });

  it('uses the default chip for categories with no matching row', () => {
    const { cats: out } = buildPieCats(
      [txn({ amount: -10, category: 'Mystery' })], [], 1, noExclude, '2026-05', '2026-04',
    );
    expect(out[0].color).toBe('#8C8FA8');
    expect(out[0].emoji).toBe('🏷️');
  });
});

describe('savedThisCycle', () => {
  it('sums |amount| of ILS savings rows in the cycle, ignores the rest', () => {
    const txns = [
      txn({ amount: -1000, savings: true, date: '2026-05-10' }),
      txn({ amount: -250, savings: true, date: '2026-05-20' }),
      txn({ amount: -999, savings: false, date: '2026-05-10' }), // not savings
      txn({ amount: -500, savings: true, currency: 'USD', date: '2026-05-10' }), // non-ILS
      txn({ amount: -700, savings: true, date: '2026-04-10' }), // prev cycle
    ];
    expect(savedThisCycle(txns, '2026-05', 1)).toBe(1250);
  });
});
