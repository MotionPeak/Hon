import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    { name: 'Utilities', emoji: '💡', color: '#F59F24', catGroup: 'fixed', sortOrder: 200, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Subscriptions', emoji: '🔁', color: '#5CC7CC', catGroup: 'variable', sortOrder: 600, isBuiltin: true, createdAt: '2025-01-01' },
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
  'GET /api/merchant-frequencies': () => ({ frequencies: {} as Record<string, string> }),
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
    expect(patch.mock.calls[0]?.[0]).toEqual({
      category: 'Groceries',
      applyToMerchant: false,
    });
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

describe('ActivityView — always categorize + billing frequency', () => {
  it('ticking "Always categorize" sends applyToMerchant: true on save', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ ok: true }));
    installFetchMock({
      ...FULL,
      'PATCH /api/transactions/t-1/category': patch,
    });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /Groceries/ }));
    await user.click(within(sidebar).getByRole('checkbox', {
      name: /always categorize transactions from this business this way/i,
    }));
    await user.click(within(sidebar).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[0]).toEqual({
      category: 'Groceries',
      applyToMerchant: true,
    });
  });

  it('ticking "Always categorize" enables Save even without a category change', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    const saveBtn = within(sidebar).getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();
    await user.click(within(sidebar).getByRole('checkbox', {
      name: /always categorize/i,
    }));
    expect(saveBtn).toBeEnabled();
  });

  it('billing-frequency toggle is hidden for variable-group categories', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    // Coffee is variable group — no billing frequency.
    expect(within(sidebar).queryByText(/billing frequency/i)).not.toBeInTheDocument();
  });

  it('shows Monthly/Bimonthly toggle when a fixed-group category is picked', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /Utilities/ }));
    expect(within(sidebar).getByText(/billing frequency/i)).toBeInTheDocument();
    const group = within(sidebar).getByRole('radiogroup', { name: /billing frequency/i });
    expect(within(group).getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'Bimonthly' })).toHaveAttribute('aria-checked', 'false');
    // Subscriptions case: monthly|yearly.
    await user.click(within(sidebar).getByRole('button', { name: /Subscriptions/ }));
    const group2 = within(sidebar).getByRole('radiogroup', { name: /billing frequency/i });
    expect(within(group2).getByRole('radio', { name: 'Yearly' })).toBeInTheDocument();
    expect(within(group2).queryByRole('radio', { name: 'Bimonthly' })).not.toBeInTheDocument();
  });

  it('switching to Bimonthly PUTs /merchant-frequency on save', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ ok: true }));
    const put = vi.fn((_body: unknown) => ({ ok: true }));
    installFetchMock({
      ...FULL,
      'PATCH /api/transactions/t-1/category': patch,
      'PUT /api/merchant-frequency': put,
    });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /Utilities/ }));
    await user.click(within(sidebar).getByRole('radio', { name: 'Bimonthly' }));
    await user.click(within(sidebar).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]?.[0]).toEqual({
      key: 'aroma coffee', frequency: 'bimonthly',
    });
  });

  it('seeds the toggle from the stored merchant frequency', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...FULL,
      'GET /api/merchant-frequencies': () => ({
        frequencies: { 'aroma coffee': 'bimonthly' },
      }),
    });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /Utilities/ }));
    const group = within(sidebar).getByRole('radiogroup', { name: /billing frequency/i });
    expect(within(group).getByRole('radio', { name: 'Bimonthly' })).toHaveAttribute('aria-checked', 'true');
  });

  it('does not call /merchant-frequency when the picked category has no recurrence', async () => {
    const user = userEvent.setup();
    const put = vi.fn(() => ({ ok: true }));
    installFetchMock({
      ...FULL,
      'PATCH /api/transactions/t-1/category': () => ({ ok: true }),
      'PUT /api/merchant-frequency': put,
    });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /Groceries/ }));
    await user.click(within(sidebar).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /move to category/i })).not.toBeInTheDocument());
    expect(put).not.toHaveBeenCalled();
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

