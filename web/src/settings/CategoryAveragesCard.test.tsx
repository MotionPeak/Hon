import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CategoryAveragesCard } from './CategoryAveragesCard';
import { SettingsProvider } from './useSettings';
import { loadSettings } from './store';

function renderCard() {
  return render(<SettingsProvider><CategoryAveragesCard /></SettingsProvider>);
}

describe('CategoryAveragesCard', () => {
  beforeEach(() => localStorage.clear());

  it('renders the preset buttons with the active one pressed', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 12 }));
    renderCard();
    ['3', '6', '12', '24'].forEach((n) =>
      expect(screen.getByRole('button', { name: n })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '12' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '6' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('picking a preset persists spendingAvgMonths', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 12 }));
    renderCard();
    await user.click(screen.getByRole('button', { name: '6' }));
    expect(loadSettings().spendingAvgMonths).toBe(6);
    expect(screen.getByRole('button', { name: '6' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '12' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks Custom active and shows the number input for a non-preset value', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    renderCard();
    expect(screen.getByRole('button', { name: /custom/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('spinbutton', { name: /custom months/i })).toHaveValue(9);
  });

  it('does not show the input when a preset is active', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 12 }));
    renderCard();
    expect(screen.queryByRole('spinbutton', { name: /custom months/i })).not.toBeInTheDocument();
  });

  it('clicking Custom reveals the input prefilled with the current value', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 12 }));
    renderCard();
    await user.click(screen.getByRole('button', { name: /custom/i }));
    expect(screen.getByRole('spinbutton', { name: /custom months/i })).toHaveValue(12);
  });

  it('typing a custom number persists it', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    renderCard();
    const input = screen.getByRole('spinbutton', { name: /custom months/i });
    await user.clear(input);
    await user.type(input, '18');
    expect(loadSettings().spendingAvgMonths).toBe(18);
  });

  it('ignores a custom number above the 120-month cap', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    renderCard();
    const input = screen.getByRole('spinbutton', { name: /custom months/i });
    fireEvent.change(input, { target: { value: '999' } });
    expect(loadSettings().spendingAvgMonths).toBe(9);
  });

  it('ignores a cleared/zero input and keeps the last valid value', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    renderCard();
    const input = screen.getByRole('spinbutton', { name: /custom months/i });
    await user.clear(input);
    expect(loadSettings().spendingAvgMonths).toBe(9);
  });
});
