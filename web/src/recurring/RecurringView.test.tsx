import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecurringView } from './RecurringView';
import { SettingsProvider } from '../settings/useSettings';
import { installFetchMock } from '../test/mockFetch';

const today = new Date();
const month = (offset = 0) => {
  const d = new Date(today.getFullYear(), today.getMonth() + offset, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const CATEGORIES = {
  categories: [
    { name: 'Housing', emoji: '🏠', color: '#5C9EF5', catGroup: 'fixed', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Utilities', emoji: '💡', color: '#F2C752', catGroup: 'fixed', sortOrder: 200, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Subscriptions', emoji: '🔁', color: '#A880ED', catGroup: 'fixed', sortOrder: 300, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Groceries', emoji: '🛒', color: '#5CC773', catGroup: 'essential', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Other', emoji: '▫️', color: '#999EB8', catGroup: 'variable', sortOrder: 999, isBuiltin: true, createdAt: '2025-01-01' },
  ],
};

const EMPTY_HELPERS = {
  'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
  'GET /api/category-splits': () => ({ splits: {}, shareAmounts: {} }),
  'GET /api/subscriptions/cancelled': () => ({ cancelled: {} }),
};

function renderView() {
  return render(<SettingsProvider><RecurringView /></SettingsProvider>);
}

describe('RecurringView — read-only', () => {
  it('shows the empty state when no recurring merchants are detected', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({ transactions: [] }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    expect(await screen.findByText(/no recurring fixed bills/i)).toBeInTheDocument();
  });

  it('detects merchants that appear in 2+ cycles under a fixed category', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent דירה', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(-1)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent דירה', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    expect(await screen.findByText(/Rent/)).toBeInTheDocument();
    // 4000/mo appears in the merchant row + section total + grand total.
    expect(screen.getAllByText(/4,?000/).length).toBeGreaterThanOrEqual(1);
  });

  it('skips merchants that appear in only one cycle without a user frequency', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(0)}-10`,
            processedDate: null, amount: -250, currency: 'ILS',
            description: 'One-off thing', memo: null, kind: null, status: null,
            category: 'Utilities', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    expect(await screen.findByText(/no recurring fixed bills/i)).toBeInTheDocument();
  });

  it('includes a single-cycle merchant when the user set a frequency on it', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(0)}-10`,
            processedDate: null, amount: -1200, currency: 'ILS',
            description: 'Insurance Premium', memo: null, kind: null, status: null,
            category: 'Utilities', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
      'GET /api/merchant-frequencies': () => ({
        // monthlyEquivalent of 1200 yearly = 100
        frequencies: { 'insurance premium': 'yearly' },
      }),
    });
    renderView();
    expect(await screen.findByText(/Insurance Premium/)).toBeInTheDocument();
    // 1200 / 12 = 100/mo — appears in per-row + section + grand total.
    expect(screen.getAllByText(/100\b/).length).toBeGreaterThanOrEqual(1);
  });

  it('excludes merchants flagged ignore', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-1)}-10`,
            processedDate: null, amount: -200, currency: 'ILS',
            description: 'Gym', memo: null, kind: null, status: null,
            category: 'Subscriptions', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(0)}-10`,
            processedDate: null, amount: -200, currency: 'ILS',
            description: 'Gym', memo: null, kind: null, status: null,
            category: 'Subscriptions', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
      'GET /api/merchant-frequencies': () => ({ frequencies: { gym: 'ignore' } }),
    });
    renderView();
    expect(await screen.findByText(/no recurring fixed bills/i)).toBeInTheDocument();
  });

  it('renders merchants grouped under their category', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(-1)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't3', accountId: 'a', externalId: 'x3', date: `${month(-2)}-10`,
            processedDate: null, amount: -350, currency: 'ILS',
            description: 'Electric', memo: null, kind: null, status: null,
            category: 'Utilities', createdAt: '2025-01-01' },
          { id: 't4', accountId: 'a', externalId: 'x4', date: `${month(-1)}-10`,
            processedDate: null, amount: -350, currency: 'ILS',
            description: 'Electric', memo: null, kind: null, status: null,
            category: 'Utilities', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    expect(await screen.findByRole('heading', { name: /housing/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /utilities/i })).toBeInTheDocument();
  });

  it('shows a grand total of all monthly-equivalent figures', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(-1)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    const strip = await screen.findByTestId('recurring-total');
    expect(within(strip).getByText(/4,?000/)).toBeInTheDocument();
  });

  it('shows a "Due this cycle" total at the full charge, not the smoothed monthly', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
      // Force bimonthly so a single charge counts and due (full) != monthly (half).
      'GET /api/merchant-frequencies': () => ({ frequencies: { rent: 'bimonthly' } }),
    });
    renderView();
    // Due this cycle = full charge (4,000); it's due (last billed 2 cycles ago).
    const due = await screen.findByTestId('recurring-due');
    expect(within(due).getByText(/4,?000/)).toBeInTheDocument();
    // Expected monthly stays the smoothed half (2,000).
    const monthly = screen.getByTestId('recurring-total');
    expect(within(monthly).getByText(/2,?000/)).toBeInTheDocument();
  });
});

