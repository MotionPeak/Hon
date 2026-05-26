import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BillingCycleCard } from './BillingCycleCard';
import { SettingsProvider } from './useSettings';
import { loadSettings } from './store';

function renderCard() {
  return render(<SettingsProvider><BillingCycleCard /></SettingsProvider>);
}

describe('BillingCycleCard', () => {
  it('renders with the saved monthStartDay as the trigger label', () => {
    localStorage.setItem('honSettings', JSON.stringify({ monthStartDay: 10 }));
    renderCard();
    expect(screen.getByRole('button', { name: /10th/i })).toBeInTheDocument();
  });

  it('defaults to "Calendar month — 1st" when nothing is saved', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /calendar month/i })).toBeInTheDocument();
  });

  it('opens a listbox of day options when the trigger is clicked', async () => {
    const user = userEvent.setup();
    renderCard();
    const trigger = screen.getByRole('button', { name: /calendar month/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(trigger);
    const list = screen.getByRole('listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const labels = ['Calendar month — 1st', '2nd', '5th', '10th', '15th', '20th', '25th'];
    labels.forEach((l) =>
      expect(within(list).getByRole('option', { name: l })).toBeInTheDocument(),
    );
  });

  it('picking an option updates settings, closes the menu, and updates the trigger label', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: /calendar month/i }));
    await user.click(screen.getByRole('option', { name: '15th' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /15th/i })).toBeInTheDocument();
    expect(loadSettings().monthStartDay).toBe(15);
  });

  it('marks the active option with aria-selected', async () => {
    localStorage.setItem('honSettings', JSON.stringify({ monthStartDay: 20 }));
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: /20th/i }));
    expect(screen.getByRole('option', { name: '20th' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: '10th' })).toHaveAttribute('aria-selected', 'false');
  });

  it('closes the menu when clicking outside', async () => {
    const user = userEvent.setup();
    render(
      <SettingsProvider>
        <BillingCycleCard />
        <button type="button">outside</button>
      </SettingsProvider>,
    );
    await user.click(screen.getByRole('button', { name: /calendar month/i }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
