import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { installFetchMock } from './test/mockFetch';
import { renderWithProviders as render } from './test/renderWithProviders';
import { __resetSplitwiseCache } from './splitwise/useSplitwise';

afterEach(() => { __resetSplitwiseCache(); });

const HEALTH = {
  ok: true, name: 'hon-sidecar', version: '0.3.0',
  uptimeMs: 1234, db: 'ok', pid: 999,
};

const EMPTY = {
  // Engine wraps the payload in a `summary` envelope (OverviewView unwraps it).
  'GET /api/summary': () => ({
    summary: { byCurrency: [], accountCount: 0, connectionCount: 0, netWorthILS: 0 },
  }),
  'GET /api/health': () => HEALTH,
  'GET /api/companies': () => ({ companies: [] }),
  'GET /api/connections': () => ({ connections: [] }),
  'GET /api/accounts': () => ({ accounts: [] }),
  'GET /api/assets': () => ({ assets: [] }),
  'GET /api/loans': () => ({ loans: [], rates: { prime: null, cpiNow: null } }),
  'GET /api/brokerage': () => ({ holdings: [] }),
  'GET /api/transactions': () => ({ transactions: [] }),
  'GET /api/categories': () => ({ categories: [] }),
  'GET /api/vouchers': () => ({ vouchers: [] }),
  'GET /api/budget': () => ({
    piggy: { month: '', banks: [], fundedTotal: 0, headroom: 0, projected: false },
    currency: 'ILS',
  }),
  'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
  'GET /api/category-splits': () => ({ splits: {} }),
  'GET /api/subscriptions/cancelled': () => ({ cancelled: {} }),
  // Overview/Activity/Settings tabs mount Splitwise-aware components whose
  // useSplitwise hook fetches on mount; stub disconnected.
  'GET /api/splitwise/status': () => ({ connected: false, user: null }),
  'GET /api/splitwise/links': () => ({ links: [] }),
};

function withToken(): void {
  window.location.hash = 'token=test-token';
}

describe('App — tab routing', () => {
  it('shows the no-token screen when no token is in the URL', () => {
    render(<App />);
    expect(screen.getByText(/no access token/i)).toBeInTheDocument();
  });

  it('defaults to the Overview tab when a token is present', async () => {
    withToken();
    installFetchMock(EMPTY);
    render(<App />);
    expect(await screen.findByRole('tab', { name: /overview/i }))
      .toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1, name: /overview/i })).toBeInTheDocument();
  });

  it('shows the engine version in the header', async () => {
    withToken();
    installFetchMock(EMPTY);
    render(<App />);
    expect(await screen.findByText(/engine v0\.3\.0/i)).toBeInTheDocument();
  });

  it('switches to the Settings tab on click', async () => {
    withToken();
    installFetchMock(EMPTY);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /settings/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /settings/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches to the Fixed bills tab on click', async () => {
    withToken();
    installFetchMock(EMPTY);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /fixed bills/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /fixed bills/i }))
      .toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /fixed bills/i }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('switches to the Insights tab on click', async () => {
    withToken();
    installFetchMock(EMPTY);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /insights/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /insights/i }))
      .toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /insights/i }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('switches to the Piggy banks tab on click', async () => {
    withToken();
    installFetchMock(EMPTY);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /piggy/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /piggy banks/i }))
      .toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /piggy/i }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('switches to the Activity tab on click', async () => {
    withToken();
    installFetchMock(EMPTY);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /activity/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /activity/i }))
      .toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /activity/i }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('switches to the Loans tab on click', async () => {
    withToken();
    installFetchMock(EMPTY);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /loans/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /loans/i }))
      .toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /loans/i }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('switches to the Vouchers tab on click', async () => {
    withToken();
    installFetchMock(EMPTY);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: /vouchers/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /vouchers/i }))
      .toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /vouchers/i }))
      .toHaveAttribute('aria-selected', 'true');
  });
});
