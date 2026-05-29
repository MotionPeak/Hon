import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsView } from './SettingsView';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';

// SettingsView mounts SplitwiseCard, whose useSplitwise hook fetches on mount —
// stub those routes so the shared mock doesn't throw "unmocked fetch".
const splitwiseRoutes = {
  'GET /api/splitwise/status': () => ({ connected: false, user: null }),
  'GET /api/splitwise/links': () => ({ links: [] }),
};

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); });

describe('SettingsView', () => {
  it('renders the page heading + intro', () => {
    installFetchMock({ 'GET /api/categories': () => ({ categories: [] }), ...splitwiseRoutes });
    render(<SettingsView />);
    expect(screen.getByRole('heading', { level: 1, name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText(/changes save as you make them/i)).toBeInTheDocument();
  });

  it('renders all six settings cards', () => {
    installFetchMock({ 'GET /api/categories': () => ({ categories: [] }), ...splitwiseRoutes });
    render(<SettingsView />);
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      'AI engine', 'Billing cycle', 'Spending projection',
      'Credit-card bills', 'Splitwise', 'Categories',
    ]);
  });
});
