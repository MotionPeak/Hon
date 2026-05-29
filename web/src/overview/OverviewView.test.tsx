import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { OverviewView } from './OverviewView';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { SettingsProvider } from '../settings/useSettings';

afterEach(() => { __resetSplitwiseCache(); localStorage.clear(); });

// OverviewView reads settings (card-bill exclusion list) via useSettings, so it
// must mount inside a SettingsProvider. Default settings have hideCardTotals on
// and a cardProviders list that includes 'מקס' (Max).
function renderOverview() {
  return render(
    <SettingsProvider>
      <OverviewView />
    </SettingsProvider>,
  );
}

const FULL_SUMMARY = {
  byCurrency: [
    { currency: 'ILS', total: 78000, accountCount: 3 },
    { currency: 'USD', total: 4300, accountCount: 1 },
  ],
  accountCount: 4,
  connectionCount: 3,
  netWorthILS: 92000,
  breakdown: {
    bank: { ILS: 16000 },
    card: { ILS: -5000 },
    brokerage: { USD: 4300 },
    'asset:car': { ILS: 60000 },
    loan: { ILS: -780000 },
  },
};

const FULL_BUDGET = {
  currency: 'ILS',
  variable: {
    income: 12000,
    committed: 7500,
    spent: 1200,
    fixedSpent: 5400,
    essentialSpent: 2100,
    allowed: 3300,
    savings: 0,
    piggyFunded: 0,
  },
  piggy: { month: '2026-05', banks: [], fundedTotal: 0, headroom: 3500, projected: true },
  essentials: [
    { category: 'Groceries', budget: 2500, spent: 1800 },
    { category: 'Transport', budget: 800, spent: 300 },
  ],
};

const COMPANIES = {
  companies: [
    { id: 'hapoalim', name: 'Hapoalim', loginFields: ['userCode', 'password'], type: 'bank' },
    { id: 'max', name: 'Max', loginFields: ['username', 'password'], type: 'card' },
  ],
};

const ACCOUNTS = {
  accounts: [
    {
      id: 'a1', connectionId: 'c1', companyId: 'hapoalim',
      connectionName: 'Hapoalim',
      accountNumber: '12-345',
      label: null,
      balance: 15000,
      currency: 'ILS',
      updatedAt: '2026-05-25T00:00:00Z',
      excluded: false,
      inceptionDate: null,
    },
    {
      id: 'a2', connectionId: 'c1', companyId: 'hapoalim',
      connectionName: 'Hapoalim',
      accountNumber: '12-346',
      label: null,
      balance: 1000,
      currency: 'ILS',
      updatedAt: '2026-05-25T00:00:00Z',
      excluded: false,
      inceptionDate: null,
    },
    {
      // Card account — should not contribute to bank-now.
      id: 'a3', connectionId: 'c2', companyId: 'max',
      connectionName: 'Max',
      accountNumber: 'card',
      label: null,
      balance: -5000,
      currency: 'ILS',
      updatedAt: '2026-05-25T00:00:00Z',
      excluded: false,
      inceptionDate: null,
    },
  ],
};

const EMPTY_SUMMARY = {
  byCurrency: [], accountCount: 0, connectionCount: 0, netWorthILS: 0,
  breakdown: {},
};
const EMPTY_BUDGET = {
  currency: 'ILS',
  variable: { income: 0, committed: 0, spent: 0, fixedSpent: 0, essentialSpent: 0, allowed: 0, savings: 0, piggyFunded: 0 },
  piggy: { month: '', banks: [], fundedTotal: 0, headroom: 0, projected: false },
  essentials: [],
};

