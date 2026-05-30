import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { OwedToYouCard } from './OwedToYouCard';

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); });

describe('OwedToYouCard', () => {
  it('renders nothing when not connected', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
    });
    const { container } = render(<OwedToYouCard />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.card')).toBeNull();
  });

  it('lists friends with positive balances from links', async () => {
    const link = {
      transactionId: 'e2', expenseId: 'x2', groupId: null, currency: 'ILS',
      owedToMe: 50, counterparties: [{ id: 10, name: 'Roomie', owed: 50, paid: 0 }],
      paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
    };
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [link] }),
      'POST /api/splitwise/refresh': () => ({ links: [link], friends: [
        { name: 'Owes nothing', balances: [{ amount: -10, currency: 'ILS' }] },
      ] }),
    });
    render(<OwedToYouCard />);
    expect(await screen.findByText('Roomie')).toBeInTheDocument();
    expect(screen.queryByText('Owes nothing')).toBeNull();
  });

  it('shows per-friend owed from links even when Splitwise reports settled', async () => {
    const link = {
      transactionId: 'e1', expenseId: 'x1', groupId: null, currency: 'ILS',
      owedToMe: 60, counterparties: [{ id: 2, name: 'Roomie', owed: 60, paid: 0 }],
      paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
    };
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [link], repayments: [] }),
      // Splitwise says the friend settled (no balance) — the card must ignore this.
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [link] }),
    });
    render(<OwedToYouCard />);
    expect(await screen.findByText('Roomie')).toBeInTheDocument();
    expect(screen.getByText(/₪60/)).toBeInTheDocument();
  });
});
