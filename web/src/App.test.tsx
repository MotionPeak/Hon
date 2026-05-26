import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { installFetchMock } from './test/mockFetch';

const HEALTH = {
  ok: true, name: 'hon-sidecar', version: '0.3.0',
  uptimeMs: 1234, db: 'ok', pid: 999,
};

function withToken(): void {
  window.location.hash = 'token=test-token';
}

describe('App — tab routing', () => {
  it('shows the no-token screen when no token is in the URL', () => {
    render(<App />);
    expect(screen.getByText(/no access token/i)).toBeInTheDocument();
  });

  it('defaults to the Health tab when a token is present', async () => {
    withToken();
    installFetchMock({ 'GET /api/health': () => HEALTH });
    render(<App />);
    expect(await screen.findByText(/connected to hon-sidecar/i)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /health/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches to the Settings tab on click', async () => {
    withToken();
    installFetchMock({
      'GET /api/health': () => HEALTH,
      'GET /api/categories': () => ({ categories: [] }),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /settings/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /settings/i })).toBeInTheDocument();
    expect(screen.queryByText(/connected to hon-sidecar/i)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /settings/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches to the Accounts tab on click', async () => {
    withToken();
    installFetchMock({
      'GET /api/health': () => HEALTH,
      'GET /api/companies': () => ({ companies: [] }),
      'GET /api/connections': () => ({ connections: [] }),
      'GET /api/accounts': () => ({ accounts: [] }),
      'GET /api/assets': () => ({ assets: [] }),
      'GET /api/loans': () => ({ loans: [] }),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /accounts/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /assets/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /accounts/i })).toHaveAttribute('aria-selected', 'true');
  });
});
