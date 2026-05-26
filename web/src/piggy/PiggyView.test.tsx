import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PiggyView } from './PiggyView';
import { installFetchMock } from '../test/mockFetch';

const REPORT = {
  piggy: {
    month: '2026-05',
    banks: [
      {
        id: 'p-1', name: 'Japan trip', emoji: '✈️', kind: 'monthly',
        targetAmount: 12000, monthlyAmount: 1000, currency: 'ILS',
        saved: 5000, remaining: 7000, progress: 5000 / 12000,
        complete: false, onHold: false,
        thisMonth: { amount: 1000, status: 'funded' },
        monthsLeft: 7,
      },
      {
        id: 'p-2', name: 'Emergency fund', emoji: '🛟', kind: 'monthly',
        targetAmount: 30000, monthlyAmount: 500, currency: 'ILS',
        saved: 30000, remaining: 0, progress: 1,
        complete: true, onHold: false,
        thisMonth: { amount: 0, status: 'complete' },
        monthsLeft: 0,
      },
      {
        id: 'p-3', name: 'New laptop', emoji: '💻', kind: 'monthly',
        targetAmount: 8000, monthlyAmount: 800, currency: 'ILS',
        saved: 1600, remaining: 6400, progress: 0.2,
        complete: false, onHold: false,
        thisMonth: { amount: 0, status: 'skipped' },
        monthsLeft: 8,
      },
      {
        id: 'p-4', name: 'Camera kit', emoji: '📷', kind: 'monthly',
        targetAmount: 5000, monthlyAmount: 400, currency: 'ILS',
        saved: 800, remaining: 4200, progress: 0.16,
        complete: false, onHold: true,
        thisMonth: { amount: 0, status: 'onhold' },
        monthsLeft: 11,
      },
    ],
    fundedTotal: 1000,
    headroom: 3500,
    projected: true,
  },
  currency: 'ILS',
};

const EMPTY_REPORT = {
  piggy: {
    month: '2026-05', banks: [], fundedTotal: 0, headroom: 0, projected: false,
  },
  currency: 'ILS',
};

describe('PiggyView — read-only', () => {
  it('shows the empty state when there are no piggy banks', async () => {
    installFetchMock({ 'GET /api/budget': () => EMPTY_REPORT });
    render(<PiggyView />);
    expect(await screen.findByText(/no piggy banks yet/i)).toBeInTheDocument();
  });

  it('renders each piggy bank by name + emoji', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    expect(await screen.findByText('Japan trip')).toBeInTheDocument();
    expect(screen.getByText('Emergency fund')).toBeInTheDocument();
    expect(screen.getByText('New laptop')).toBeInTheDocument();
    // Emoji renders inside the card.
    expect(screen.getByText('✈️')).toBeInTheDocument();
  });

  it('renders the progress percent for each bank', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    // Japan trip: 5000/12000 = ~42%
    expect(await screen.findByText('42%')).toBeInTheDocument();
    // Emergency fund complete: 100%
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('shows a "Goal reached" badge on completed banks', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    const emergency = (await screen.findByText('Emergency fund')).closest('.piggy-card')!;
    expect(within(emergency as HTMLElement).getByText(/goal reached/i)).toBeInTheDocument();
  });

  it('shows a "Paused" / "On hold" badge on appropriate banks', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    const laptop = (await screen.findByText('New laptop')).closest('.piggy-card')!;
    expect(within(laptop as HTMLElement).getByText(/doesn'?t fit/i)).toBeInTheDocument();
    const camera = (await screen.findByText('Camera kit')).closest('.piggy-card')!;
    expect(within(camera as HTMLElement).getByText(/on hold/i)).toBeInTheDocument();
  });

  it('renders the headroom strip with the funded total + saving room', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    const strip = await screen.findByTestId('piggy-headroom');
    expect(within(strip).getByText(/3,?500/)).toBeInTheDocument();
    // Funded total this month
    expect(within(strip).getByText(/1,?000/)).toBeInTheDocument();
  });
});
