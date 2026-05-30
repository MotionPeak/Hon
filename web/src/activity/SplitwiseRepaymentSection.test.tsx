import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { SplitwiseRepaymentSection } from './SplitwiseRepaymentSection';
import type { Transaction } from './types';

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); });

const incoming: Transaction = {
  id: 'r1', accountId: 'a', externalId: 'x', date: '2026-05-10', processedDate: null,
  amount: 60, currency: 'ILS', description: 'Bit from roomie', memo: null, kind: null,
  status: null, category: null, createdAt: '2026-05-10',
};
const outgoing: Transaction = { ...incoming, id: 'o1', amount: -60 };

function connected() {
  installFetchMock({
    'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
    'GET /api/splitwise/links': () => ({ links: [], repayments: [] }),
    'POST /api/splitwise/refresh': () => ({ friends: [], links: [] }),
    'GET /api/splitwise/groups': () => ({ friends: [{ id: 2, name: 'Roomie' }], groups: [], me: { id: 1, name: 'Me' } }),
    'POST /api/splitwise/repayment': () => ({
      links: [], repayments: [{ transactionId: 'r1', counterpartyId: 2, counterpartyName: 'Roomie', currency: 'ILS', amount: 60, createdAt: '2026-05-10' }],
    }),
  });
}

describe('SplitwiseRepaymentSection', () => {
  it('renders nothing for an outgoing transaction', async () => {
    connected();
    const { container } = render(<SplitwiseRepaymentSection transaction={outgoing} />);
    await waitFor(() => expect(screen.queryByText(/repayment/i)).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it('lets the user mark an incoming transaction as a repayment', async () => {
    const user = userEvent.setup();
    connected();
    render(<SplitwiseRepaymentSection transaction={incoming} />);
    await user.click(await screen.findByRole('button', { name: /mark as splitwise repayment/i }));
    await user.click(await screen.findByRole('button', { name: 'Roomie' }));
    expect(await screen.findByText(/Repayment from Roomie/i)).toBeInTheDocument();
  });
});
