import { useEffect, useRef } from 'react';
import { api } from '../api';

const POLL_INTERVAL_MS = 3_000;
const PORTAL_TTL_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface Args {
  connectionId: string;
  baseline: number;
  enabled: boolean;
  onIncrease: (newCount: number) => void;
  onTimeout: () => void;
  onError: (message: string) => void;
}

/**
 * Polls GET /snaptrade/connections/:id/count every 3s for up to 5 min
 * (the portal URL's TTL). Fires `onIncrease(newCount)` the first tick
 * the count exceeds `baseline` OR the server reports `done: true` (the
 * SnapTrade portal redirected back to /snaptrade/done — covers re-link
 * of an already-linked broker, where count stays at baseline).
 * `onTimeout()` if neither happens; `onError(msg)` after 3 consecutive
 * fetch failures. Callbacks are mirrored into refs (use-latest pattern)
 * so changing their identity doesn't restart the interval.
 */
export function useSnapTradeConnectionPoll(args: Args): void {
  const { connectionId, baseline, enabled } = args;
  const onIncreaseRef = useRef(args.onIncrease);
  const onTimeoutRef = useRef(args.onTimeout);
  const onErrorRef = useRef(args.onError);
  onIncreaseRef.current = args.onIncrease;
  onTimeoutRef.current = args.onTimeout;
  onErrorRef.current = args.onError;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let consecutiveFailures = 0;
    const startedAt = Date.now();
    let handle: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      if (Date.now() - startedAt >= PORTAL_TTL_MS) {
        onTimeoutRef.current();
        return;
      }
      try {
        const res = await api<{ count: number; done?: boolean }>(
          `/snaptrade/connections/${connectionId}/count`,
        );
        if (cancelled) return;
        consecutiveFailures = 0;
        if (res.count > baseline || res.done === true) {
          onIncreaseRef.current(res.count);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
          const msg = err instanceof Error ? err.message : String(err);
          onErrorRef.current(msg);
          return;
        }
      }
      handle = setTimeout(tick, POLL_INTERVAL_MS);
    }

    handle = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      if (handle !== null) clearTimeout(handle);
    };
  }, [connectionId, baseline, enabled]);
}
