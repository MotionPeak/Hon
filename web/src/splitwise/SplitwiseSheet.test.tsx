import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SplitwiseSheet } from './SplitwiseSheet';
import type { SplitwisePickList } from './types';
import type { Transaction } from '../activity/types';

const txn = {
  id: 't1', description: 'Dinner', amount: -100, currency: 'ILS', date: '2026-05-10',
} as unknown as Transaction;

const pickList: SplitwisePickList = {
  me: { id: 1, name: 'Me' },
  friends: [{ id: 2, name: 'Roomie' }],
  groups: [{ id: 9, name: 'Flat', members: [
    { id: 1, name: 'Me' }, { id: 2, name: 'Roomie' }, { id: 3, name: 'Sam' },
  ] }],
};

afterEach(() => vi.restoreAllMocks());

function setup(overrides: Partial<Parameters<typeof SplitwiseSheet>[0]> = {}) {
  const onCreate = vi.fn(async () => {});
  const loadPickList = vi.fn(async () => pickList);
  render(
    <SplitwiseSheet
      open transaction={txn} loadPickList={loadPickList}
      onCreate={onCreate} onClose={() => {}} {...overrides}
    />,
  );
  return { onCreate, loadPickList };
}

describe('SplitwiseSheet', () => {
  it('friend flow defaults owed to half and creates with one share', async () => {
    const { onCreate } = setup();
    await userEvent.click(await screen.findByText('🧑 Roomie'));
    const owed = await screen.findByLabelText(/owe you/i) as HTMLInputElement;
    expect(owed.value).toBe('50.00');
    await userEvent.click(screen.getByRole('button', { name: /add to splitwise/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      null, [{ userId: 2, name: 'Roomie', owed: 50 }],
    ));
  });

  it('group flow splits equally among ticked members + you', async () => {
    const { onCreate } = setup();
    await userEvent.click(await screen.findByText('👥 Flat'));
    // Both other members ticked by default → split 3 ways → 33.333…
    await userEvent.click(await screen.findByRole('button', { name: /add to splitwise/i }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
      const [groupId, shares] =
        onCreate.mock.calls[0] as unknown as [number, { owed: number }[]];
      expect(groupId).toBe(9);
      expect(shares).toHaveLength(2);
      expect(shares[0].owed).toBeCloseTo(100 / 3, 5);
    });
  });

  it('friend flow rejects an owed amount over the cost', async () => {
    const { onCreate } = setup();
    await userEvent.click(await screen.findByText('🧑 Roomie'));
    const owed = await screen.findByLabelText(/owe you/i);
    await userEvent.clear(owed);
    await userEvent.type(owed, '150');
    await userEvent.click(screen.getByRole('button', { name: /add to splitwise/i }));
    expect(await screen.findByText(/more than the expense/i)).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
