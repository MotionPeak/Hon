import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HistoryMonthsSelect } from './HistoryMonthsSelect';

describe('HistoryMonthsSelect', () => {
  it('renders the current value in the trigger', () => {
    render(<HistoryMonthsSelect value={12} onChange={() => {}} />);
    expect(screen.getByLabelText(/history months/i)).toHaveTextContent('12 mo');
  });

  it('opens a menu listing all five options', async () => {
    const user = userEvent.setup();
    render(<HistoryMonthsSelect value={12} onChange={() => {}} />);
    await user.click(screen.getByLabelText(/history months/i));
    for (const n of [3, 6, 12, 18, 24]) {
      expect(await screen.findByRole('menuitem', { name: `${n} mo` })).toBeInTheDocument();
    }
  });

  it('fires onChange with the chosen number of months', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HistoryMonthsSelect value={12} onChange={onChange} />);
    await user.click(screen.getByLabelText(/history months/i));
    await user.click(await screen.findByRole('menuitem', { name: '24 mo' }));
    expect(onChange).toHaveBeenCalledWith(24);
  });

  it('marks the active option', async () => {
    const user = userEvent.setup();
    render(<HistoryMonthsSelect value={6} onChange={() => {}} />);
    await user.click(screen.getByLabelText(/history months/i));
    expect(await screen.findByRole('menuitem', { name: '6 mo' })).toHaveAttribute('data-active', 'true');
  });
});
