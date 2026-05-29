import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { SplitwiseCard } from './SplitwiseCard';

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); });

describe('SplitwiseCard', () => {
  it('shows a connect form with an API-key field when not connected', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
    });
    render(<SplitwiseCard />);
    expect(await screen.findByLabelText(/api key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
  });

  it('connects with the entered key', async () => {
    let connected = false;
    const connect = vi.fn((body: unknown) => {
      connected = true;
      void body;
      return { ok: true, user: { id: 1, name: 'Ada' } };
    });
    installFetchMock({
      'GET /api/splitwise/status': () =>
        ({ connected, user: connected ? { id: 1, name: 'Ada' } : null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/connect': (body) => connect(body),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [] }),
    });
    render(<SplitwiseCard />);
    const input = await screen.findByLabelText(/api key/i);
    await userEvent.type(input, 'SECRET');
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith({ apiKey: 'SECRET' }));
  });

  it('shows connected state + disconnect when connected', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Ada' } }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [] }),
    });
    render(<SplitwiseCard />);
    expect(await screen.findByText(/connected as ada/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });
});
