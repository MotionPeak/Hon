import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { installFetchMock, jsonResponse } from '../test/mockFetch';
import { useSplitwise, __resetSplitwiseCache } from './useSplitwise';

afterEach(() => {
  vi.restoreAllMocks();
  __resetSplitwiseCache();
});

describe('useSplitwise', () => {
  it('loads status + links, then refreshes balances when connected', async () => {
    const link = {
      transactionId: 't1', expenseId: 'e1', groupId: null, currency: 'ILS',
      owedToMe: 50, counterparties: [{ id: 2, name: 'Roomie', owed: 50 }],
      paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
    };
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [link] }),
      // The real /refresh returns the links with recomputed paid state.
      'POST /api/splitwise/refresh': () => ({
        friends: [{ name: 'Roomie', balances: [{ amount: 50, currency: 'ILS' }] }],
        links: [link],
      }),
    });
    const { result } = renderHook(() => useSplitwise());
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.user?.name).toBe('Me');
    expect(result.current.linkByTxnId.get('t1')?.owedToMe).toBe(50);
    await waitFor(() => expect(result.current.friends).toHaveLength(1));
  });

  it('does not refresh balances when disconnected', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
    });
    const { result } = renderHook(() => useSplitwise());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connected).toBe(false);
    // No 'POST /api/splitwise/refresh' route is mocked; an unmocked call
    // would throw, so reaching here proves refresh was skipped.
  });

  it('connect posts the apiKey and flips connected', async () => {
    // Model the backend: once connected, GET /status reports it.
    let connected = false;
    installFetchMock({
      'GET /api/splitwise/status': () =>
        ({ connected, user: connected ? { id: 9, name: 'Ada' } : null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/connect': () => {
        connected = true;
        return { ok: true, user: { id: 9, name: 'Ada' } };
      },
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [] }),
    });
    const { result } = renderHook(() => useSplitwise());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.connect('SECRET-KEY'); });
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.user?.name).toBe('Ada');
  });

  it('sets vaultLocked when an action 409s', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/connect': () =>
        jsonResponse(409, { error: 'the credential vault is locked' }),
    });
    const { result } = renderHook(() => useSplitwise());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let thrown: unknown;
    await act(async () => {
      try { await result.current.connect('K'); }
      catch (e) { thrown = e; }
    });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/vault/i);
    expect(result.current.vaultLocked).toBe(true);
  });
});
