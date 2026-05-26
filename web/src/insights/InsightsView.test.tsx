import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InsightsView } from './InsightsView';
import { SettingsProvider } from '../settings/useSettings';
import { installFetchMock } from '../test/mockFetch';

const today = new Date();
const month = (offset = 0) => {
  const d = new Date(today.getFullYear(), today.getMonth() + offset, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const CATEGORIES = {
  categories: [
    { name: 'Groceries', emoji: '🛒', color: '#5CC773', catGroup: 'essential', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Dining', emoji: '🍽️', color: '#F59942', catGroup: 'essential', sortOrder: 110, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Salary', emoji: '💰', color: '#5CC773', catGroup: 'income', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Other', emoji: '▫️', color: '#999EB8', catGroup: 'variable', sortOrder: 999, isBuiltin: true, createdAt: '2025-01-01' },
  ],
};

function tx(over: Partial<{ id: string; date: string; amount: number; description: string; category: string }>) {
  return {
    id: over.id ?? 't', accountId: 'a', externalId: 'x',
    date: over.date ?? `${month(0)}-15`, processedDate: null,
    amount: over.amount ?? -100, currency: 'ILS',
    description: over.description ?? 'Shop', memo: null,
    kind: null, status: null,
    category: over.category ?? 'Groceries', createdAt: '2025-01-01',
  };
}

function renderView() {
  return render(<SettingsProvider><InsightsView /></SettingsProvider>);
}

describe('InsightsView — Spending sub-tab', () => {
  it('shows the empty state when there is no spending or income', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({ transactions: [] }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    expect(await screen.findByText(/no analytics yet/i)).toBeInTheDocument();
  });

  it('renders 12 month bars + a "Spending" chart label', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [tx({ id: 't1', amount: -250 })],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    expect(await screen.findByText(/^Spending$/)).toBeInTheDocument();
    const bars = screen.getAllByRole('button', { name: /spending|no spending/i });
    expect(bars.length).toBe(12);
  });

  it('selects the current month by default and shows its breakdown', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 't1', amount: -250, category: 'Groceries', date: `${month(0)}-10` }),
          tx({ id: 't2', amount: -120, category: 'Dining', date: `${month(0)}-15` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    // Month detail header should show this month.
    const monthLabel = new Date(today.getFullYear(), today.getMonth(), 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    expect(await screen.findByRole('heading', { name: new RegExp(monthLabel, 'i') }))
      .toBeInTheDocument();
    // Category rows.
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
  });

  it('clicking a bar selects that month and the breakdown updates', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 't1', amount: -250, category: 'Groceries', date: `${month(0)}-10` }),
          tx({ id: 't2', amount: -1000, category: 'Dining', date: `${month(-2)}-10` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    await screen.findByText('Groceries');
    // Find the bar for month(-2) by its data-month attribute.
    const targetKey = month(-2);
    const bar = document.querySelector(`[data-month="${targetKey}"]`) as HTMLElement | null;
    expect(bar).not.toBeNull();
    await user.click(bar!);
    expect(await screen.findByText('Dining')).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  it('shows a "spent" total at the top of the month detail card', async () => {
    installFetchMock({
      'GET /api/transactions': () => ({
        transactions: [
          tx({ id: 't1', amount: -250, category: 'Groceries', date: `${month(0)}-10` }),
          tx({ id: 't2', amount: -120, category: 'Dining', date: `${month(0)}-15` }),
        ],
      }),
      'GET /api/categories': () => CATEGORIES,
    });
    renderView();
    const detail = await screen.findByTestId('month-detail');
    expect(within(detail).getByText(/370/)).toBeInTheDocument();
  });
});