// "YYYY-MM" for the cycle `n` calendar months before now (monthStartDay=1).
function priorCycle(n: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Default recurring fixture: one ₪5,400 monthly Housing bill seen in the two
// prior cycles. expectedFixedThisCycle → 5,400 == FULL_BUDGET.fixedSpent, so
// committedDisplay == the budget's committed (7,500) and the existing
// projection/headline math tests keep their numbers.
const RECURRING_DEFAULT = {
  categories: [{ name: 'Housing', catGroup: 'fixed' }],
  transactions: [
    { id: 'h1', date: `${priorCycle(2)}-10`, amount: -5400, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
    { id: 'h2', date: `${priorCycle(1)}-10`, amount: -5400, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
  ],
};

function mocks(overrides: Record<string, unknown> = {}): Record<string, () => unknown> {
  return {
    'GET /api/summary': () => FULL_SUMMARY,
    'GET /api/budget': () => FULL_BUDGET,
    'GET /api/companies': () => COMPANIES,
    'GET /api/accounts': () => ACCOUNTS,
    // Recurring endpoints feed the predicted-fixed headline (Task: predicted fixed).
    'GET /api/transactions': () => ({ transactions: RECURRING_DEFAULT.transactions }),
    'GET /api/categories': () => ({ categories: RECURRING_DEFAULT.categories }),
    'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
    'GET /api/category-splits': () => ({ splits: {} }),
    'GET /api/subscriptions/cancelled': () => ({ cancelled: {} }),
    // OwedToYouCard's useSplitwise hook fetches on mount; stub disconnected
    // so the card renders null and no /refresh call is made.
    'GET /api/splitwise/status': () => ({ connected: false, user: null }),
    'GET /api/splitwise/links': () => ({ links: [] }),
    ...overrides,
  };
}

describe('OverviewView', () => {
  it('passes card-provider exclusions to /budget when hideCardTotals is on', async () => {
    const spy = installFetchMock(mocks());
    renderOverview();
    await screen.findByTestId('balance-card');
    // The bank-side credit-card bill lump sum (e.g. "מקס איט פיננסים") is
    // already itemised under the card account; counting it again on the bank
    // side double-counts. /budget only drops it when the client passes the
    // cardProvider exclusion list — same as Insights, Activity, legacy SPA.
    const budgetCall = spy.mock.calls.find(
      ([input]) => String(input).includes('/api/budget'),
    );
    expect(budgetCall, 'OverviewView should fetch /api/budget').toBeTruthy();
    const url = decodeURIComponent(String(budgetCall![0]));
    expect(url).toContain('cardProvider=');
    expect(url).toContain('מקס');
  });

  it('uses predicted fixed (not posted) for "Expected fixed + essentials"', async () => {
    // One detected ₪3,000 monthly Housing bill (two prior cycles) + ₪2,100
    // essentialSpent → committedDisplay = 5,100, regardless of the budget's
    // posted fixedSpent (5,400) / committed (7,500).
    installFetchMock(mocks({
      'GET /api/categories': () => ({ categories: [{ name: 'Housing', catGroup: 'fixed' }] }),
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', date: `${priorCycle(2)}-10`, amount: -3000, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
          { id: 't2', date: `${priorCycle(1)}-10`, amount: -3000, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
        ],
      }),
    }));
    renderOverview();
    const card = await screen.findByTestId('balance-card');
    // net = income(12000) − committedDisplay(5100) − spent(1200) = 5700
    expect((card.querySelector('.balance-num') as HTMLElement).textContent).toMatch(/5,?700/);
    // committed line shows 5,100 (predicted 3,000 + essential 2,100), not 7,500.
    // Scope to the headline breakdown — the projection line below also shows 5,100.
    const line = card.querySelector('.balance-line') as HTMLElement;
    expect(within(line).getByText(/5,?100/)).toBeInTheDocument();
  });

  it('falls back to posted committed when the recurring fetch fails', async () => {
    installFetchMock(mocks({
      'GET /api/transactions': () => new Response('boom', { status: 500 }),
    }));
    renderOverview();
    const card = await screen.findByTestId('balance-card');
    // recurring failed → committedDisplay = variable.committed (7500);
    // net = 12000 − 7500 − 1200 = 3300
    expect((card.querySelector('.balance-num') as HTMLElement).textContent).toMatch(/3,?300/);
  });

  it('adds an "Owed to you (Splitwise)" line to the projection and end balance', async () => {
    installFetchMock(mocks({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1 } }),
      'POST /api/splitwise/refresh': () => ({
        friends: [{ name: 'Noga', balances: [{ amount: 800, currency: 'ILS' }] }],
        links: [],
      }),
    }));
    renderOverview();
    const card = await screen.findByTestId('bank-projection');
    // owed (ILS, >0) = 800 → its own projection line, folded into end balance.
    expect(await within(card).findByText(/Owed to you \(Splitwise\)/i)).toBeInTheDocument();
    expect(within(card).getByText(/800/)).toBeInTheDocument();
  });

  it('omits the owed line when Splitwise has no ILS balance owed', async () => {
    installFetchMock(mocks({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1 } }),
      'POST /api/splitwise/refresh': () => ({
        friends: [{ name: 'Noga', balances: [{ amount: 50, currency: 'USD' }] }],
        links: [],
      }),
    }));
    renderOverview();
    // Wait for Splitwise to finish loading (the OwedToYouCard shows the friend),
    // then assert the projection has no owed line — USD is filtered out.
    await screen.findByText('Noga');
    const card = await screen.findByTestId('bank-projection');
    expect(within(card).queryByText(/Owed to you \(Splitwise\)/i)).not.toBeInTheDocument();
  });

  it('renders the net worth card with the ILS headline', async () => {
    installFetchMock(mocks());
    renderOverview();
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    expect(within(card as HTMLElement).getByText(/92,?000/)).toBeInTheDocument();
  });

  it('renders per-currency chips when more than one currency is held', async () => {
    installFetchMock(mocks());
    renderOverview();
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    expect(within(card as HTMLElement).getByText(/78,?000/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/4,?300/)).toBeInTheDocument();
  });

  it('renders the "this month" balance headline (income - committed - spent)', async () => {
    installFetchMock(mocks());
    renderOverview();
    // 12000 - 7500 - 1200 = 3300
    const card = await screen.findByTestId('balance-card');
    const headline = card.querySelector('.balance-num') as HTMLElement;
    expect(headline.textContent).toMatch(/3,?300/);
  });

  it('marks the balance card red when committed > income (in the red)', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({
        ...FULL_BUDGET,
        variable: { ...FULL_BUDGET.variable, income: 5000, committed: 7500, spent: 1200 },
      }),
    }));
    renderOverview();
    // 5000 - 7500 - 1200 = -3700
    const card = await screen.findByTestId('balance-card');
    const headline = card.querySelector('.balance-num') as HTMLElement;
    expect(headline.textContent).toMatch(/3,?700/);
    expect(headline.className).toMatch(/\bbad\b/);
  });

  it('shows the empty state when there are no accounts or budget data', async () => {
    installFetchMock(mocks({
      'GET /api/summary': () => EMPTY_SUMMARY,
      'GET /api/budget': () => EMPTY_BUDGET,
      'GET /api/companies': () => ({ companies: [] }),
      'GET /api/accounts': () => ({ accounts: [] }),
    }));
    renderOverview();
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it('renders the projected bank balance: bankNow + income − committed − spent − piggy', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({
        ...FULL_BUDGET,
        variable: { ...FULL_BUDGET.variable, piggyFunded: 500 },
      }),
    }));
    renderOverview();
    const card = await screen.findByTestId('bank-projection');
    // bankNow = 15000 + 1000 = 16000 (card account excluded)
    // change = 12000 − 7500 − 1200 − 500 = 2800
    // end = 16000 + 2800 = 18800
    expect(within(card).getByText(/18,?800/)).toBeInTheDocument();
    // The change delta is shown as +2,800
    expect(within(card).getByText(/2,?800/)).toBeInTheDocument();
    // And the starting "Bank balance now" row is 16,000.
    expect(within(card).getByText(/16,?000/)).toBeInTheDocument();
  });

  it('excludes excluded bank accounts and non-ILS accounts from bank-now', async () => {
    installFetchMock(mocks({
      'GET /api/accounts': () => ({
        accounts: [
          ...ACCOUNTS.accounts.slice(0, 1), // 15,000 ILS bank
          {
            id: 'excluded', connectionId: 'c1', companyId: 'hapoalim',
            connectionName: 'Hapoalim', accountNumber: 'x', label: null,
            balance: 999999, currency: 'ILS',
            updatedAt: '2026-05-25T00:00:00Z',
            excluded: true, inceptionDate: null,
          },
          {
            id: 'usd', connectionId: 'c1', companyId: 'hapoalim',
            connectionName: 'Hapoalim', accountNumber: 'usd', label: null,
            balance: 8888, currency: 'USD',
            updatedAt: '2026-05-25T00:00:00Z',
            excluded: false, inceptionDate: null,
          },
        ],
      }),
    }));
    renderOverview();
    const card = await screen.findByTestId('bank-projection');
    // bankNow = 15,000 (only the first ILS bank account)
    expect(within(card).getByText(/15,?000/)).toBeInTheDocument();
    expect(within(card).queryByText(/999,?999/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/8,?888/)).not.toBeInTheDocument();
  });

  it('omits the projection block when there are no bank accounts', async () => {
    installFetchMock(mocks({
      'GET /api/accounts': () => ({
        accounts: [ACCOUNTS.accounts[2]], // only the card account — no banks
      }),
    }));
    renderOverview();
    await screen.findByTestId('balance-card');
    expect(screen.queryByTestId('bank-projection')).not.toBeInTheDocument();
  });

  it('renders an essentials card with one row per essential budget line', async () => {
    installFetchMock(mocks());
    renderOverview();
    const card = await screen.findByTestId('essentials-card');
    expect(within(card).getByText('Groceries')).toBeInTheDocument();
    expect(within(card).getByText('Transport')).toBeInTheDocument();
    // Groceries — 1,800 / 2,500
    expect(within(card).getByText(/1,?800/)).toBeInTheDocument();
    expect(within(card).getByText(/2,?500/)).toBeInTheDocument();
  });

  it('marks an essentials row over-budget when spent exceeds budget', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({
        ...FULL_BUDGET,
        essentials: [{ category: 'Groceries', budget: 2000, spent: 2400 }],
      }),
    }));
    renderOverview();
    const card = await screen.findByTestId('essentials-card');
    const row = within(card).getByText('Groceries').closest('.ess-row');
    expect(row).not.toBeNull();
    expect(row!.className).toMatch(/\bover\b/);
  });

  it('omits the essentials card when no essential lines exist', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({ ...FULL_BUDGET, essentials: [] }),
    }));
    renderOverview();
    await screen.findByTestId('balance-card');
    expect(screen.queryByTestId('essentials-card')).not.toBeInTheDocument();
  });
});
