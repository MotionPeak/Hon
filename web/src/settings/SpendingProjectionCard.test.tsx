import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpendingProjectionCard } from './SpendingProjectionCard';
import { SettingsProvider } from './useSettings';
import { loadSettings } from './store';

function renderCard() {
  return render(<SettingsProvider><SpendingProjectionCard /></SettingsProvider>);
}

describe('SpendingProjectionCard', () => {
  it('reflects projectRecurring from settings on the switch', () => {
    localStorage.setItem('honSettings', JSON.stringify({ projectRecurring: true }));
    renderCard();
    expect(screen.getByRole('checkbox', { name: /project recurring/i })).toBeChecked();
  });

  it('shows the switch unchecked when projectRecurring is false', () => {
    localStorage.setItem('honSettings', JSON.stringify({ projectRecurring: false }));
    renderCard();
    expect(screen.getByRole('checkbox', { name: /project recurring/i })).not.toBeChecked();
  });

  it('toggling the switch persists the new projectRecurring value', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ projectRecurring: true }));
    renderCard();
    await user.click(screen.getByRole('checkbox', { name: /project recurring/i }));
    expect(loadSettings().projectRecurring).toBe(false);
    expect(screen.getByRole('checkbox', { name: /project recurring/i })).not.toBeChecked();
  });

  it('renders an income-average segmented control with the active month pressed', () => {
    localStorage.setItem('honSettings', JSON.stringify({ incomeAvgMonths: 3 }));
    renderCard();
    [1, 2, 3, 6].forEach((n) =>
      expect(screen.getByRole('button', { name: String(n) })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('picking an income-average month persists incomeAvgMonths', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ incomeAvgMonths: 3 }));
    renderCard();
    await user.click(screen.getByRole('button', { name: '6' }));
    expect(loadSettings().incomeAvgMonths).toBe(6);
    expect(screen.getByRole('button', { name: '6' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'false');
  });
});
