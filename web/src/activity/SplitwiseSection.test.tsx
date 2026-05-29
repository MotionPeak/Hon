import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { SplitwiseSection } from './SplitwiseSection';
import type { Transaction } from './types';

const txn = {
  id: 't1', description: 'Dinner', amount: -100, currency: 'ILS', date: '2026-05-10',
} as unknown as Transaction;

const link = {
  transactionId: 't1', expenseId: 'e1', groupId: null, currency: 'ILS',
  owedToMe: 50, counterparties: [{ id: 2, name: 'Roomie', owed: 50 }],
  paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
};

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); });

describe('SplitwiseSection', () => {
  it('renders nothing when Splitwise is not connected', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
    });
    const { container } = render(<SplitwiseSection transaction={txn} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.txn-sidebar-section')).toBeNull();
  });

  it('offers "+ Split on Splitwise" when connected and unlinked', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [] }),
    });
    render(<SplitwiseSection transaction={txn} />);
    expect(await screen.findByRole('button', { name: /split on splitwise/i })).toBeEnabled();
  });

  it('shows owed amount + delete when the transaction is linked', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [link] }),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [link] }),
    });
    render(<SplitwiseSection transaction={txn} />);
    expect(await screen.findByText(/owed to you/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete from splitwise/i })).toBeInTheDocument();
  });
});
