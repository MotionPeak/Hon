import { describe, expect, it } from 'vitest';
import { allocatePayments } from '../src/splitwise.js';
import type { SplitwiseLink } from '../src/repo.js';

const link = (over: Partial<SplitwiseLink>): SplitwiseLink => ({
  transactionId: 'e', expenseId: 'x', groupId: null, currency: 'ILS',
  owedToMe: 60, counterparties: [{ id: 2, name: 'A', owed: 60 }],
  paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null, ...over,
});

describe('allocatePayments', () => {
  it('marks a link paid when the pool covers it', () => {
    const out = allocatePayments([link({})], new Map([['2|ILS', 60]]));
    expect(out[0]).toMatchObject({ paidAmount: 60, paidState: 'paid' });
    expect(out[0].counterparties[0].paid).toBe(60);
  });

  it('marks partial when the pool is short', () => {
    const out = allocatePayments([link({})], new Map([['2|ILS', 25]]));
    expect(out[0]).toMatchObject({ paidAmount: 25, paidState: 'partial' });
  });

  it('leaves a link open when the pool is empty', () => {
    const out = allocatePayments([link({})], new Map());
    expect(out[0]).toMatchObject({ paidAmount: 0, paidState: 'open' });
  });

  it('consumes a person pool oldest-first across links', () => {
    const out = allocatePayments(
      [link({ transactionId: 'new', createdAt: '2026-05-10' }),
       link({ transactionId: 'old', createdAt: '2026-05-01' })],
      new Map([['2|ILS', 60]]),
    );
    const byId = Object.fromEntries(out.map((r) => [r.transactionId, r]));
    expect(byId.old.paidState).toBe('paid');
    expect(byId.new.paidState).toBe('open');
  });

  it('ignores a pool in a different currency', () => {
    const out = allocatePayments([link({})], new Map([['2|USD', 60]]));
    expect(out[0].paidState).toBe('open');
  });

  it('does not over-allocate beyond what is owed', () => {
    const out = allocatePayments([link({})], new Map([['2|ILS', 200]]));
    expect(out[0].paidAmount).toBe(60);
  });

  it('splits a payment across multiple counterparties in one link', () => {
    const out = allocatePayments(
      [link({ owedToMe: 100, counterparties: [
        { id: 2, name: 'A', owed: 60 }, { id: 3, name: 'B', owed: 40 },
      ] })],
      new Map([['2|ILS', 60], ['3|ILS', 20]]),
    );
    expect(out[0].paidAmount).toBe(80);
    expect(out[0].paidState).toBe('partial');
    expect(out[0].counterparties.find((c) => c.id === 3)?.paid).toBe(20);
  });
});
