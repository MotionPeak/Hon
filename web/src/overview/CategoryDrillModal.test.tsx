import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CategoryDrillModal } from './CategoryDrillModal';
import { currentCycleKey, prevCycleKey } from '../cycle';
import type { Transaction } from '../activity/types';
import type { Account } from '../accounts/types';

const cur = currentCycleKey(1);
const prev = prevCycleKey(cur);

let seq = 0;
function txn(over: Partial<Transaction>): Transaction {
  return {
    id: `t${seq++}`, accountId: 'a1', externalId: 'e', date: `${cur}-15`,
    processedDate: null, amount: -100, currency: 'ILS', description: 'Charge',
    memo: null, kind: null, status: null, category: 'Groceries', createdAt: '',
    ...over,
  };
}

const accounts = [{ id: 'a1', connectionName: 'Hapoalim', label: 'Checking' } as Account];
const noExclude = (): boolean => false;

function renderModal(
  transactions: Transaction[],
  onClose = vi.fn(),
  isExcluded: (t: Transaction) => boolean = noExclude,
) {
  render(
    <CategoryDrillModal
      category="Groceries" color="#ff0000" emoji="🛒"
      transactions={transactions} accounts={accounts}
      monthStartDay={1} isExcluded={isExcluded} currency="ILS" onClose={onClose}
    />,
  );
  return onClose;
}

describe('CategoryDrillModal', () => {
  it('lists only this category\'s cycle expenses, newest first, with the total', () => {
    renderModal([
      txn({ description: 'Rami Levy', amount: -100, date: `${cur}-15` }),
      txn({ description: 'Shufersal', amount: -50, date: `${cur}-20` }),
      txn({ description: 'Bus', amount: -30, category: 'Transport' }),
      txn({ description: 'Refund', amount: 200, category: 'Groceries' }),
      txn({ description: 'Old groceries', amount: -100, date: `${prev}-15` }),
    ]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Groceries')).toBeInTheDocument();
    expect(within(dialog).getByText(/2 transactions/)).toBeInTheDocument();
    expect(within(dialog).getByText('Rami Levy')).toBeInTheDocument();
    expect(within(dialog).getByText('Shufersal')).toBeInTheDocument();
    expect(within(dialog).queryByText('Bus')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Old groceries')).not.toBeInTheDocument();
    // Total = 150; header shows it.
    expect(within(dialog).getByText(/150/)).toBeInTheDocument();
    // Newest first: Shufersal (the 20th) renders before Rami Levy (the 15th).
    const names = within(dialog).getAllByText(/Rami Levy|Shufersal/).map((n) => n.textContent);
    expect(names).toEqual(['Shufersal', 'Rami Levy']);
  });

  it('drops card-bill / excluded rows', () => {
    renderModal(
      [txn({ description: 'Card bill', amount: -500 })],
      vi.fn(),
      (t) => (t.description ?? '').includes('Card bill'),
    );
    expect(screen.getByText(/No transactions in this category/)).toBeInTheDocument();
  });

  it('Done closes the modal', () => {
    const onClose = renderModal([txn({})]);
    fireEvent.click(screen.getByText('Done'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
