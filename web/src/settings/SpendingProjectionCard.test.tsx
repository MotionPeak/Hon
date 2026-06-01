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
});
