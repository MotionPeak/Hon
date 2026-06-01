import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityView } from './ActivityView';
import { SettingsProvider } from '../settings/useSettings';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';

// Audit M12: a category/umbrella header summed only the dominant-currency rows
// yet the rows below list every currency, so the header understated spend and
// didn't reconcile. The fix renders a secondary "· +$X" badge per non-dominant
// currency. These tests pin that the minority currency now surfaces in the
// HEADER total (not just the row list), and that a single-currency group is
// unchanged (no spurious badge).

const CATEGORIES = {
  categories: [
    { name: 'Coffee', emoji: '☕', color: '#A880ED', catGroup: 'variable', sortOrder: 500, isBuiltin: false, createdAt: '2025-02-02' },
    { name: 'Other', emoji: '▫️', color: '#999EB8', catGroup: 'variable', sortOrder: 999, isBuiltin: true, createdAt: '2025-01-01' },
  ],
};

const ACCOUNTS = {
  accounts: [
    { id: 'a-1', connectionId: 'c-1', companyId: 'hapoalim',
      connectionName: 'Hapoalim', accountNumber: '12345', label: 'Checking',
      balance: 10000, currency: 'ILS', updatedAt: '2026-05-01',
      excluded: false, inceptionDate: null },
  ],
};

const today = new Date();
const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

function txn(id: string, amount: number, currency: string) {
  return {
    id, accountId: 'a-1', externalId: `x-${id}`,
    date: `${thisMonth}-05`, processedDate: null, amount, currency,
    description: `Buy ${id}`, memo: null, kind: null, status: null,
    category: 'Coffee', createdAt: `${thisMonth}-05`,
  };
}

const SPLITWISE_OFF = {
  'GET /api/splitwise/status': () => ({ connected: false, user: null }),
  'GET /api/splitwise/links': () => ({ links: [] as unknown[] }),
};

function baseRoutes(transactions: unknown[]) {
  return {
    'GET /api/transactions': () => ({ transactions }),
    'GET /api/accounts': () => ACCOUNTS,
    'GET /api/categories': () => CATEGORIES,
    'GET /api/merchant-frequencies': () => ({ frequencies: {} as Record<string, string> }),
    ...SPLITWISE_OFF,
  };
}

function renderView() {
  return render(<SettingsProvider><ActivityView /></SettingsProvider>);
}

beforeEach(() => { __resetSplitwiseCache(); });

describe('ActivityView — multi-currency header reconciliation (M12)', () => {
  it('surfaces the non-dominant currency in the category header total', async () => {
    // 3 ILS + 2 USD → dominant is ILS, but USD must still show in the header.
    installFetchMock(baseRoutes([
      txn('i1', -10, 'ILS'), txn('i2', -20, 'ILS'), txn('i3', -30, 'ILS'),
      txn('u1', -5, 'USD'), txn('u2', -7, 'USD'),
    ]));
    renderView();
    const head = await screen.findByRole('heading', { name: /coffee/i });
    // Dominant ILS sum (−₪60) is present…
    expect(head.textContent).toContain('₪60');
    // …and the minority USD total ($12) now appears in the SAME header, so the
    // 5 listed rows reconcile with the displayed totals.
    expect(head.textContent).toContain('$12');
  });

  it('shows no secondary currency badge for a single-currency group', async () => {
    installFetchMock(baseRoutes([
      txn('i1', -10, 'ILS'), txn('i2', -20, 'ILS'),
    ]));
    renderView();
    const head = await screen.findByRole('heading', { name: /coffee/i });
    expect(head.textContent).toContain('₪30');
    expect(head.textContent).not.toContain('$');
    // No stray separator from an empty others list.
    expect(head.querySelector('.cat-total-others')).toBeNull();
  });
});
