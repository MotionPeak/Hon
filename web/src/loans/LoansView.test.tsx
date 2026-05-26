import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LoansView } from './LoansView';
import { installFetchMock } from '../test/mockFetch';

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