const TWO_RENT = {
  'GET /api/transactions': () => ({
    transactions: [
      { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
        processedDate: null, amount: -4000, currency: 'ILS',
        description: 'Rent', memo: null, kind: null, status: null,
        category: 'Housing', createdAt: '2025-01-01' },
      { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(-1)}-15`,
        processedDate: null, amount: -4000, currency: 'ILS',
        description: 'Rent', memo: null, kind: null, status: null,
        category: 'Housing', createdAt: '2025-01-01' },
    ],
  }),
  'GET /api/categories': () => CATEGORIES,
  ...EMPTY_HELPERS,
} as const;

describe('RecurringView — Subscriptions area', () => {
  it('renders Netflix in the subs area and omits a fixed "Subscriptions" category header', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          // Two Housing charges so they're detected as recurring fixed
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(-1)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          // Netflix subscription — should appear in the subs area, not the fixed list
          { id: 't3', accountId: 'a', externalId: 'x3', date: `${month(-1)}-10`,
            processedDate: null, amount: -55, currency: 'ILS',
            description: 'Netflix', memo: null, kind: null, status: null,
            category: 'Subscriptions', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();

    const subsArea = (await screen.findByRole('heading', { name: /🔁 Subscriptions/i })).closest('section')!;
    expect(within(subsArea as HTMLElement).getByText('Netflix')).toBeInTheDocument();

    // No fixed-bills "Subscriptions" category header
    expect(screen.queryByRole('heading', { name: /^Subscriptions$/ })).not.toBeInTheDocument();
  });
});

describe('RecurringView — CRUD', () => {
  it('shows a × remove button on each row (Remove from Fixed bills)', async () => {
    installFetchMock({ ...TWO_RENT });
    renderView();
    const row = (await screen.findByText('Rent')).closest('.rec-row')!;
    expect(within(row as HTMLElement).getByRole('button', { name: /remove from fixed bills/i }))
      .toBeInTheDocument();
  });

  it('× PUTs /merchant-frequency with frequency=ignore and refetches', async () => {
    const put = vi.fn((_body: unknown) => ({ ok: true }));
    let freqCalls = 0;
    installFetchMock({
      ...TWO_RENT,
      'GET /api/merchant-frequencies': () => {
        freqCalls += 1;
        return { frequencies: {} };
      },
      'PUT /api/merchant-frequency': put,
    });
    const user = userEvent.setup();
    renderView();
    const row = (await screen.findByText('Rent')).closest('.rec-row')!;
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: /remove from fixed bills/i }),
    );
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.frequency).toBe('ignore');
    expect(typeof body.key).toBe('string');
    expect(freqCalls).toBeGreaterThan(1);
  });

  it('renders a ÷N split pill on each category section header', async () => {
    installFetchMock({
      ...TWO_RENT,
      'GET /api/category-splits': () => ({ splits: { Housing: 3 }, shareAmounts: {} }),
    });
    renderView();
    const section = (await screen.findByRole('heading', { name: /housing/i })).closest('section')!;
    const pill = within(section as HTMLElement).getByRole('button', { name: /split/i });
    expect(pill.textContent).toMatch(/÷\s*3/);
  });

  it('shows ÷1 (un-split affordance) when no override exists', async () => {
    installFetchMock({ ...TWO_RENT });
    renderView();
    const section = (await screen.findByRole('heading', { name: /housing/i })).closest('section')!;
    const pill = within(section as HTMLElement).getByRole('button', { name: /split/i });
    expect(pill.textContent).toMatch(/÷\s*1/);
  });

  it('opens a split editor dialog when the ÷N pill is clicked', async () => {
    installFetchMock({
      ...TWO_RENT,
      'GET /api/category-splits': () => ({ splits: { Housing: 3 }, shareAmounts: {} }),
    });
    const user = userEvent.setup();
    renderView();
    const section = (await screen.findByRole('heading', { name: /housing/i })).closest('section')!;
    await user.click(within(section as HTMLElement).getByRole('button', { name: /split/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/split housing/i)).toBeInTheDocument();
    const input = within(dialog).getByLabelText(/people sharing/i) as HTMLInputElement;
    expect(input.value).toBe('3');
  });

  it('saving the split dialog PUTs /category-split and refetches', async () => {
    const put = vi.fn((_body: unknown) => ({ ok: true }));
    let splitCalls = 0;
    installFetchMock({
      ...TWO_RENT,
      'GET /api/category-splits': () => {
        splitCalls += 1;
        return { splits: {}, shareAmounts: {} };
      },
      'PUT /api/category-split': put,
    });
    const user = userEvent.setup();
    renderView();
    const section = (await screen.findByRole('heading', { name: /housing/i })).closest('section')!;
    await user.click(within(section as HTMLElement).getByRole('button', { name: /split/i }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(/people sharing/i);
    await user.clear(input);
    await user.type(input, '4');
    await user.click(within(dialog).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.category).toBe('Housing');
    expect(body.splitCount).toBe(4);
    expect(splitCalls).toBeGreaterThan(1);
  });

  it('"Don\'t split" in the dialog PUTs splitCount=null', async () => {
    const put = vi.fn((_body: unknown) => ({ ok: true }));
    installFetchMock({
      ...TWO_RENT,
      'GET /api/category-splits': () => ({ splits: { Housing: 3 }, shareAmounts: {} }),
      'PUT /api/category-split': put,
    });
    const user = userEvent.setup();
    renderView();
    const section = (await screen.findByRole('heading', { name: /housing/i })).closest('section')!;
    await user.click(within(section as HTMLElement).getByRole('button', { name: /split/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /don.t split/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.category).toBe('Housing');
    expect(body.splitCount).toBeNull();
  });

  it('saves an exact share amount via PUT /category-share', async () => {
    const calls: unknown[] = [];
    installFetchMock({
      ...TWO_RENT,
      'GET /api/category-splits': () => ({ splits: {}, shareAmounts: {} }),
      'PUT /api/category-share': (body: unknown) => { calls.push(body); return { ok: true }; },
    });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByLabelText(/Split Housing/i));
    const amount = screen.getByLabelText(/my exact amount/i);
    await user.clear(amount);
    await user.type(amount, '2250');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls).toContainEqual({ category: 'Housing', shareAmount: 2250 });
  });

  it('clears an existing share when the exact-amount field is emptied', async () => {
    const calls: unknown[] = [];
    installFetchMock({
      ...TWO_RENT,
      'GET /api/category-splits': () => ({ splits: {}, shareAmounts: { Housing: 2500 } }),
      'PUT /api/category-share': (body: unknown) => { calls.push(body); return { ok: true }; },
    });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByLabelText(/Split Housing/i));
    const amount = screen.getByLabelText(/my exact amount/i);
    await user.clear(amount);                 // field had "2500", now empty
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls).toContainEqual({ category: 'Housing', shareAmount: null });
  });
});
