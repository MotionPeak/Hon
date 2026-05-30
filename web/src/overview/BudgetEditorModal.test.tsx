import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installFetchMock } from '../test/mockFetch';
import { BudgetEditorModal } from './BudgetEditorModal';
import type { Category } from '../settings/CategoriesPanel';
import type { VariableInput } from './projectedVariable';
import type { BudgetLine } from './BudgetCard';

const categories = [
  { name: 'Groceries', emoji: '🛒', color: '#f00', catGroup: 'essential', sortOrder: 1 },
  { name: 'Transport', emoji: '🚌', color: '#0f0', catGroup: 'essential', sortOrder: 2 },
  { name: 'Salary', emoji: '💰', color: '#0a0', catGroup: 'income', sortOrder: 3 },
] as unknown as Category[];

const essentials: BudgetLine[] = [{ category: 'Groceries', budget: 1500, spent: 2000 }];
const variable: VariableInput = {
  income: 10000, spent: 1000, essentialSpent: 2000,
  fixedSpent: 3000, piggyFunded: 0, savings: 0,
};

function seedRoutes(extra: Record<string, (b: unknown) => unknown> = {}) {
  return installFetchMock({
    'GET /api/budget/income-override': () => ({ value: null }),
    'GET /api/budget/savings': () => ({ savings: {} }),
    ...extra,
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('BudgetEditorModal', () => {
  it('shows an input row for each essential category, not for income/fixed', async () => {
    seedRoutes();
    render(
      <BudgetEditorModal
        essentials={essentials} categories={categories} variable={variable}
        predictedFixed={3500} currency="ILS" monthStartDay={1}
        onClose={vi.fn()} onSaved={vi.fn()}
      />,
    );
    await waitFor(() => expect(window.fetch).toHaveBeenCalledTimes(2));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Groceries')).toBeInTheDocument();
    expect(within(dialog).getByText('Transport')).toBeInTheDocument();
    // Income category is not an editable essential row.
    expect(within(dialog).queryByText('Salary')).not.toBeInTheDocument();
    // Current Groceries limit is pre-filled.
    expect(within(dialog).getByDisplayValue('1500')).toBeInTheDocument();
  });

  it('PUTs only changed essential limits and calls onSaved + onClose', async () => {
    const puts: Array<{ category?: string; monthlyAmount?: number }> = [];
    seedRoutes({
      'PUT /api/budgets': (b) => { puts.push(b as { category?: string }); return { ok: true }; },
    });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <BudgetEditorModal
        essentials={essentials} categories={categories} variable={variable}
        predictedFixed={3500} currency="ILS" monthStartDay={1}
        onClose={onClose} onSaved={onSaved}
      />,
    );
    await waitFor(() => expect(window.fetch).toHaveBeenCalledTimes(2));

    const dialog = screen.getByRole('dialog');
    const grocRow = within(dialog).getByText('Groceries').closest('.bm-row') as HTMLElement;
    fireEvent.change(within(grocRow).getByRole('spinbutton'), { target: { value: '1800' } });
    fireEvent.click(screen.getByRole('button', { name: /Save budgets/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    // Only the edited category was persisted (Transport was untouched).
    expect(puts).toEqual([{ category: 'Groceries', monthlyAmount: 1800 }]);
  });

  it('Max fills the savings reserve with the remaining room', async () => {
    seedRoutes();
    render(
      <BudgetEditorModal
        essentials={essentials} categories={categories} variable={variable}
        predictedFixed={3500} currency="ILS" monthStartDay={1}
        onClose={vi.fn()} onSaved={vi.fn()}
      />,
    );
    await waitFor(() => expect(window.fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    // Room = income 10000 − fixed 3500 − essentialReserve max(1500,2000)=2000
    //        − piggy 0 − variable spent 1000 = 3500.
    expect(screen.getByDisplayValue('3500')).toBeInTheDocument();
  });
});
