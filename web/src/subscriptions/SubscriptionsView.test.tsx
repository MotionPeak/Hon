import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SubscriptionsView } from './SubscriptionsView';
import { installFetchMock } from '../test/mockFetch';

const today = new Date();
function daysAgo(n: number): string {
  const d = new Date(today.getTime() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

const ACCOUNT = { id: 'a', connectionId: 'c', companyId: 'hapoalim',
  connectionName: 'Hapoalim', accountNumber: '12345', label: 'Checking',
  balance: 10000, currency: 'ILS', updatedAt: '2026-05-01',
  excluded: false, inceptionDate: null };

const EMPTY_HELPERS = {
  'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
  'GET /api/subscriptions/cancelled': () => ({ cancelled: {} }),
};

function txn(over: Partial<{ id: string; date: string; description: string; amount: number; category: string | null }>) {
  return {
    id: over.id ?? 't', accountId: 'a', externalId: 'x',
    date: over.date ?? daysAgo(10), processedDate: null,
    amount: over.amount ?? -50, currency: 'ILS',
    description: over.description ?? 'Netflix', memo: null,
    kind: null, status: null,
    category: over.category ?? 'Subscriptions', createdAt: '2025-01-01',
  };
}

describe('SubscriptionsView — read-only', () => {
  it('shows the empty state when no Subscriptions txns exist', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({ transactions: [] }),
      ...EMPTY_HELPERS,
    });
    render(<SubscriptionsView />);
    expect(await screen.findByText(/no subscription charges/i)).toBeInTheDocument();
  });

  it('groups active subs (recent charge) under the Active section', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [txn({ id: 't1', description: 'Netflix', date: daysAgo(5), amount: -55 })],
      }),
      ...EMPTY_HELPERS,
    });
    render(<SubscriptionsView />);
    const active = (await screen.findByRole('heading', { name: /active/i }))
      .closest('section')!;
    expect(within(active as HTMLElement).getByText('Netflix')).toBeInTheDocument();
  });

  it('separates "Probably cancelled" subs with last charge > 40 days old', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [txn({ id: 't1', description: 'OldGym', date: daysAgo(120), amount: -200 })],
      }),
      ...EMPTY_HELPERS,
    });
    render(<SubscriptionsView />);
    const lapsed = (await screen.findByRole('heading', { name: /probably cancelled/i }))
      .closest('section')!;
    expect(within(lapsed as HTMLElement).getByText('OldGym')).toBeInTheDocument();
  });

  it('treats yearly-frequency subs as active for ~13 months', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [txn({ id: 't1', description: 'Domain Renewal', date: daysAgo(200), amount: -120 })],
      }),
      ...EMPTY_HELPERS,
      'GET /api/merchant-frequencies': () => ({ frequencies: { 'domain renewal': 'yearly' } }),
    });
    render(<SubscriptionsView />);
    const active = (await screen.findByRole('heading', { name: /active/i }))
      .closest('section')!;
    expect(within(active as HTMLElement).getByText('Domain Renewal')).toBeInTheDocument();
  });

  it('puts user-cancelled subs in the Cancelled section', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [txn({ id: 't1', description: 'Spotify', date: daysAgo(120), amount: -20 })],
      }),
      'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
      'GET /api/subscriptions/cancelled': () => ({
        cancelled: { spotify: daysAgo(60) },
      }),
    });
    render(<SubscriptionsView />);
    const cancelled = (await screen.findByRole('heading', { name: /^cancelled$/i }))
      .closest('section')!;
    expect(within(cancelled as HTMLElement).getByText('Spotify')).toBeInTheDocument();
  });

  it('flags subs with a charge that arrived AFTER the user marked cancelled', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [txn({ id: 't1', description: 'YouTube Premium', date: daysAgo(5), amount: -45 })],
      }),
      'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
      'GET /api/subscriptions/cancelled': () => ({
        cancelled: { 'youtube premium': daysAgo(20) },
      }),
    });
    render(<SubscriptionsView />);
    expect(await screen.findByRole('heading', { name: /charged after/i })).toBeInTheDocument();
    expect(screen.getByText('YouTube Premium')).toBeInTheDocument();
  });

  it('renders the monthly total of active subs', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          txn({ id: 't1', description: 'Netflix', date: daysAgo(5), amount: -55 }),
          txn({ id: 't2', description: 'Disney Plus', date: daysAgo(10), amount: -45 }),
        ],
      }),
      ...EMPTY_HELPERS,
    });
    render(<SubscriptionsView />);
    const summary = await screen.findByTestId('sub-summary');
    // 55 + 45 = 100
    expect(within(summary).getByText(/100/)).toBeInTheDocument();
  });
});

// Suppress unused.
void ACCOUNT;
