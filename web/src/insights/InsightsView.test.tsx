import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InsightsView } from './InsightsView';
import { SettingsProvider } from '../settings/useSettings';
import { installFetchMock } from '../test/mockFetch';

const today = new Date();
const month = (offset = 0) => {
  const d = new Date(today.getFullYear(), today.getMonth() + offset, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const CATEGORIES = {
  categories: [
    { name: 'Groceries', emoji: '🛒', color: '#5CC773', catGroup: 'essential', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Dining', emoji: '🍽️', color: '#F59942', catGroup: 'essential', sortOrder: 110, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Salary', emoji: '💰', color: '#5CC773', catGroup: 'income', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Other', emoji: '▫️', color: '#999EB8', catGroup: 'variable', sortOrder: 999, isBuiltin: true, createdAt: '2025-01-01' },
  ],
};

function tx(over: Partial<{ id: string; date: string; amount: number; description: string; category: string }>) {
  return {
    id: over.id ?? 't', accountId: 'a', externalId: 'x',
    date: over.date ?? `${month(0)}-15`, processedDate: null,
    amount: over.amount ?? -100, currency: 'ILS',
    description: over.description ?? 'Shop', memo: null,
    kind: null, status: null,
    category: over.category ?? 'Groceries', createdAt: '2025-01-01',
  };
}

function renderView() {
  return render(<SettingsProvider><InsightsView /></SettingsProvider>);
}

describe('InsightsView — Spending sub-tab', () => {
  it('shows the empty state when there is no spending or income', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({ transactions: [] }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    expect(await screen.findByText(/no analytics yet/i)).toBeInTheDocument();
  });

  it('renders 12 month bars + a "Spending" chart label', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [tx({ id: 't1', amount: -250 })],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    expect(await screen.findByText(/^Spending$/)).toBeInTheDocument();
    const bars = screen.getAllByRole('button', { name: /spending|no spending/i });
    expect(bars.length).toBe(12);
  });

  it('selects the current month by default and shows its breakdown', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 't1', amount: -250, category: 'Groceries', date: `${month(0)}-10` }),
          tx({ id: 't2', amount: -120, category: 'Dining', date: `${month(0)}-15` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    // Month detail header should show this month.
    const monthLabel = new Date(today.getFullYear(), today.getMonth(), 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    expect(await screen.findByRole('heading', { name: new RegExp(monthLabel, 'i') }))
      .toBeInTheDocument();
    // Category rows.
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
  });

  it('clicking a bar selects that month and the breakdown updates', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 't1', amount: -250, category: 'Groceries', date: `${month(0)}-10` }),
          tx({ id: 't2', amount: -1000, category: 'Dining', date: `${month(-2)}-10` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    await screen.findByText('Groceries');
    // Find the bar for month(-2) by its data-month attribute.
    const targetKey = month(-2);
    const bar = document.querySelector(`[data-month="${targetKey}"]`) as HTMLElement | null;
    expect(bar).not.toBeNull();
    await user.click(bar!);
    expect(await screen.findByText('Dining')).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  it('shows a "spent" total at the top of the month detail card', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 't1', amount: -250, category: 'Groceries', date: `${month(0)}-10` }),
          tx({ id: 't2', amount: -120, category: 'Dining', date: `${month(0)}-15` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    const detail = await screen.findByTestId('month-detail');
    expect(within(detail).getByText(/370/)).toBeInTheDocument();
  });
});

const EMPTY_TXNS = {
  'GET /api/transactions': () => ({ transactions: [] }),
  'GET /api/categories': () => CATEGORIES,
};
const EMPTY_BROKERAGE = {
  'GET /api/brokerage': () => ({
    holdings: [], snapshots: [], holdingSnapshots: [],
    performance: [], ilsRates: { USD: 3.7, EUR: 4.05 },
  }),
};

describe('InsightsView — Brokerage sub-tab', () => {
  it('renders a tabs strip with Spending and Brokerage', async () => {
    installFetchMock({ ...EMPTY_TXNS, ...EMPTY_BROKERAGE });
    renderView();
    expect(await screen.findByRole('tab', { name: /spending/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /brokerage/i })).toBeInTheDocument();
  });

  it('clicking Brokerage shows an empty state when there are no holdings', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...EMPTY_TXNS, ...EMPTY_BROKERAGE });
    renderView();
    await user.click(await screen.findByRole('tab', { name: /brokerage/i }));
    expect(await screen.findByText(/no brokerage data/i)).toBeInTheDocument();
  });

  it('Brokerage shows a value-over-time chart when snapshots exist', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...EMPTY_TXNS,
      'GET /api/brokerage': () => ({
        holdings: [],
        snapshots: [
          { accountId: 'b1', date: '2026-01-15', value: 100000, currency: 'ILS' },
          { accountId: 'b1', date: '2026-02-15', value: 102000, currency: 'ILS' },
          { accountId: 'b1', date: '2026-03-15', value: 99000, currency: 'ILS' },
        ],
        holdingSnapshots: [],
        performance: [],
        ilsRates: { USD: 3.7 },
      }),
    });
    renderView();
    await user.click(await screen.findByRole('tab', { name: /brokerage/i }));
    const chart = await screen.findByTestId('brokerage-chart');
    expect(chart).toBeInTheDocument();
    // The line should have one point per snapshot (3 in this case).
    const points = chart.querySelectorAll('circle');
    expect(points.length).toBe(3);
  });

  it('Brokerage shows a holdings list with symbol + units + value', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...EMPTY_TXNS,
      'GET /api/brokerage': () => ({
        holdings: [
          {
            accountId: 'b1', symbol: 'AAPL', description: 'Apple Inc.',
            units: 10, price: 200, currency: 'USD',
            costBasis: 1500, openPnl: 500, value: 2000,
            updatedAt: '2026-05-25',
          },
          {
            accountId: 'b1', symbol: 'VOO', description: 'S&P 500 ETF',
            units: 5, price: 480, currency: 'USD',
            costBasis: 2000, openPnl: 400, value: 2400,
            updatedAt: '2026-05-25',
          },
        ],
        snapshots: [],
        holdingSnapshots: [],
        performance: [],
        ilsRates: { USD: 3.7 },
      }),
    });
    renderView();
    await user.click(await screen.findByRole('tab', { name: /brokerage/i }));
    const list = await screen.findByTestId('brokerage-holdings');
    expect(within(list).getByText('AAPL')).toBeInTheDocument();
    expect(within(list).getByText('VOO')).toBeInTheDocument();
    expect(within(list).getByText(/Apple Inc/)).toBeInTheDocument();
    // 10 units.
    expect(within(list).getByText(/10 units/i)).toBeInTheDocument();
  });
});
