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

  it('lists friends with positive balances', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/refresh': () => ({ links: [], friends: [
        { name: 'Roomie', balances: [{ amount: 50, currency: 'ILS' }] },
        { name: 'Owes nothing', balances: [{ amount: -10, currency: 'ILS' }] },
      ] }),
    });
    render(<OwedToYouCard />);
    expect(await screen.findByText('Roomie')).toBeInTheDocument();
    expect(screen.queryByText('Owes nothing')).toBeNull();
  });
});
