import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsView } from './SettingsView';
import { SettingsProvider } from './useSettings';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { __resetVaultCache } from '../vault/useVault';

// SettingsView mounts SplitwiseCard, whose useSplitwise hook fetches on mount —
// stub those routes so the shared mock doesn't throw "unmocked fetch".
const splitwiseRoutes = {
  'GET /api/splitwise/status': () => ({ connected: false, user: null }),
  'GET /api/splitwise/links': () => ({ links: [] }),
};

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); __resetVaultCache(); });

// SettingsView no longer carries its own provider (it relies on the app-level
// one), so tests supply it.
function renderView() {
  return render(<SettingsProvider><SettingsView /></SettingsProvider>);
}

describe('SettingsView', () => {
  it('renders the page heading + intro', () => {
    installFetchMock({ 'GET /api/categories': () => ({ categories: [] }), ...splitwiseRoutes });
    renderView();
    expect(screen.getByRole('heading', { level: 1, name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText(/changes save as you make them/i)).toBeInTheDocument();
  });

  it('renders all settings cards, with the Vault card first', async () => {
    installFetchMock({
      'GET /api/categories': () => ({ categories: [] }),
      'GET /api/vault/status': () => ({ exists: false, unlocked: false }),
      ...splitwiseRoutes,
    });
    renderView();
    await screen.findByText('🔒 Vault');
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      '🔒 Vault', 'AI engine', 'Billing cycle', 'Spending projection',
      'Category averages', 'Credit-card bills', 'Splitwise', 'Categories',
    ]);
  });
});
