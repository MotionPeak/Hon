import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoansView } from './LoansView';
import { renderWithProviders as render } from '../test/renderWithProviders';
import { installFetchMock } from '../test/mockFetch';
import { useUiStore } from '../store/uiStore';

const LOANS = {
  loans: [
    {
      id: 'l-1', name: 'Mortgage', principal: 1000000, startDate: '2020-01-01',
      termMonths: 240, isPrime: false, isCpiLinked: true, rateValue: 2.5,
      cpiStart: 100, currency: 'ILS', excluded: false, notes: null,
      connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2020-01-01', updatedAt: '2026-05-26',
      rateType: 'cpi-fixed',
      state: {
        monthsElapsed: 76, monthsRemaining: 164, annualRate: 2.5,
        monthlyPayment: 5400, outstanding: 780000, totalPaid: 410000,
        progress: 0.32, cpiRatio: 1.06,
      },
    },
    {
      id: 'l-2', name: 'Car loan', principal: 80000, startDate: '2024-06-01',
      termMonths: 36, isPrime: true, isCpiLinked: false, rateValue: 1.5,
      cpiStart: null, currency: 'ILS', excluded: false, notes: null,
      connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2024-06-01', updatedAt: '2026-05-26',
      rateType: 'prime',
      state: {
        monthsElapsed: 23, monthsRemaining: 13, annualRate: 7.5,
        monthlyPayment: 2480, outstanding: 31600, totalPaid: 57000,
        progress: 0.65, cpiRatio: 1,
      },
    },
  ],
  rates: { prime: 6, cpiNow: 106 },
};

describe('LoansView', () => {
  it('shows the empty state when there are no loans', async () => {
    installFetchMock({ 'GET /api/loans': () => ({ loans: [], rates: {} }) });
    render(<LoansView />);
    expect(await screen.findByText(/no loans/i)).toBeInTheDocument();
  });

  it('empty state offers + Add a loan that hands off to the Assets tab', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/loans': () => ({ loans: [], rates: {} }) });
    // Reset the UI store, then assert the click drives it to the Assets tab
    // with the add-loan pending action (replaces the old hon.go-to-assets event).
    useUiStore.setState({ tab: 'loans', pendingAction: null });
    render(<LoansView />);
    await user.click(await screen.findByRole('button', { name: /\+ add a loan/i }));
    expect(window.localStorage.getItem('hon.pendingAddLoan')).toBe('1');
    expect(useUiStore.getState().tab).toBe('accounts');
    expect(useUiStore.getState().pendingAction).toBe('add-loan');
    window.localStorage.removeItem('hon.pendingAddLoan');
  });

  it('renders each loan card with name + outstanding + monthly payment', async () => {
    installFetchMock({ 'GET /api/loans': () => LOANS });
    render(<LoansView />);
    expect(await screen.findByText('Mortgage')).toBeInTheDocument();
    expect(screen.getByText('Car loan')).toBeInTheDocument();
    const mortgage = screen.getByText('Mortgage').closest('.loan-card-rich')!;
    // Outstanding ₪780,000 and monthly ₪5,400 somewhere on the card.
    expect(within(mortgage as HTMLElement).getByText(/780,?000/)).toBeInTheDocument();
    expect(within(mortgage as HTMLElement).getByText(/5,?400/)).toBeInTheDocument();
  });

  it('renders the rate-track pill matching the loan track', async () => {
    installFetchMock({ 'GET /api/loans': () => LOANS });
    render(<LoansView />);
    const car = (await screen.findByText('Car loan')).closest('.loan-card-rich')!;
    expect(within(car as HTMLElement).getByText('Prime')).toBeInTheDocument();
  });

  it('renders a total debt strip summing outstanding amounts (non-excluded)', async () => {
    installFetchMock({ 'GET /api/loans': () => LOANS });
    render(<LoansView />);
    const strip = await screen.findByTestId('loan-totals');
    // 780,000 + 31,600 = 811,600
    expect(within(strip).getByText(/811,?600/)).toBeInTheDocument();
  });

  it('renders the remaining months / years left', async () => {
    installFetchMock({ 'GET /api/loans': () => LOANS });
    render(<LoansView />);
    // Mortgage has 164 months remaining = 13 yrs 8 mo.
    expect(await screen.findByText(/13 yrs.*8 mo/i)).toBeInTheDocument();
  });

  it('renders progress as a percent of the term elapsed', async () => {
    installFetchMock({ 'GET /api/loans': () => LOANS });
    render(<LoansView />);
    // 32% for the mortgage, 65% for the car loan
    expect(await screen.findByText(/32%/)).toBeInTheDocument();
    expect(screen.getByText(/65%/)).toBeInTheDocument();
  });
});

describe('LoansView — payment history', () => {
  const today = new Date();
  const isoDaysAgo = (n: number) => {
    const d = new Date(today); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const loanWithPayments = (overrideDays = 10, count = 2) => ({
    id: 'L1', name: 'Mortgage', principal: 100000, startDate: '2024-01-01',
    termMonths: 120, isPrime: false, isCpiLinked: false, rateValue: 0.04,
    cpiStart: null, currency: 'ILS', excluded: false, notes: null,
    connectionId: 'C1', externalId: '12345678', nameOverridden: false,
    createdAt: '2025-01-01', updatedAt: '2025-01-01',
    rateType: 'fixed' as const,
    state: {
      monthsElapsed: 12, monthsRemaining: 108, annualRate: 0.04,
      monthlyPayment: 1747, outstanding: 92000, totalPaid: 21000,
      progress: 0.1, cpiRatio: 1,
    },
    payments: Array.from({ length: count }, (_, i) => ({
      id: `t${i}`,
      date: isoDaysAgo(overrideDays + i * 30),
      amount: -1747.17,
      accountId: 'a',
      description: 'הלואה',
    })),
  });

  it('renders a Last payment badge when payments exist', async () => {
    installFetchMock({
      'GET /api/loans': () => ({
        loans: [loanWithPayments()],
        rates: { prime: 6, cpiNow: 1 },
      }),
    });
    render(<LoansView />);
    const badge = (await screen.findByText(/last payment/i)).closest('.loan-last-paid')!;
    expect(within(badge as HTMLElement).getByText(/1,?747/)).toBeInTheDocument();
  });

  it('flips to "Possibly missed" when the last payment is older than 35 days', async () => {
    installFetchMock({
      'GET /api/loans': () => ({
        loans: [loanWithPayments(50, 1)],
        rates: { prime: 6, cpiNow: 1 },
      }),
    });
    render(<LoansView />);
    expect(await screen.findByText(/possibly missed/i)).toBeInTheDocument();
  });

  it('does NOT render the badge when payments is empty', async () => {
    const base = loanWithPayments();
    base.payments = [];
    installFetchMock({
      'GET /api/loans': () => ({
        loans: [base],
        rates: { prime: 6, cpiNow: 1 },
      }),
    });
    render(<LoansView />);
    await screen.findByText('Mortgage');
    expect(screen.queryByText(/last payment/i)).not.toBeInTheDocument();
  });

  it('history toggle reveals every linked payment, newest-first', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    installFetchMock({
      'GET /api/loans': () => ({
        loans: [loanWithPayments(10, 3)],
        rates: { prime: 6, cpiNow: 1 },
      }),
    });
    render(<LoansView />);
    await user.click(await screen.findByRole('button', { name: /3 payments/i }));
    const list = await screen.findByTestId('loan-history-L1');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
  });
});
