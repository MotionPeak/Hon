import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { installFetchMock } from '../test/mockFetch';
import { useSnapTradeConnectionPoll } from './useSnapTradeConnectionPoll';

describe('useSnapTradeConnectionPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls every 3s and fires onIncrease when count > baseline', async () => {
    let count = 2;
    installFetchMock({ 'GET /api/snaptrade/connections/conn-1/count': () => ({ count }) });
    const onIncrease = vi.fn();
    const onTimeout = vi.fn();
    const onError = vi.fn();

    renderHook(() =>
      useSnapTradeConnectionPoll({
        connectionId: 'conn-1', baseline: 2, enabled: true,
        onIncrease, onTimeout, onError,
      }),
    );

    // First poll fires immediately (no leading delay) → still baseline
    await vi.advanceTimersByTimeAsync(0);
    expect(onIncrease).not.toHaveBeenCalled();

    // Bump count, advance one tick → onIncrease fires
    count = 3;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onIncrease).toHaveBeenCalledWith(3);
  });

  it('stops polling on unmount', async () => {
    const fetchSpy = installFetchMock({
      'GET /api/snaptrade/connections/conn-1/count': () => ({ count: 0 }),
    });

    const { unmount } = renderHook(() =>
      useSnapTradeConnectionPoll({
        connectionId: 'conn-1', baseline: 0, enabled: true,
        onIncrease: vi.fn(), onTimeout: vi.fn(), onError: vi.fn(),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeUnmount = fetchSpy.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it('fires onTimeout after 5 minutes without an increase', async () => {
    installFetchMock({
      'GET /api/snaptrade/connections/conn-1/count': () => ({ count: 0 }),
    });
    const onIncrease = vi.fn();
    const onTimeout = vi.fn();

    renderHook(() =>
      useSnapTradeConnectionPoll({
        connectionId: 'conn-1', baseline: 0, enabled: true,
        onIncrease, onTimeout, onError: vi.fn(),
      }),
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onIncrease).not.toHaveBeenCalled();
  });

  it('tolerates 3 consecutive fetch failures, then surfaces onError', async () => {
    let failuresLeft = 4;
    installFetchMock({
      'GET /api/snaptrade/connections/conn-1/count': () => {
        if (failuresLeft-- > 0) throw new Error('network down');
        return { count: 0 };
      },
    });
    const onError = vi.fn();

    renderHook(() =>
      useSnapTradeConnectionPoll({
        connectionId: 'conn-1', baseline: 0, enabled: true,
        onIncrease: vi.fn(), onTimeout: vi.fn(), onError,
      }),
    );

    // 4 consecutive failures: ticks at t=0, 3s, 6s, 9s.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not restart the interval when onIncrease identity changes', async () => {
    const fetchSpy = installFetchMock({
      'GET /api/snaptrade/connections/conn-1/count': () => ({ count: 0 }),
    });

    const { rerender } = renderHook(
      ({ onIncrease }: { onIncrease: () => void }) =>
        useSnapTradeConnectionPoll({
          connectionId: 'conn-1', baseline: 0, enabled: true,
          onIncrease, onTimeout: vi.fn(), onError: vi.fn(),
        }),
      { initialProps: { onIncrease: vi.fn() } },
    );

    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirstTick = fetchSpy.mock.calls.length;

    // Re-render with a NEW onIncrease reference — should not reset interval.
    rerender({ onIncrease: vi.fn() });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirstTick);
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirstTick + 1);
  });

  it('does nothing when enabled is false', async () => {
    const fetchSpy = installFetchMock({
      'GET /api/snaptrade/connections/conn-1/count': () => ({ count: 0 }),
    });
    renderHook(() =>
      useSnapTradeConnectionPoll({
        connectionId: 'conn-1', baseline: 0, enabled: false,
        onIncrease: vi.fn(), onTimeout: vi.fn(), onError: vi.fn(),
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
