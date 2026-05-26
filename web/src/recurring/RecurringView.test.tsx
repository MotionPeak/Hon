import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RecurringView } from './RecurringView';
import { SettingsProvider } from '../settings/useSettings';
import { installFetchMock } from '../test/mockFetch';

const today = new Date();
const month = (offset = 0) => {
  const d = new Date(today.getFullYear(), today.getMonth() + offset, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const CATEGORIES = {
  categories: [
    { name: 'Housing', emoji: '🏠', color: '#5C9EF5', catGroup: 'fixed', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Utilities', emoji: '💡', color: '#F2C752', catGroup: 'fixed', sortOrder: 200, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Subscriptions', emoji: '🔁', color: '#A880ED', catGroup: 'fixed', sortOrder: 300, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Groceries', emoji: '🛒', color: '#5CC773', catGroup: 'essential', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Other', emoji: '▫️', color: '#999EB8', catGroup: 'variable', sortOrder: 999, isBuiltin: true, createdAt: '2025-01-01' },
  ],
};

const EMPTY_HELPERS = {
  'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
  'GET /api/category-splits': () => ({ splits: {} }),
  'GET /api/subscriptions/cancelled': () => ({ cancelled: {} }),
};

function renderView() {
  return render(<SettingsProvider><RecurringView /></SettingsProvider>);
}

describe('RecurringView — read-only', () => {
  it('shows the empty state when no recurring merchants are detected', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({ transactions: [] }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    expect(await screen.findByText(/no recurring fixed bills/i)).toBeInTheDocument();
  });

  it('detects merchants that appear in 2+ cycles under a fixed category', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent דירה', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(-1)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent דירה', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    expect(await screen.findByText(/Rent/)).toBeInTheDocument();
    // 4000/mo appears in the merchant row + section total + grand total.
    expect(screen.getAllByText(/4,?000/).length).toBeGreaterThanOrEqual(1);
  });

  it('skips merchants that appear in only one cycle without a user frequency', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(0)}-10`,
            processedDate: null, amount: -250, currency: 'ILS',
            description: 'One-off thing', memo: null, kind: null, status: null,
            category: 'Utilities', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    expect(await screen.findByText(/no recurring fixed bills/i)).toBeInTheDocument();
  });

  it('includes a single-cycle merchant when the user set a frequency on it', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(0)}-10`,
            processedDate: null, amount: -1200, currency: 'ILS',
            description: 'Insurance Premium', memo: null, kind: null, status: null,
            category: 'Utilities', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
      'GET /api/merchant-frequencies': () => ({
        // monthlyEquivalent of 1200 yearly = 100
        frequencies: { 'insurance premium': 'yearly' },
      }),
    });
    renderView();
    expect(await screen.findByText(/Insurance Premium/)).toBeInTheDocument();
    // 1200 / 12 = 100/mo — appears in per-row + section + grand total.
    expect(screen.getAllByText(/100\b/).length).toBeGreaterThanOrEqual(1);
  });

  it('excludes merchants flagged ignore', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-1)}-10`,
            processedDate: null, amount: -200, currency: 'ILS',
            description: 'Gym', memo: null, kind: null, status: null,
            category: 'Subscriptions', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(0)}-10`,
            processedDate: null, amount: -200, currency: 'ILS',
            description: 'Gym', memo: null, kind: null, status: null,
            category: 'Subscriptions', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
      'GET /api/merchant-frequencies': () => ({ frequencies: { gym: 'ignore' } }),
    });
    renderView();
    expect(await screen.findByText(/no recurring fixed bills/i)).toBeInTheDocument();
  });

  it('renders merchants grouped under their category', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(-1)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't3', accountId: 'a', externalId: 'x3', date: `${month(-2)}-10`,
            processedDate: null, amount: -350, currency: 'ILS',
            description: 'Electric', memo: null, kind: null, status: null,
            category: 'Utilities', createdAt: '2025-01-01' },
          { id: 't4', accountId: 'a', externalId: 'x4', date: `${month(-1)}-10`,
            processedDate: null, amount: -350, currency: 'ILS',
            description: 'Electric', memo: null, kind: null, status: null,
            category: 'Utilities', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    expect(await screen.findByRole('heading', { name: /housing/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /utilities/i })).toBeInTheDocument();
  });

  it('shows a grand total of all monthly-equivalent figures', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', accountId: 'a', externalId: 'x1', date: `${month(-2)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
          { id: 't2', accountId: 'a', externalId: 'x2', date: `${month(-1)}-15`,
            processedDate: null, amount: -4000, currency: 'ILS',
            description: 'Rent', memo: null, kind: null, status: null,
            category: 'Housing', createdAt: '2025-01-01' },
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
      ...EMPTY_HELPERS,
    });
    renderView();
    const strip = await screen.findByTestId('recurring-total');
    expect(within(strip).getByText(/4,?000/)).toBeInTheDocument();
  });
});
