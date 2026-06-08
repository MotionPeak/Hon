import { describe, it, expect, afterEach, vi } from 'vitest';
import { installFetchMock } from '../test/mockFetch';
import {
  listTransactions,
  listTransactionLinks,
  setTransactionCategory,
  setTransactionExcluded,
  unlinkRefund,
} from './transactions';

afterEach(() => vi.restoreAllMocks());

const txn = {
  id: 't1', accountId: 'a1', externalId: 'x1', date: '2026-05-01',
  processedDate: null, amount: -42, currency: 'ILS', description: 'COFFEE',
  memo: null, kind: null, status: null, category: 'Dining', createdAt: '2026-05-01',
};

describe('listTransactions', () => {
  it('parses { transactions } from GET /transactions', async () => {
    installFetchMock({ 'GET /api/transactions': () => ({ transactions: [txn] }) });
    await expect(listTransactions()).resolves.toEqual([txn]);
  });

  it('rejects when a row drifts (amount not a number)', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({ transactions: [{ ...txn, amount: 'nope' }] }),
    });
    await expect(listTransactions()).rejects.toThrow();
  });
});

describe('transaction mutations', () => {
  it('PATCHes /transactions/:id/category with the category body', async () => {
    let body: unknown;
    installFetchMock({
      'PATCH /api/transactions/t1/category': (b) => { body = b; return { ok: true }; },
    });
    await setTransactionCategory('t1', 'Dining');
    expect(body).toEqual({ category: 'Dining' });
  });

  it('PATCHes /transactions/:id/excluded with a tri-state null', async () => {
    let body: unknown;
    installFetchMock({
      'PATCH /api/transactions/t1/excluded': (b) => { body = b; return { ok: true }; },
    });
    await setTransactionExcluded('t1', null);
    expect(body).toEqual({ excluded: null });
  });

  it('DELETEs /transactions/:id/link to unlink a refund', async () => {
    const spy = installFetchMock({ 'DELETE /api/transactions/t1/link': () => ({ ok: true }) });
    await unlinkRefund('t1');
    expect(spy).toHaveBeenCalledWith(
      '/api/transactions/t1/link',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('appends ?refundId= when unlinking ONE specific reimbursement', async () => {
    const spy = installFetchMock({ 'DELETE /api/transactions/e1/link': () => ({ ok: true }) });
    await unlinkRefund('e1', 'r1');
    expect(spy).toHaveBeenCalledWith(
      '/api/transactions/e1/link?refundId=r1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('listTransactionLinks', () => {
  it('parses the allocations array from GET /transaction-links', async () => {
    installFetchMock({
      'GET /api/transaction-links': () => ({ links: [
        { expenseId: 'e1', refundId: 'r1', amount: 3000 },
        { expenseId: 'e1', refundId: 'r2', amount: 2250 },
      ] }),
    });
    const links = await listTransactionLinks();
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ expenseId: 'e1', refundId: 'r1', amount: 3000 });
  });
});
