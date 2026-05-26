import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { OverviewView } from './OverviewView';
import { installFetchMock } from '../test/mockFetch';

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

function mocks(overrides: Record<string, unknown> = {}): Record<string, () => unknown> {
  return {
    'GET /api/summary': () => FULL_SUMMARY,
    'GET /api/budget': () => FULL_BUDGET,
    'GET /api/companies': () => COMPANIES,
    'GET /api/accounts': () => ACCOUNTS,
    ...overrides,
  };
}

describe('OverviewView', () => {
  it('renders the net worth card with the ILS headline', async () => {
    installFetchMock(mocks());
    render(<OverviewView />);
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    expect(within(card as HTMLElement).getByText(/92,?000/)).toBeInTheDocument();
  });

  it('renders per-currency chips when more than one currency is held', async () => {
    installFetchMock(mocks());
    render(<OverviewView />);
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    expect(within(card as HTMLElement).getByText(/78,?000/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/4,?300/)).toBeInTheDocument();
  });

  it('renders the "this month" balance headline (income - committed - spent)', async () => {
    installFetchMock(mocks());
    render(<OverviewView />);
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
    render(<OverviewView />);
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
    render(<OverviewView />);
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it('renders the projected bank balance: bankNow + income − committed − spent − piggy', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({
        ...FULL_BUDGET,
        variable: { ...FULL_BUDGET.variable, piggyFunded: 500 },
      }),
    }));
    render(<OverviewView />);
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
    render(<OverviewView />);
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
    render(<OverviewView />);
    await screen.findByTestId('balance-card');
    expect(screen.queryByTestId('bank-projection')).not.toBeInTheDocument();
  });

  it('renders an essentials card with one row per essential budget line', async () => {
    installFetchMock(mocks());
    render(<OverviewView />);
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
    render(<OverviewView />);
    const card = await screen.findByTestId('essentials-card');
    const row = within(card).getByText('Groceries').closest('.ess-row');
    expect(row).not.toBeNull();
    expect(row!.className).toMatch(/\bover\b/);
  });

  it('omits the essentials card when no essential lines exist', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({ ...FULL_BUDGET, essentials: [] }),
    }));
    render(<OverviewView />);
    await screen.findByTestId('balance-card');
    expect(screen.queryByTestId('essentials-card')).not.toBeInTheDocument();
  });
});
