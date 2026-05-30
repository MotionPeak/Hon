import { describe, expect, it } from 'vitest';
import { owedByFriend } from './owed';
import type { SplitwiseLink } from './types';

const link = (over: Partial<SplitwiseLink>): SplitwiseLink => ({
  transactionId: 'e', expenseId: 'x', groupId: null, currency: 'ILS',
  owedToMe: 60, counterparties: [{ id: 2, name: 'Roomie', owed: 60 }],
  paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null, ...over,
});

describe('owedByFriend', () => {
  it('sums remaining (owed - paid) per friend across links', () => {
    const out = owedByFriend([
      link({ transactionId: 'a', counterparties: [{ id: 2, name: 'Roomie', owed: 60, paid: 0 }] }),
      link({ transactionId: 'b', counterparties: [{ id: 2, name: 'Roomie', owed: 40, paid: 10 }] }),
    ]);
    expect(out).toEqual([{ id: 2, name: 'Roomie', currency: 'ILS', owed: 90 }]);
  });

  it('drops a friend who is fully paid', () => {
    const out = owedByFriend([
      link({ counterparties: [{ id: 2, name: 'Roomie', owed: 60, paid: 60 }] }),
    ]);
    expect(out).toEqual([]);
  });

  it('keeps currencies separate', () => {
    const out = owedByFriend([
      link({ transactionId: 'a', currency: 'ILS' }),
      link({ transactionId: 'b', currency: 'USD', counterparties: [{ id: 2, name: 'Roomie', owed: 10 }] }),
    ]);
    expect(out).toHaveLength(2);
  });
});
