import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
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

  it('excludes card-bill totals from Spent + biggest expense (default cardProviders)', async () => {
    // Default settings.cardProviders includes 'מקס'; the bank-side
    // "מקס איט פיננסים" lump sum is a card-bill total already itemised
    // under the card account — it must NOT count as spending.
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 'g1', amount: -250, category: 'Groceries', description: 'Aroma', date: `${month(0)}-05` }),
          tx({ id: 'card', amount: -9000, category: 'Other', description: 'מקס איט פיננסים', date: `${month(0)}-10` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    const detail = await screen.findByTestId('month-detail');
    const tiles = within(detail).getAllByTestId('md-tile');
    // Spent = 250 only (the ₪9,000 card-bill total is excluded).
    expect(within(tiles[0]!).getByText(/Spent/i)).toBeInTheDocument();
    expect(within(tiles[0]!).getByText(/^[^0-9]*250/)).toBeInTheDocument();
    expect(within(detail).queryByText(/9,?000/)).not.toBeInTheDocument();
    // Biggest expense is the ₪250 charge, not the card bill.
    const big = within(detail).getByTestId('biggest-expense');
    expect(within(big).getByText('Aroma')).toBeInTheDocument();
    expect(within(big).queryByText('מקס איט פיננסים')).not.toBeInTheDocument();
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
  // BrokerageSubTab fetches /accounts alongside /brokerage to drive the
  // per-account filter pills. Default to empty so tests that don't
  // override stay focused on what they care about.
  'GET /api/accounts': () => ({ accounts: [] }),
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

  it('Generate POST carries cardProviders when hideCardTotals is on', async () => {
    // Inject settings via localStorage so SettingsProvider picks them up.
    localStorage.setItem('honSettings', JSON.stringify({
      hideCardTotals: true,
      cardProviders: ['מקס איט'],
    }));
    const user = userEvent.setup();
    let capturedBody: unknown;
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [tx({ id: 't1', amount: -250 })],
      }),
      'GET /api/categories': () => CATEGORIES,
      'GET /api/insights': () => ({
        state: 'idle', text: '', generatedAt: null, message: '',
      }),
      'POST /api/insights': (body) => {
        capturedBody = body;
        return { ok: true };
      },
    });
    render(<SettingsProvider><InsightsView /></SettingsProvider>);
    const card = await screen.findByTestId('ai-analysis');
    await user.click(within(card).getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toEqual({ cardProviders: ['מקס איט'] });
    localStorage.removeItem('honSettings');
  });

  it('Generate POST sends empty cardProviders when hideCardTotals is off', async () => {
    localStorage.setItem('honSettings', JSON.stringify({
      hideCardTotals: false,
      cardProviders: ['מקס איט'],
    }));
    const user = userEvent.setup();
    let capturedBody: unknown;
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [tx({ id: 't1', amount: -250 })],
      }),
      'GET /api/categories': () => CATEGORIES,
      'GET /api/insights': () => ({
        state: 'idle', text: '', generatedAt: null, message: '',
      }),
      'POST /api/insights': (body) => {
        capturedBody = body;
        return { ok: true };
      },
    });
    render(<SettingsProvider><InsightsView /></SettingsProvider>);
    const card = await screen.findByTestId('ai-analysis');
    await user.click(within(card).getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toEqual({ cardProviders: [] });
    localStorage.removeItem('honSettings');
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
    // LineChart renders a smooth path (no per-point circles); the axis
    // reflects the visible window end date (last snapshot: Mar 15).
    const axis = screen.getByTestId('brokerage-chart-axis');
    expect(axis.lastChild!.textContent).toMatch(/Mar/);
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
            // costBasis/openPnl are PER UNIT (as SnapTrade reports them):
            // value 1000, cost 10×80 = 800, gain = 1000 − 800 = 200.
            accountId: 'b1', symbol: 'VT', description: 'Vanguard Total World',
            units: 10, price: 100, currency: 'USD',
            costBasis: 80, openPnl: 20, value: 1000,
            updatedAt: today.toISOString().slice(0, 10),
          },
          {
            // value 250, cost 5×40 = 200, gain = 250 − 200 = 50.
            accountId: 'b1', symbol: 'VBR', description: 'Vanguard Small-Cap',
            units: 5, price: 50, currency: 'USD',
            costBasis: 40, openPnl: 10, value: 250,
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
    await screen.findByTestId('brokerage-chart');
    // LineChart has no per-point circles; it exposes the visible point
    // count via data-points on the .lc-wrap, which still reflects the
    // active range filter.
    const points = (): number =>
      Number(document.querySelector('.lc-wrap')!.getAttribute('data-points'));
    // Default 1Y → ~13 monthly points (12 months back + current).
    const oneYearPoints = points();
    // 3M → fewer points than 1Y.
    await user.click(screen.getByRole('button', { name: /^3M$/ }));
    await screen.findByTestId('brokerage-chart');
    const threeMPoints = points();
    expect(threeMPoints).toBeLessThan(oneYearPoints);
    expect(threeMPoints).toBeGreaterThan(0);
    // ALL → at least as many as 1Y.
    await user.click(screen.getByRole('button', { name: /^ALL$/ }));
    await screen.findByTestId('brokerage-chart');
    const allPoints = points();
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

  it('clicking a holding row reveals its stats grid; clicking again hides it', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...EMPTY_TXNS,
      'GET /api/brokerage': () => ({
        holdings: [
          {
            accountId: 'b1', symbol: 'VT', description: 'Vanguard Total World',
            units: 10, price: 100, currency: 'USD',
            costBasis: 80, openPnl: 20, value: 1000,
            updatedAt: '2026-05-25',
          },
          {
            accountId: 'b1', symbol: 'VBR', description: 'Vanguard Small-Cap',
            units: 5, price: 50, currency: 'USD',
            costBasis: 40, openPnl: 10, value: 250,
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
    const row = await screen.findByTestId('holding-row-VT');
    expect(screen.queryByTestId('holding-detail-VT')).toBeNull();
    await user.click(row);
    const detail = screen.getByTestId('holding-detail-VT');
    expect(detail).toBeInTheDocument();
    // The stats grid shows real computed values from the VT fixture:
    // units 10, market value = $1,000 (units 10 × price 100, USD display).
    expect(within(detail).getByText(/^Units$/i)).toBeInTheDocument();
    expect(within(detail).getByText(/^10$/)).toBeInTheDocument();
    expect(within(detail).getByText(/^Market value$/i)).toBeInTheDocument();
    expect(within(detail).getByText(/\$1,?000/)).toBeInTheDocument();
    await user.click(row);
    await waitFor(() => expect(screen.queryByTestId('holding-detail-VT')).toBeNull());
  });
});

describe('InsightsView — brokerage account pills', () => {
  const accountsResp = {
    accounts: [
      { id: 'a-ibkr', connectionId: 'c-st', companyId: 'snaptrade',
        connectionName: 'IBKR', accountNumber: '123', label: 'IBKR USD',
        balance: 4302.44, currency: 'USD', updatedAt: '2026-05-25',
        excluded: false, inceptionDate: null },
      { id: 'a-vg', connectionId: 'c-st', companyId: 'snaptrade',
        connectionName: 'IBKR', accountNumber: '456', label: 'Vanguard',
        balance: 1234, currency: 'USD', updatedAt: '2026-05-25',
        excluded: false, inceptionDate: '2024-06-01' },
      { id: 'a-bank', connectionId: 'c-b', companyId: 'beinleumi',
        connectionName: 'Beinleumi', accountNumber: '789', label: 'Checking',
        balance: -2187, currency: 'ILS', updatedAt: '2026-05-25',
        excluded: false, inceptionDate: null },
    ],
  };

  const brokerageResp = {
    holdings: [
      { accountId: 'a-ibkr', symbol: 'AAPL', description: 'Apple',
        units: 10, price: 200, currency: 'USD',
        costBasis: 1500, openPnl: 500, value: 2000, updatedAt: '2026-05-25' },
      { accountId: 'a-vg', symbol: 'VOO', description: 'S&P 500',
        units: 5, price: 400, currency: 'USD',
        costBasis: 1800, openPnl: 200, value: 2000, updatedAt: '2026-05-25' },
    ],
    snapshots: [
      { accountId: 'a-ibkr', date: '2024-05-01', value: 1500, currency: 'USD' },
      { accountId: 'a-ibkr', date: '2025-05-01', value: 1800, currency: 'USD' },
      { accountId: 'a-ibkr', date: '2026-05-01', value: 2000, currency: 'USD' },
      { accountId: 'a-vg',   date: '2024-01-01', value:  900, currency: 'USD' },
      { accountId: 'a-vg',   date: '2025-01-01', value: 1500, currency: 'USD' },
      { accountId: 'a-vg',   date: '2026-01-01', value: 2000, currency: 'USD' },
    ],
    holdingSnapshots: [],
    performance: [],
    ilsRates: { USD: 3.7 },
  };

  const baseMocks = {
    ...EMPTY_TXNS,
    'GET /api/brokerage': () => brokerageResp,
    'GET /api/accounts': () => accountsResp,
  };

  async function openBrokerage(user: ReturnType<typeof userEvent.setup>) {
    renderView();
    await user.click(await screen.findByRole('tab', { name: /brokerage/i }));
  }

  it('renders an "All accounts" pill plus one pill per brokerage account in /brokerage', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    const group = await screen.findByRole('group', { name: /accounts/i });
    expect(within(group).getByRole('button', { name: /all accounts/i })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /IBKR USD/ })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /Vanguard/ })).toBeInTheDocument();
    // Bank account NOT in the pills (no snapshots in /brokerage).
    expect(within(group).queryByRole('button', { name: /Checking/ })).not.toBeInTheDocument();
  });

  it('starts on "All accounts" — pill marked on, chart renders', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    const group = await screen.findByRole('group', { name: /accounts/i });
    expect(within(group).getByRole('button', { name: /all accounts/i }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('brokerage-chart')).toBeInTheDocument();
  });

  it('selecting an account marks its pill on and unsets All accounts', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /IBKR USD/ }));
    expect(within(group).getByRole('button', { name: /IBKR USD/ }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: /all accounts/i }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('hides the inception input under "All accounts" and shows the earliest read-only badge', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    await screen.findByRole('group', { name: /accounts/i });
    expect(screen.queryByLabelText(/investment start/i)).not.toBeInTheDocument();
    // Earliest = min(inceptionDate ?? firstSnapshotDate per account).
    // a-ibkr has no inception; its first snapshot is 2024-05-01.
    // a-vg has inception 2024-06-01.
    // min = 2024-05-01.
    expect(screen.getByText(/since 2024-05-01 \(earliest\)/i)).toBeInTheDocument();
  });

  it('reveals the inception input when a specific account is selected', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
    const input = screen.getByLabelText('Investment start') as HTMLInputElement;
    expect(input).toHaveValue('2024-06-01');
  });

  it('editing the inception PATCHes /accounts/:id/inception and refetches', async () => {
    const patch = vi.fn((_b: unknown) => ({ ok: true }));
    let brokerageCalls = 0;
    installFetchMock({
      ...baseMocks,
      'GET /api/brokerage': () => { brokerageCalls += 1; return brokerageResp; },
      'PATCH /api/accounts/a-vg/inception': patch,
    });
    const user = userEvent.setup();
    await openBrokerage(user);
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
    const input = screen.getByLabelText('Investment start') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2025-01-01' } });
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]?.[0]).toEqual({ inceptionDate: '2025-01-01' });
    expect(brokerageCalls).toBeGreaterThan(1);
  });

  it('drops snapshots before account.inceptionDate when a focused account has an inception', async () => {
    // a-vg has inceptionDate '2024-06-01' but a snapshot at '2024-01-01'.
    // Focusing Vanguard should drop the pre-inception snapshot. The
    // LineChart has no per-point circles; the visible point count is
    // exposed via data-points on the .lc-wrap. The two post-inception
    // dates (2025-01-01, 2026-01-01) and 2024-01-01 both format to
    // "Jan 1", so the axis date can't distinguish them — assert the
    // point count drops from 3 (full series) to 2 (post-inception).
    installFetchMock({
      ...baseMocks,
      'GET /api/brokerage': () => ({
        ...brokerageResp,
        snapshots: brokerageResp.snapshots.filter((s) => s.accountId === 'a-vg'),
      }),
    });
    const user = userEvent.setup();
    await openBrokerage(user);
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
    await screen.findByTestId('brokerage-chart');
    const points = (): number =>
      Number(document.querySelector('.lc-wrap')!.getAttribute('data-points'));
    const before = points();
    // 3 snapshots total for a-vg; one is pre-inception (2024-01-01);
    // we expect 2 after the cutoff. (Range pill defaults to 1Y which
    // would also clip to ~1 year back from latest, but 2026-01-01 is
    // within 1Y of latest = 2026-01-01, and 2025-01-01 is at the
    // 1Y edge. Use ALL to remove the range filter from the picture.)
    await user.click(screen.getByRole('button', { name: /^ALL$/ }));
    await screen.findByTestId('brokerage-chart');
    expect(points()).toBe(2);
    expect(before).toBeGreaterThan(0);
  });

  it('clearing the inception PATCHes with null', async () => {
    const patch = vi.fn((_b: unknown) => ({ ok: true }));
    installFetchMock({
      ...baseMocks,
      'PATCH /api/accounts/a-vg/inception': patch,
    });
    const user = userEvent.setup();
    await openBrokerage(user);
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
    await user.click(screen.getByRole('button', { name: /clear inception date/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]?.[0]).toEqual({ inceptionDate: null });
  });

  it('renders pills + inception BELOW the chart card in DOM order', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    const pane = document.querySelector('.brokerage-pane')!;
    const chartCard = pane.querySelector('.brk-chart-card')!;
    const pillRow = pane.querySelector('.brk-acct-row')!;
    expect(chartCard).not.toBeNull();
    expect(pillRow).not.toBeNull();
    // compareDocumentPosition: FOLLOWING (4) means pillRow comes after chartCard.
    expect(chartCard.compareDocumentPosition(pillRow) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('applies a tone class on the chart wrapper based on the period direction', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    // IBKR-only series rises 1500 → 2000 over the window → good (green).
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /IBKR USD/ }));
    expect(document.querySelector('.lc-wrap.lc-good')).not.toBeNull();
  });

  it('uses the legacy inception wording when an account is focused', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
    expect(screen.getByText(/since when "ALL" counts/i)).toBeInTheDocument();
  });

  it('scopes the stat tiles + holdings list to the selected account', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    // Portfolio value = sum of in-scope account BALANCES (includes cash).
    // All accounts: a-ibkr $4,302.44 + a-vg $1,234 = $5,536.44.
    const statsAll = screen.getAllByTestId('brokerage-stat');
    expect(within(statsAll[0]!).getByText(/\$5,?536/)).toBeInTheDocument();
    expect(within(statsAll[4]!).getByText(/^2$/)).toBeInTheDocument(); // Holdings count
    // Focus IBKR (a-ibkr) → its balance $4,302.44, 1 holding (AAPL).
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /IBKR USD/ }));
    const statsIbkr = screen.getAllByTestId('brokerage-stat');
    expect(within(statsIbkr[0]!).getByText(/\$4,?302/)).toBeInTheDocument();
    expect(within(statsIbkr[4]!).getByText(/^1$/)).toBeInTheDocument();
    // Holdings list shows only AAPL now, not VOO.
    const list = screen.getByTestId('brokerage-holdings');
    expect(within(list).getByText('AAPL')).toBeInTheDocument();
    expect(within(list).queryByText('VOO')).not.toBeInTheDocument();
  });

  it('shows a Cash row for the uninvested balance so positions add up to the total', async () => {
    installFetchMock(baseMocks);
    const user = userEvent.setup();
    await openBrokerage(user);
    // Focus IBKR: balance $4,302.44, only holding AAPL $2,000 →
    // uninvested cash $2,302.44 surfaced as its own row.
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /IBKR USD/ }));
    const cash = screen.getByTestId('brokerage-cash-row');
    expect(within(cash).getByText('Cash')).toBeInTheDocument();
    expect(within(cash).getByText(/\$2,?302/)).toBeInTheDocument();
  });

  it('shows NO cash row when no in-scope account exposes a balance', async () => {
    // /accounts empty → portfolio falls back to the holdings sum, which
    // already equals the rows, so there's nothing uninvested to surface.
    installFetchMock({ ...baseMocks, 'GET /api/accounts': () => ({ accounts: [] }) });
    const user = userEvent.setup();
    await openBrokerage(user);
    await screen.findByTestId('brokerage-holdings');
    expect(screen.queryByTestId('brokerage-cash-row')).not.toBeInTheDocument();
  });

  it('values a null-value holding from units × price (not ₪0)', async () => {
    // SnapTrade leaves `value` null for some IBKR positions but reports
    // units + price — the real market value is units × price.
    const nullValueHoldings = {
      ...brokerageResp,
      holdings: [
        { accountId: 'a-ibkr', symbol: 'VBR', description: 'Small-Cap',
          units: 3, price: 100, currency: 'USD',
          costBasis: 160, openPnl: 75, value: null, updatedAt: '2026-05-25' },
      ],
      ilsRates: { USD: 1 },
    };
    installFetchMock({ ...baseMocks, 'GET /api/brokerage': () => nullValueHoldings });
    const user = userEvent.setup();
    await openBrokerage(user);
    // The holding's value comes from units × price (3 × 100 = $300), NOT ₪0
    // — shown in the holdings list. (Portfolio value is balance-based.)
    const list = screen.getByTestId('brokerage-holdings');
    expect(within(list).getByText(/\$300/)).toBeInTheDocument();
    expect(within(list).queryByText('₪0')).not.toBeInTheDocument();
  });

  it('uses broker performance for the chart when present (not just local snapshots)', async () => {
    // Performance for connection c-st has 4 dated points; the snapshots
    // table has only recent ones. The chart must follow performance.
    const withPerf = {
      ...brokerageResp,
      snapshots: [
        { accountId: 'a-ibkr', date: '2026-05-26', value: 4000, currency: 'USD' },
        { accountId: 'a-ibkr', date: '2026-05-27', value: 4000, currency: 'USD' },
      ],
      performance: [
        { connectionId: 'c-st', data: { currency: 'USD', totalEquity: [
          { date: '2025-06-01', value: 3000, currency: 'USD' },
          { date: '2025-09-01', value: 3200, currency: 'USD' },
          { date: '2025-12-01', value: 3600, currency: 'USD' },
          { date: '2026-03-01', value: 4000, currency: 'USD' },
        ] } },
      ],
    };
    installFetchMock({ ...baseMocks, 'GET /api/brokerage': () => withPerf });
    const user = userEvent.setup();
    await openBrokerage(user);
    await user.click(screen.getByRole('button', { name: /^ALL$/ }));
    await screen.findByTestId('brokerage-chart');
    const points = Number(document.querySelector('.lc-wrap')!.getAttribute('data-points'));
    // 4 performance points (snapshots would have given 2) → performance wins.
    expect(points).toBe(4);
  });
});
