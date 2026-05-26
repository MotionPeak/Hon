import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsView } from './SettingsView';
import { installFetchMock } from '../test/mockFetch';

describe('SettingsView', () => {
  it('renders the page heading + intro', () => {
    installFetchMock({ 'GET /api/categories': () => ({ categories: [] }) });
    render(<SettingsView />);
    expect(screen.getByRole('heading', { level: 1, name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText(/changes save as you make them/i)).toBeInTheDocument();
  });

  it('renders all six settings cards', () => {
    installFetchMock({ 'GET /api/categories': () => ({ categories: [] }) });
    render(<SettingsView />);
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      'AI engine', 'Billing cycle', 'Spending projection',
      'Credit-card bills', 'Splitwise', 'Categories',
    ]);
  });
});
