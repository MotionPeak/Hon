import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityView } from './ActivityView';
import { SettingsProvider } from '../settings/useSettings';
import { installFetchMock } from '../test/mockFetch';

const CATEGORIES = {
  categories: [
    { name: 'Groceries', emoji: '🛒', color: '#5CC773', catGroup: 'essential', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Coffee', emoji: '☕', color: '#A880ED', catGroup: 'variable', sortOrder: 500, isBuiltin: false, createdAt: '2025-02-02' },
    { name: 'Salary', emoji: '💰', color: '#5CC773', catGroup: 'income', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Other', emoji: '▫️', color: '#999EB8', catGroup: 'variable', sortOrder: 999, isBuiltin: true, createdAt: '2025-01-01' },
  ],
};

const ACCOUNTS = {
  accounts: [
    { id: 'a-1', connectionId: 'c-1', companyId: 'hapoalim',
      connectionName: 'Hapoalim', accountNumber: '12345', label: 'Checking',
      balance: 10000, currency: 'ILS', updatedAt: '2026-05-01',
      excluded: false, inceptionDate: null },
  ],
};

const today = new Date();
const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 15);
const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

const TXNS = {
  transactions: [
    {
      id: 't-1', accountId: 'a-1', externalId: 'x1',
      date: `${thisMonth}-05`, processedDate: null, amount: -45.5,
      currency: 'ILS', description: 'Aroma Coffee', memo: null,
      kind: null, status: null, category: 'Coffee', createdAt: '2026-05-05',
    },
    {
      id: 't-2', accountId: 'a-1', externalId: 'x2',
      date: `${thisMonth}-08`, processedDate: null, amount: -250,
      currency: 'ILS', description: 'Shufersal', memo: null,
      kind: null, status: null, category: 'Groceries', createdAt: '2026-05-08',
    },
    {
      id: 't-3', accountId: 'a-1', externalId: 'x3',
      date: `${thisMonth}-01`, processedDate: null, amount: 12000,
      currency: 'ILS', description: 'Pay Cheque', memo: null,
      kind: null, status: null, category: 'Salary', createdAt: '2026-05-01',
    },
    {
      id: 't-4', accountId: 'a-1', externalId: 'x4',
      date: `${lastMonth}-15`, processedDate: null, amount: -30,
      currency: 'ILS', description: 'Old purchase', memo: null,
      kind: null, status: null, category: 'Other', createdAt: `${lastMonth}-15`,
    },
  ],
};

const FULL = {
  'GET /api/transactions': () => TXNS,
  'GET /api/accounts': () => ACCOUNTS,
  'GET /api/categories': () => CATEGORIES,
};

function renderView() {
  return render(<SettingsProvider><ActivityView /></SettingsProvider>);
}

describe('ActivityView — read-only', () => {
  it('shows the empty state when no transactions exist', async () => {
    installFetchMock({
      ...FULL,
      'GET /api/transactions': () => ({ transactions: [] }),
    });
    renderView();
    expect(await screen.findByText(/no transactions yet/i)).toBeInTheDocument();
  });

  it('renders this-month transactions grouped under their category', async () => {
    installFetchMock(FULL);
    renderView();
    expect(await screen.findByRole('heading', { name: /salary/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /groceries/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /coffee/i })).toBeInTheDocument();
    // Salary row exists.
    expect(screen.getByText('Pay Cheque')).toBeInTheDocument();
  });

  it('shows the current month label in the picker', async () => {
    installFetchMock(FULL);
    renderView();
    const labelText = new Date(today.getFullYear(), today.getMonth(), 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    expect(await screen.findByText(labelText)).toBeInTheDocument();
  });

  it('hides transactions from other months', async () => {
    installFetchMock(FULL);
    renderView();
    await screen.findByText('Pay Cheque');
    expect(screen.queryByText('Old purchase')).not.toBeInTheDocument();
  });

  it('clicking previous shows last month transactions', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await screen.findByText('Pay Cheque');
    await user.click(screen.getByRole('button', { name: /previous month/i }));
    expect(await screen.findByText('Old purchase')).toBeInTheDocument();
    expect(screen.queryByText('Pay Cheque')).not.toBeInTheDocument();
  });

  it('shows transaction date + account label + signed amount', async () => {
    installFetchMock(FULL);
    renderView();
    const row = (await screen.findByText('Aroma Coffee')).closest('.txn')!;
    // Account label.
    expect(within(row as HTMLElement).getByText(/Checking/)).toBeInTheDocument();
    // Negative amount renders.
    expect(within(row as HTMLElement).getByText(/45\.50?/)).toBeInTheDocument();
  });

  it('categorises rows under "Other" when a transaction has no category', async () => {
    installFetchMock({
      ...FULL,
      'GET /api/transactions': () => ({
        transactions: [{
          ...TXNS.transactions[0],
          id: 't-uncat', description: 'Mystery purchase',
          category: null,
        }],
      }),
    });
    renderView();
    expect(await screen.findByText('Mystery purchase')).toBeInTheDocument();
    // Falls under "Other".
    expect(screen.getByRole('heading', { name: /other/i })).toBeInTheDocument();
  });
});

describe('ActivityView — category move', () => {
  it('clicking a row opens a sidebar showing all categories', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    expect(within(sidebar).getByRole('button', { name: /Groceries/ })).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: /Coffee/ })).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: /Salary/ })).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: /Other/ })).toBeInTheDocument();
  });

  it('marks the current category as selected in the sidebar', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    expect(within(sidebar).getByRole('button', { name: /Coffee/ }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(within(sidebar).getByRole('button', { name: /Groceries/ }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('picking a category then clicking Save PATCHes and refetches', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ ok: true }));
    const get = vi.fn(() => TXNS);
    installFetchMock({
      ...FULL,
      'GET /api/transactions': get,
      'PATCH /api/transactions/t-1/category': patch,
    });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /Groceries/ }));
    // No network call yet — tile click is selection only.
    expect(patch).not.toHaveBeenCalled();
    await user.click(within(sidebar).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[0]).toEqual({ category: 'Groceries' });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: /move to category/i })).not.toBeInTheDocument();
  });

  it('Save is disabled when the selected category equals the current one', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    // Aroma Coffee is already in "Coffee" — Save should be disabled until
    // the user picks a different tile.
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    expect(within(sidebar).getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('close (X) closes the sidebar without calling the engine', async () => {
    const user = userEvent.setup();
    const patch = vi.fn();
    installFetchMock({ ...FULL, 'PATCH /api/transactions/t-1/category': patch });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /^close$/i }));
    expect(screen.queryByRole('dialog', { name: /move to category/i })).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('ActivityView — search', () => {
  it('renders a search input in the header', async () => {
    installFetchMock(FULL);
    renderView();
    expect(await screen.findByPlaceholderText(/search transactions/i)).toBeInTheDocument();
  });

  it('typing a query switches to a cross-month flat list', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await screen.findByText('Pay Cheque');
    expect(screen.queryByText('Old purchase')).not.toBeInTheDocument(); // hidden by month picker
    await user.type(screen.getByPlaceholderText(/search transactions/i), 'purchase');
    expect(await screen.findByText('Old purchase')).toBeInTheDocument();
    // Category group headings should NOT render in search mode.
    expect(screen.queryByRole('heading', { name: /salary/i })).not.toBeInTheDocument();
  });

  it('search matches descriptions case-insensitively', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await screen.findByText('Pay Cheque');
    await user.type(screen.getByPlaceholderText(/search transactions/i), 'AROMA');
    expect(await screen.findByText('Aroma Coffee')).toBeInTheDocument();
    expect(screen.queryByText('Shufersal')).not.toBeInTheDocument();
  });

  it('search matches the account label', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await screen.findByText('Pay Cheque');
    await user.type(screen.getByPlaceholderText(/search transactions/i), 'checking');
    // "Checking" matches the account label → every row shows up.
    expect(await screen.findByText('Aroma Coffee')).toBeInTheDocument();
    expect(screen.getByText('Shufersal')).toBeInTheDocument();
  });

  it('search matches a numeric amount', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await screen.findByText('Pay Cheque');
    await user.type(screen.getByPlaceholderText(/search transactions/i), '250');
    expect(await screen.findByText('Shufersal')).toBeInTheDocument();
    expect(screen.queryByText('Aroma Coffee')).not.toBeInTheDocument();
  });

  it('shows a no-matches message when the query matches nothing', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await screen.findByText('Pay Cheque');
    await user.type(screen.getByPlaceholderText(/search transactions/i), 'qqqqqq');
    expect(await screen.findByText(/no matching transactions/i)).toBeInTheDocument();
  });

  it('clearing the search returns to grouped month view', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    const input = await screen.findByPlaceholderText(/search transactions/i);
    await user.type(input, 'aroma');
    await screen.findByText('Aroma Coffee');
    await user.clear(input);
    // Month picker label is back.
    expect(await screen.findByRole('heading', { name: /salary/i })).toBeInTheDocument();
  });
});

