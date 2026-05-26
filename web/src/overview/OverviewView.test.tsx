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
  essentials: [],
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

describe('OverviewView', () => {
  it('renders the net worth card with the ILS headline', async () => {
    installFetchMock({
      'GET /api/summary': () => FULL_SUMMARY,
      'GET /api/budget': () => FULL_BUDGET,
    });
    render(<OverviewView />);
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    expect(within(card as HTMLElement).getByText(/92,?000/)).toBeInTheDocument();
  });

  it('renders per-currency chips when more than one currency is held', async () => {
    installFetchMock({
      'GET /api/summary': () => FULL_SUMMARY,
      'GET /api/budget': () => FULL_BUDGET,
    });
    render(<OverviewView />);
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    // ILS chip + USD chip
    expect(within(card as HTMLElement).getByText(/78,?000/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/4,?300/)).toBeInTheDocument();
  });

  it('renders the "this month" balance headline (income - committed)', async () => {
    installFetchMock({
      'GET /api/summary': () => FULL_SUMMARY,
      'GET /api/budget': () => FULL_BUDGET,
    });
    render(<OverviewView />);
    // income 12000 - committed 7500 - spent 1200 = 3300
    const card = await screen.findByTestId('balance-card');
    expect(within(card).getByText(/3,?300/)).toBeInTheDocument();
  });

  it('marks the balance card red when committed > income (in the red)', async () => {
    installFetchMock({
      'GET /api/summary': () => FULL_SUMMARY,
      'GET /api/budget': () => ({
        ...FULL_BUDGET,
        variable: { ...FULL_BUDGET.variable, income: 5000, committed: 7500, spent: 1200 },
      }),
    });
    render(<OverviewView />);
    // income 5000 - committed 7500 - spent 1200 = -3700
    const card = await screen.findByTestId('balance-card');
    expect(within(card).getByText(/3,?700/)).toBeInTheDocument();
    // The big number has a "bad" class
    const num = within(card).getByText(/3,?700/);
    expect(num.className).toMatch(/\bbad\b/);
  });

  it('shows the empty state when there are no accounts or budget data', async () => {
    installFetchMock({
      'GET /api/summary': () => EMPTY_SUMMARY,
      'GET /api/budget': () => EMPTY_BUDGET,
    });
    render(<OverviewView />);
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });
});
