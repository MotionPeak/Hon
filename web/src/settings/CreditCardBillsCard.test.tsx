import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreditCardBillsCard } from './CreditCardBillsCard';
import { SettingsProvider } from './useSettings';
import { loadSettings } from './store';

function renderCard() {
  return render(<SettingsProvider><CreditCardBillsCard /></SettingsProvider>);
}

describe('CreditCardBillsCard — hide totals switch', () => {
  it('reflects hideCardTotals on the switch', () => {
    localStorage.setItem('honSettings', JSON.stringify({ hideCardTotals: true }));
    renderCard();
    expect(screen.getByRole('checkbox', { name: /hide card-bill totals/i })).toBeChecked();
  });

  it('persists the toggle', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ hideCardTotals: true }));
    renderCard();
    await user.click(screen.getByRole('checkbox', { name: /hide card-bill totals/i }));
    expect(loadSettings().hideCardTotals).toBe(false);
  });
});

describe('CreditCardBillsCard — brand chips', () => {
  it('renders a toggle chip for every known brand', () => {
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: [] }));
    renderCard();
    ['Max', 'Isracard', 'Cal / Visa Cal', 'American Express', 'Leumi Card', 'Diners']
      .forEach((n) => expect(screen.getByRole('button', { name: n })).toBeInTheDocument());
  });

  it('shows a brand chip as pressed only when ALL of its terms are in cardProviders', () => {
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: ['max', 'מקס'] }));
    renderCard();
    expect(screen.getByRole('button', { name: 'Max' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Isracard' }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('does NOT light a brand chip when only some of its terms are present', () => {
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: ['cal'] }));
    renderCard();
    // Cal expands to ['cal', 'כאל', 'ויזה כאל'] — one term present, brand stays off.
    expect(screen.getByRole('button', { name: 'Cal / Visa Cal' }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking an off brand adds all of its terms', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: [] }));
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Isracard' }));
    const stored = loadSettings().cardProviders;
    expect(stored).toEqual(expect.arrayContaining(['isracard', 'ישראכרט']));
    expect(screen.getByRole('button', { name: 'Isracard' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking an on brand removes all of its terms', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: ['max', 'מקס', 'mine'] }));
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Max' }));
    const stored = loadSettings().cardProviders;
    expect(stored).not.toContain('max');
    expect(stored).not.toContain('מקס');
    expect(stored).toContain('mine');
  });
});

describe('CreditCardBillsCard — custom matchers', () => {
  it('renders any non-catalog term as a removable custom chip', () => {
    localStorage.setItem('honSettings', JSON.stringify({
      cardProviders: ['max', 'מקס', 'mybank-card'],
    }));
    renderCard();
    expect(screen.getByText('mybank-card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove mybank-card/i })).toBeInTheDocument();
    // Catalog terms must not render as custom chips.
    expect(screen.queryByRole('button', { name: /remove max/i })).not.toBeInTheDocument();
  });

  it('clicking the × on a custom chip removes that term', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: ['custom1', 'custom2'] }));
    renderCard();
    await user.click(screen.getByRole('button', { name: /remove custom1/i }));
    expect(loadSettings().cardProviders).toEqual(['custom2']);
  });

  it('pressing Enter in the input adds a new custom term', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: [] }));
    renderCard();
    const input = screen.getByPlaceholderText(/type a substring/i);
    await user.type(input, 'newbank{Enter}');
    expect(loadSettings().cardProviders).toEqual(['newbank']);
    expect(screen.getByText('newbank')).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('does not double-add a term that already exists (case-insensitive)', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: ['NewBank'] }));
    renderCard();
    await user.type(screen.getByPlaceholderText(/type a substring/i), 'newbank{Enter}');
    expect(loadSettings().cardProviders).toEqual(['NewBank']);
  });

  it('ignores empty / whitespace-only input', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: ['existing'] }));
    renderCard();
    await user.type(screen.getByPlaceholderText(/type a substring/i), '   {Enter}');
    expect(loadSettings().cardProviders).toEqual(['existing']);
  });
});

