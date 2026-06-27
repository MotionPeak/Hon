import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '../test/renderWithProviders';
import { installFetchMock } from '../test/mockFetch';
import { TxnDetailsEditor } from './TxnDetailsEditor';

const txn = { id: 't1', description: 'SHUFERSAL', customTitle: null, notes: null } as any;

describe('TxnDetailsEditor', () => {
  it('PATCHes title + notes on save', async () => {
    const calls: any[] = [];
    installFetchMock({
      'PATCH /api/transactions/t1/details': (body: any) => { calls.push(body); return { ok: true }; },
    });
    render(<TxnDetailsEditor transaction={txn} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/title/i), 'Lunch with Sara');
    await user.type(screen.getByLabelText(/notes/i), 'work trip');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(calls).toContainEqual({ customTitle: 'Lunch with Sara', notes: 'work trip' });
  });

  it('save is disabled until something changes', async () => {
    installFetchMock({ 'PATCH /api/transactions/t1/details': () => ({ ok: true }) });
    render(<TxnDetailsEditor transaction={txn} />);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });
});
