import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
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

  it('shows a Spent stat tile totalling the month\'s expenses', async () => {
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
    const spentTile = within(detail).getAllByTestId('md-tile')[0]!;
    expect(within(spentTile).getByText(/Spent/i)).toBeInTheDocument();
    expect(within(spentTile).getByText(/370/)).toBeInTheDocument();
  });

  it('the month detail card has 4 stat tiles: Spent / Income / Saved or Overspent / Transactions', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 't1', amount: -250, category: 'Groceries', date: `${month(0)}-10` }),
          tx({ id: 't2', amount: 5000, category: 'Salary', date: `${month(0)}-01` }),
          tx({ id: 't3', amount: -1000, category: 'Dining', date: `${month(0)}-15` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    const detail = await screen.findByTestId('month-detail');
    const tiles = within(detail).getAllByTestId('md-tile');
    expect(tiles).toHaveLength(4);
    // Spent
    expect(within(tiles[0]!).getByText(/Spent/i)).toBeInTheDocument();
    expect(within(tiles[0]!).getByText(/1,?250/)).toBeInTheDocument();
    // Income
    expect(within(tiles[1]!).getByText(/Income/i)).toBeInTheDocument();
    expect(within(tiles[1]!).getByText(/5,?000/)).toBeInTheDocument();
    // Saved (net positive)
    expect(within(tiles[2]!).getByText(/Saved/i)).toBeInTheDocument();
    expect(within(tiles[2]!).getByText(/3,?750/)).toBeInTheDocument();
    // Transactions count
    expect(within(tiles[3]!).getByText(/Transactions?/i)).toBeInTheDocument();
    expect(within(tiles[3]!).getByText(/^3$/)).toBeInTheDocument();
  });

  it('shows vs-previous-month and vs-avg trend pills on the detail header', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          // Two months back: 2000 spent.
          tx({ id: 'pa', amount: -2000, category: 'Groceries', date: `${month(-2)}-10` }),
          // Last month: 1000 spent.
          tx({ id: 'pb', amount: -1000, category: 'Groceries', date: `${month(-1)}-10` }),
          // This month: 500 spent (50% less than 1000 → ↓50% vs last).
          tx({ id: 'pc', amount: -500, category: 'Groceries', date: `${month(0)}-10` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    const detail = await screen.findByTestId('month-detail');
    // ↓ 50% vs last month — the trend pill (not the per-category chip).
    expect(within(detail).getByText(/↓\s*50%/)).toBeInTheDocument();
    // "vs avg" labels appear both on the header trend pill and on each
    // category's delta chip — at least one exists.
    expect(within(detail).getAllByText(/vs avg/i).length).toBeGreaterThan(0);
  });

  it('renders a "Where it went" label and per-category delta chips vs last + vs avg', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          // Last month: Groceries 600.
          tx({ id: 'p1', amount: -600, category: 'Groceries', date: `${month(-1)}-10` }),
          // Two months back: Groceries 400.
          tx({ id: 'p2', amount: -400, category: 'Groceries', date: `${month(-2)}-10` }),
          // This month: Groceries 200 (↓400 vs last 600).
          tx({ id: 'p3', amount: -200, category: 'Groceries', date: `${month(0)}-10` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    const detail = await screen.findByTestId('month-detail');
    expect(within(detail).getByText(/where it went/i)).toBeInTheDocument();
    // Delta chips for Groceries.
    expect(within(detail).getByText(/vs last/i)).toBeInTheDocument();
    expect(within(detail).getAllByText(/vs avg/i).length).toBeGreaterThan(0);
  });

  it('shows a Biggest expense card pointing at the largest single charge', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 'b1', amount: -250, category: 'Groceries', description: 'Aroma Coffee', date: `${month(0)}-05` }),
          tx({ id: 'b2', amount: -3750, category: 'Groceries', description: 'משיכת שיק', date: `${month(0)}-10` }),
          tx({ id: 'b3', amount: -100, category: 'Dining', description: 'Cafe', date: `${month(0)}-12` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    const detail = await screen.findByTestId('month-detail');
    const big = within(detail).getByTestId('biggest-expense');
    expect(within(big).getByText(/biggest expense/i)).toBeInTheDocument();
    expect(within(big).getByText('משיכת שיק')).toBeInTheDocument();
    expect(within(big).getByText(/3,?750/)).toBeInTheDocument();
  });

  it('shows Overspent when commitments outrun income', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 't1', amount: -3000, category: 'Groceries', date: `${month(0)}-10` }),
          tx({ id: 't2', amount: 1000, category: 'Salary', date: `${month(0)}-01` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    const detail = await screen.findByTestId('month-detail');
    const tiles = within(detail).getAllByTestId('md-tile');
    expect(within(tiles[2]!).getByText(/Overspent/i)).toBeInTheDocument();
    expect(within(tiles[2]!).getByText(/2,?000/)).toBeInTheDocument();
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

describe('InsightsView — AI analysis card', () => {
  it('renders an AI analysis card with a Generate button in idle state', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [tx({ id: 't1', amount: -250 })],
      }),
      'GET /api/categories': () => CATEGORIES,
      'GET /api/insights': () => ({
        state: 'idle', text: '', generatedAt: null,
        message: 'No insights generated yet.',
      }),
    });
    renderView();
    const card = await screen.findByTestId('ai-analysis');
    expect(within(card).getByText(/AI analysis/i)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /^Generate$/i })).toBeInTheDocument();
    expect(within(card).getByText(/no analysis yet/i)).toBeInTheDocument();
  });

  it('clicking Generate POSTs /api/insights and starts polling', async () => {
    const user = userEvent.setup();
    const post = vi.fn(() => ({ ok: true }));
    let statusCalls = 0;
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [tx({ id: 't1', amount: -250 })],
      }),
      'GET /api/categories': () => CATEGORIES,
      'GET /api/insights': () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return { state: 'idle', text: '', generatedAt: null, message: '' };
        }
        return {
          state: 'ready', generatedAt: '2026-05-27T00:00:00Z', message: '',
          text: 'WIN: Groceries are down 20% vs last month.\n' +
                'WATCH: Dining jumped 40%.\n' +
                'TIP: Set a Dining budget around 800 ILS.',
        };
      },
      'POST /api/insights': post,
    });
    renderView();
    const card = await screen.findByTestId('ai-analysis');
    await user.click(within(card).getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    // Poll picks up the ready state.
    expect(
      await within(card).findByText(/Groceries are down 20%/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/Dining jumped 40%/i)).toBeInTheDocument();
    expect(within(card).getByText(/Set a Dining budget/i)).toBeInTheDocument();
    // Button reads "Regenerate" once ready.
    expect(within(card).getByRole('button', { name: /Regenerate/i })).toBeInTheDocument();
  });

  it('shows a shimmer skeleton while the model is generating', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [tx({ id: 't1', amount: -250 })],
      }),
      'GET /api/categories': () => CATEGORIES,
      'GET /api/insights': () => ({
        state: 'generating', text: '', generatedAt: null,
        message: 'Generating insights…',
      }),
    });
    renderView();
    const card = await screen.findByTestId('ai-analysis');
    expect(await within(card).findByTestId('ai-skeleton')).toBeInTheDocument();
    // Generate button is disabled while generating.
    expect(within(card).getByRole('button', { name: /^Generate$/i })).toBeDisabled();
  });

  it('error state surfaces the engine message', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [tx({ id: 't1', amount: -250 })],
      }),
      'GET /api/categories': () => CATEGORIES,
      'GET /api/insights': () => ({
        state: 'error', text: '', generatedAt: null,
        message: 'Set up an AI model first to generate insights.',
      }),
    });
    renderView();
    const card = await screen.findByTestId('ai-analysis');
    expect(
      await within(card).findByText(/set up an AI model first/i),
    ).toBeInTheDocument();
  });
});

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

  it('Brokerage shows 5 stat tiles (Portfolio / Gain·1Y / Unrealized P&L / Return on cost / Holdings)', async () => {
    const user = userEvent.setup();
    // Build a year of monthly snapshots ending today, ramping up.
    const snapshots: { accountId: string; date: string; value: number; currency: string }[] = [];
    const baseDate = new Date(today);
    for (let i = 12; i >= 0; i--) {
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 15);
      snapshots.push({
        accountId: 'b1',
        date: d.toISOString().slice(0, 10),
        value: 10000 + (12 - i) * 200,
        currency: 'USD',
      });
    }
    installFetchMock({
      ...EMPTY_TXNS,
      'GET /api/brokerage': () => ({
        holdings: [
          {
            accountId: 'b1', symbol: 'VT', description: 'Vanguard Total World',
            units: 10, price: 100, currency: 'USD',
            costBasis: 800, openPnl: 200, value: 1000,
            updatedAt: today.toISOString().slice(0, 10),
          },
          {
            accountId: 'b1', symbol: 'VBR', description: 'Vanguard Small-Cap',
            units: 5, price: 50, currency: 'USD',
            costBasis: 200, openPnl: 50, value: 250,
            updatedAt: today.toISOString().slice(0, 10),
          },
        ],
        snapshots,
        holdingSnapshots: [],
        performance: [],
        ilsRates: { USD: 3.7 },
      }),
    });
    renderView();
    await user.click(await screen.findByRole('tab', { name: /brokerage/i }));
    const tiles = await screen.findAllByTestId('brokerage-stat');
    expect(tiles).toHaveLength(5);
    // Portfolio value (final snapshot = 10000 + 12*200 = 12400)
    expect(within(tiles[0]!).getByText(/portfolio/i)).toBeInTheDocument();
    // Holdings count
    expect(within(tiles[4]!).getByText(/holdings/i)).toBeInTheDocument();
    expect(within(tiles[4]!).getByText(/^2$/)).toBeInTheDocument();
    // Unrealized P&L sums to +250.
    expect(within(tiles[2]!).getByText(/p.?.?l/i)).toBeInTheDocument();
    expect(within(tiles[2]!).getByText(/250/)).toBeInTheDocument();
    // Return on cost: 250 / 1000 = 25%.
    expect(within(tiles[3]!).getByText(/^Return/i)).toBeInTheDocument();
    expect(within(tiles[3]!).getByText(/25\.?\d*%/)).toBeInTheDocument();
  });

  it('Brokerage range pills (1M / 3M / YTD / 1Y / ALL) filter the chart series', async () => {
    const user = userEvent.setup();
    // 18 monthly snapshots ending today.
    const snapshots: { accountId: string; date: string; value: number; currency: string }[] = [];
    const base = new Date(today.getFullYear(), today.getMonth(), 15);
    for (let i = 18; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 15);
      snapshots.push({
        accountId: 'b1',
        date: d.toISOString().slice(0, 10),
        value: 10000 + (18 - i) * 100,
        currency: 'USD',
      });
    }
    installFetchMock({
      ...EMPTY_TXNS,
      'GET /api/brokerage': () => ({
        holdings: [{
          accountId: 'b1', symbol: 'VT', description: 'World',
          units: 100, price: 100, currency: 'USD',
          costBasis: 9000, openPnl: 1000, value: 10000,
          updatedAt: today.toISOString().slice(0, 10),
        }],
        snapshots, holdingSnapshots: [], performance: [], ilsRates: { USD: 3.7 },
      }),
    });
    renderView();
    await user.click(await screen.findByRole('tab', { name: /brokerage/i }));
    const chart = await screen.findByTestId('brokerage-chart');
    // Default 1Y → ~13 monthly points (12 months back + current).
    const oneYearPoints = chart.querySelectorAll('circle').length;
    // 3M → fewer points than 1Y.
    await user.click(screen.getByRole('button', { name: /^3M$/ }));
    const threeMPoints = (await screen.findByTestId('brokerage-chart'))
      .querySelectorAll('circle').length;
    expect(threeMPoints).toBeLessThan(oneYearPoints);
    expect(threeMPoints).toBeGreaterThan(0);
    // ALL → at least as many as 1Y.
    await user.click(screen.getByRole('button', { name: /^ALL$/ }));
    const allPoints = (await screen.findByTestId('brokerage-chart'))
      .querySelectorAll('circle').length;
    expect(allPoints).toBeGreaterThanOrEqual(oneYearPoints);
  });

  it('Brokerage USD↔ILS toggle reformats values in the selected currency', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...EMPTY_TXNS,
      'GET /api/brokerage': () => ({
        holdings: [{
          accountId: 'b1', symbol: 'VT', description: 'World',
          units: 10, price: 100, currency: 'USD',
          costBasis: 800, openPnl: 200, value: 1000,
          updatedAt: today.toISOString().slice(0, 10),
        }],
        snapshots: [{ accountId: 'b1', date: today.toISOString().slice(0, 10), value: 1000, currency: 'USD' }],
        holdingSnapshots: [], performance: [], ilsRates: { USD: 3.7 },
      }),
    });
    renderView();
    await user.click(await screen.findByRole('tab', { name: /brokerage/i }));
    const tiles = await screen.findAllByTestId('brokerage-stat');
    // Default USD: portfolio = $1,000
    expect(within(tiles[0]!).getByText(/\$1,?000/)).toBeInTheDocument();
    // Flip to ILS — $1,000 × 3.7 = ₪3,700.
    await user.click(screen.getByRole('button', { name: /^ILS$/ }));
    expect(within((await screen.findAllByTestId('brokerage-stat'))[0]!)
      .getByText(/3,?700/)).toBeInTheDocument();
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
    // Each holding shows its market value.
    expect(within(list).getByText(/2,?000/)).toBeInTheDocument();
    expect(within(list).getByText(/2,?400/)).toBeInTheDocument();
  });
});