const REFUND_TXNS = {
  transactions: [
    ...TXNS.transactions,
    {
      // Refund candidate — positive amount this month.
      id: 't-r1', accountId: 'a-1', externalId: 'xr1',
      date: `${thisMonth}-10`, processedDate: null, amount: 250,
      currency: 'ILS', description: 'Shufersal — returned items', memo: null,
      kind: null, status: null, category: 'Other', createdAt: `${thisMonth}-10`,
    },
  ],
};
const FULL_REFUND = {
  ...FULL,
  'GET /api/transactions': () => REFUND_TXNS,
};

describe('ActivityView — refund linking', () => {
  it('shows "+ Link a refund or reimbursement" in the sidebar (not a stub)', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL_REFUND);
    renderView();
    await user.click(await screen.findByText('Shufersal'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    const btn = within(sidebar).getByRole('button', { name: /link a refund/i });
    expect(btn).not.toBeDisabled();
  });

  it('clicking + Link opens a refund picker listing positive-amount candidates', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL_REFUND);
    renderView();
    await user.click(await screen.findByText('Shufersal'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /link a refund/i }));
    // Picker takes over: category tiles + Splitwise section are gone, Back is here.
    expect(within(sidebar).queryByRole('button', { name: /groceries/i }))
      .not.toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: /^‹ back$/i }))
      .toBeInTheDocument();
    // Refund candidate is now visible.
    expect(await within(sidebar).findByRole('button', {
      name: /shufersal — returned items/i,
    })).toBeInTheDocument();
    // The expense itself is not a candidate either.
    const candidates = within(sidebar).getAllByRole('button', { name: /shufersal/i });
    expect(candidates.some((c) =>
      c.getAttribute('aria-label') === 'Shufersal' || c.textContent === 'Shufersal',
    )).toBe(false);
  });

  it('picking a candidate PUTs /transactions/:id/link and refetches', async () => {
    const user = userEvent.setup();
    const put = vi.fn((_body: unknown) => ({ ok: true, amount: 250 }));
    const get = vi.fn(() => REFUND_TXNS);
    installFetchMock({
      ...FULL_REFUND,
      'GET /api/transactions': get,
      'PUT /api/transactions/t-2/link': put,
    });
    renderView();
    await user.click(await screen.findByText('Shufersal'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /link a refund/i }));
    await user.click(await within(sidebar).findByRole('button', {
      name: /shufersal — returned items/i,
    }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]?.[0]).toEqual({ refundId: 't-r1' });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('an already-linked expense shows the linked-refund summary + unlink', async () => {
    const linkedTxns = {
      transactions: REFUND_TXNS.transactions.map((t) =>
        t.id === 't-2' ? { ...t, refundId: 't-r1' } : t,
      ),
    };
    const user = userEvent.setup();
    installFetchMock({
      ...FULL_REFUND,
      'GET /api/transactions': () => linkedTxns,
    });
    renderView();
    await user.click(await screen.findByText('Shufersal'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    // Summary mentions the linked refund.
    expect(within(sidebar).getByText(/shufersal — returned items/i)).toBeInTheDocument();
    // Unlink button is present.
    expect(within(sidebar).getByRole('button', { name: /unlink/i })).toBeInTheDocument();
  });

  it('opening a positive-amount transaction (a refund) flips the picker to expense candidates', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL_REFUND);
    renderView();
    // Click the refund row itself (t-r1, "Shufersal — returned items", +250)
    await user.click(await screen.findByText('Shufersal — returned items'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    // The link CTA reads differently for a refund.
    const link = within(sidebar).getByRole('button', {
      name: /link to an expense/i,
    });
    await user.click(link);
    // The picker now lists NEGATIVE-amount transactions; positives are out.
    expect(await within(sidebar).findByRole('button', { name: /shufersal$/i }))
      .toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: /aroma coffee/i }))
      .toBeInTheDocument();
    // The refund itself is not a candidate.
    expect(within(sidebar).queryByRole('button', {
      name: /shufersal — returned items/i,
    })).not.toBeInTheDocument();
    // Salary (+12000) is positive, so not a candidate either.
    expect(within(sidebar).queryByRole('button', { name: /pay cheque/i }))
      .not.toBeInTheDocument();
  });

  it('picking an expense from a refund flips the API: PUT targets the EXPENSE id with refundId=open refund', async () => {
    const user = userEvent.setup();
    const put = vi.fn((_body: unknown) => ({ ok: true, amount: 250 }));
    installFetchMock({
      ...FULL_REFUND,
      // The refund t-r1 was opened; the user picks expense t-2 (Shufersal).
      // The API call goes to the EXPENSE's id with the REFUND id in the body.
      'PUT /api/transactions/t-2/link': put,
    });
    renderView();
    await user.click(await screen.findByText('Shufersal — returned items'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', {
      name: /link to an expense/i,
    }));
    await user.click(await within(sidebar).findByRole('button', { name: /shufersal$/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]?.[0]).toEqual({ refundId: 't-r1' });
  });

  it('shows a Select button in the activity head', async () => {
    installFetchMock(FULL_REFUND);
    renderView();
    expect(await screen.findByRole('button', { name: /^select$/i })).toBeInTheDocument();
  });

  it('clicking Select reveals a batch toolbar and flips Select to Cancel', async () => {
    installFetchMock(FULL_REFUND);
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /^select$/i }));
    expect(screen.getByTestId('batch-bar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument();
  });

  it('picking a category in the bulk dialog PATCHes every selected txn and exits batch mode', async () => {
    const user = userEvent.setup();
    const patchT1 = vi.fn((_body: unknown) => ({ ok: true }));
    const patchT2 = vi.fn((_body: unknown) => ({ ok: true }));
    const get = vi.fn(() => REFUND_TXNS);
    installFetchMock({
      ...FULL_REFUND,
      'GET /api/transactions': get,
      'PATCH /api/transactions/t-1/category': patchT1,
      'PATCH /api/transactions/t-2/category': patchT2,
    });
    renderView();
    await user.click(await screen.findByRole('button', { name: /^select$/i }));
    await user.click(screen.getByText('Aroma Coffee')); // t-1
    await user.click(screen.getByText('Shufersal'));     // t-2
    await user.click(screen.getByRole('button', { name: /^move to category/i }));
    const dialog = await screen.findByRole('dialog', { name: /move .* to category/i });
    await user.click(within(dialog).getByText('Groceries'));
    await waitFor(() => expect(patchT1).toHaveBeenCalled());
    await waitFor(() => expect(patchT2).toHaveBeenCalled());
    expect(patchT1.mock.calls[0]?.[0]).toEqual({ category: 'Groceries' });
    expect(patchT2.mock.calls[0]?.[0]).toEqual({ category: 'Groceries' });
    // Refreshed and exited batch mode.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('batch-bar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^select$/i })).toBeInTheDocument();
  });

  it('clicking Move-to-category opens a bulk-move dialog with category tiles', async () => {
    installFetchMock(FULL_REFUND);
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /^select$/i }));
    await user.click(screen.getByText('Aroma Coffee'));
    await user.click(screen.getByRole('button', { name: /^move to category/i }));
    const dialog = await screen.findByRole('dialog', { name: /move .* to category/i });
    expect(within(dialog).getByText(/^Groceries$/)).toBeInTheDocument();
    // Header reflects how many are being moved.
    expect(within(dialog).getByText(/1 transaction/i)).toBeInTheDocument();
  });

  it('the batch toolbar has a Move-to-category button (disabled until something is selected)', async () => {
    installFetchMock(FULL_REFUND);
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /^select$/i }));
    const moveBtn = screen.getByRole('button', { name: /^move to category/i });
    expect(moveBtn).toBeDisabled();
    await user.click(screen.getByText('Aroma Coffee'));
    expect(screen.getByRole('button', { name: /^move to category/i })).toBeEnabled();
  });

  it('a selected row carries a .selected class', async () => {
    installFetchMock(FULL_REFUND);
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /^select$/i }));
    const row = screen.getByText('Aroma Coffee').closest('.txn')!;
    expect(row.className).not.toMatch(/selected/);
    await user.click(row as HTMLElement);
    expect(row.className).toMatch(/selected/);
  });

  it('clicking a transaction in batch mode toggles selection (no sidebar)', async () => {
    installFetchMock(FULL_REFUND);
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /^select$/i }));
    await user.click(screen.getByText('Aroma Coffee'));
    // Sidebar must NOT open.
    expect(screen.queryByRole('dialog', { name: /move to category/i }))
      .not.toBeInTheDocument();
    // Toolbar shows 1 selected.
    expect(within(screen.getByTestId('batch-bar')).getByText(/1 selected/i))
      .toBeInTheDocument();
    // Click again to deselect.
    await user.click(screen.getByText('Aroma Coffee'));
    expect(within(screen.getByTestId('batch-bar')).getByText(/tap rows to select/i))
      .toBeInTheDocument();
  });

  it('Unlink DELETEs /transactions/:id/link and refetches', async () => {
    const linkedTxns = {
      transactions: REFUND_TXNS.transactions.map((t) =>
        t.id === 't-2' ? { ...t, refundId: 't-r1' } : t,
      ),
    };
    const user = userEvent.setup();
    const del = vi.fn(() => ({ ok: true }));
    const get = vi.fn(() => linkedTxns);
    installFetchMock({
      ...FULL_REFUND,
      'GET /api/transactions': get,
      'DELETE /api/transactions/t-2/link': del,
    });
    renderView();
    await user.click(await screen.findByText('Shufersal'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /unlink/i }));
    await waitFor(() => expect(del).toHaveBeenCalled());
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

describe('ActivityView — exclude from cycle', () => {
  beforeEach(() => {
    localStorage.setItem('honSettings', JSON.stringify({
      hideCardTotals: true, cardProviders: ['מקס'],
    }));
  });

  const txnsWithCardBill = {
    transactions: [
      TXNS.transactions[0]!, // Aroma Coffee
      {
        id: 't-card', accountId: 'a-1', externalId: 'xc',
        date: `${thisMonth}-10`, processedDate: null, amount: -2500,
        currency: 'ILS', description: 'מקס איט פיננסים', memo: null,
        kind: null, status: null, category: null, createdAt: '2026-05-10',
      },
    ],
  };

  it('rule-matched rows render under the "Excluded from cycle" section, not the main grouping', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/transactions': () => txnsWithCardBill });
    renderView();
    // The card-bill row exists, but it's collapsed inside the Excluded section.
    expect(await screen.findByText(/excluded from cycle \(1\)/i)).toBeInTheDocument();
    expect(screen.queryByText('מקס איט פיננסים')).not.toBeInTheDocument();
    // Aroma Coffee (variable) still renders normally.
    expect(screen.getByText('Aroma Coffee')).toBeInTheDocument();
    // Expand the section and the card-bill row appears.
    await user.click(screen.getByRole('button', { name: /excluded from cycle/i }));
    expect(await screen.findByText('מקס איט פיננסים')).toBeInTheDocument();
  });

  it('manually excluding a row PATCHes /excluded with true and moves it to the section', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_b: unknown) => ({ ok: true }));
    let calls = 0;
    installFetchMock({
      ...FULL,
      'GET /api/transactions': () => {
        calls += 1;
        if (calls === 1) return TXNS;
        return { transactions: [{ ...TXNS.transactions[0]!, excludedManual: true }] };
      },
      'PATCH /api/transactions/t-1/excluded': patch,
    });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    const toggle = within(sidebar).getByRole('checkbox', {
      name: /exclude from cycle calculations/i,
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]?.[0]).toEqual({ excluded: true });
  });

  it('re-including a rule-matched row PATCHes /excluded with false (the manual override)', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_b: unknown) => ({ ok: true }));
    installFetchMock({
      ...FULL,
      'GET /api/transactions': () => txnsWithCardBill,
      'PATCH /api/transactions/t-card/excluded': patch,
    });
    renderView();
    await user.click(await screen.findByRole('button', { name: /excluded from cycle/i }));
    await user.click(await screen.findByText('מקס איט פיננסים'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    const toggle = within(sidebar).getByRole('checkbox', {
      name: /exclude from cycle calculations/i,
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]?.[0]).toEqual({ excluded: false });
  });

  it('explicit excludedManual=false overrides the rule and keeps the row in the main grouping', async () => {
    installFetchMock({
      ...FULL,
      'GET /api/transactions': () => ({
        transactions: [
          { ...TXNS.transactions[0]!, description: 'מקס איט פיננסים', excludedManual: false, category: 'Coffee' },
        ],
      }),
    });
    renderView();
    expect(await screen.findByText('מקס איט פיננסים')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /excluded from cycle/i })).not.toBeInTheDocument();
  });
});
