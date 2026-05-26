import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { VouchersView } from './VouchersView';
import { installFetchMock } from '../test/mockFetch';

function fixture(over: Partial<{ vouchers: Array<Partial<{ id: string; name: string; provider: string; balance: number; currency: string; expiresOn: string | null; notes: string | null; excluded: boolean; connectionId: string | null; externalId: string | null; nameOverridden: boolean; createdAt: string; updatedAt: string; }>> }> = {}): {
  vouchers: Array<{ id: string; name: string; provider: string; balance: number; currency: string; expiresOn: string | null; notes: string | null; excluded: boolean; connectionId: string | null; externalId: string | null; nameOverridden: boolean; createdAt: string; updatedAt: string; }>;
} {
  const base = [
    { id: 'v-1', name: 'Tav HaZahav', provider: 'Shufersal', balance: 250,
      currency: 'ILS', expiresOn: '2027-12-31', notes: null, excluded: false,
      connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2026-05-26' },
    { id: 'v-2', name: 'BuyMe ALL - מגוון אדיר במתנה אחת', provider: 'BuyMe',
      balance: 100, currency: 'ILS', expiresOn: '2026-06-15', notes: 'Birthday gift',
      excluded: false, connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2026-05-26' },
    { id: 'v-3', name: 'Old voucher', provider: 'Cibus', balance: 50,
      currency: 'ILS', expiresOn: '2026-05-01', notes: null, excluded: false,
      connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2026-05-26' },
    { id: 'v-4', name: 'Excluded voucher', provider: 'Other', balance: 999,
      currency: 'ILS', expiresOn: null, notes: null, excluded: true,
      connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2026-05-26' },
  ];
  return { vouchers: over.vouchers as any ?? base };
}

describe('VouchersView — read-only', () => {
  it('shows the empty state when there are no vouchers', async () => {
    installFetchMock({ 'GET /api/vouchers': () => ({ vouchers: [] }) });
    render(<VouchersView />);
    expect(await screen.findByText(/no vouchers yet/i)).toBeInTheDocument();
  });

  it('renders each voucher card with name, provider, balance, and currency', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByText('Tav HaZahav')).toBeInTheDocument();
    // BuyMe titles split on " - " into headline + description.
    expect(screen.getByText('BuyMe ALL')).toBeInTheDocument();
    expect(screen.getByText(/מגוון אדיר במתנה אחת/)).toBeInTheDocument();
    // Provider labels.
    expect(screen.getByText(/Shufersal/i)).toBeInTheDocument();
    expect(screen.getAllByText(/BuyMe/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders a per-currency total strip excluding excluded vouchers', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    const strip = await screen.findByTestId('voucher-totals');
    // 250 + 100 + 50 = 400 (excludes the 999 excluded one).
    expect(within(strip).getByText(/400/)).toBeInTheDocument();
  });

  it('marks expired vouchers with an expired badge', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });

  it('renders the expiry date for vouchers that expire later', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByText(/2027-12-31/)).toBeInTheDocument();
  });

  it('renders the notes when present', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByText('Birthday gift')).toBeInTheDocument();
  });
});
