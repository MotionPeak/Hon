# SnapTrade Portal Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the client-side UX so a user can link a brokerage through SnapTrade's Connection Portal hands-free, plus the one backend endpoint that makes auto-detection cheap to poll.

**Architecture:** A 3-component React feature (picker, polling hook, state-machine orchestrator) lazy-loaded into AccountsView from two entry points — the Add Account wizard and a new button on the SnapTrade connection card. Backend adds one read-only `GET /snaptrade/connections/:id/count` endpoint that wraps the existing `countConnections` helper without minting a new portal URL.

**Tech Stack:** React 19 + TypeScript strict + Vitest + Testing Library (web). Fastify + tsx (sidecar). Radix Dialog for modals. Per-component `useState` + `useEffect` data layer — no SWR / Zustand.

**Spec:** [docs/superpowers/specs/2026-05-27-snaptrade-portal-flow-design.md](../specs/2026-05-27-snaptrade-portal-flow-design.md)

---

## File map

| File | Action | Purpose |
|---|---|---|
| `sidecar/src/snaptrade.ts` | Modify | Export `countConnections` (currently file-local) |
| `sidecar/src/server.ts` | Modify | Add `GET /snaptrade/connections/:connectionId/count` route |
| `web/src/accounts/SnapTradeBrokeragePicker.tsx` | Create | Searchable grid of brokerages with logos; pure presentation |
| `web/src/accounts/SnapTradeBrokeragePicker.test.tsx` | Create | Renders, filters, picks, empty state, IBKR pre-focus |
| `web/src/accounts/useSnapTradeConnectionPoll.ts` | Create | 3s background poll over portal's 5-min TTL; fires callbacks |
| `web/src/accounts/useSnapTradeConnectionPoll.test.ts` | Create | Tick cadence, onIncrease, timeout, fail tolerance, ref stability |
| `web/src/accounts/Countdown.tsx` | Create | Isolated 1s tick component for "Portal expires in 4:52" |
| `web/src/accounts/SnapTradeLinkFlow.tsx` | Create | State-machine orchestrator (picker → portal → poll → sync → done) |
| `web/src/accounts/SnapTradeLinkFlow.test.tsx` | Create | Full state-machine matrix + error paths + cancel cleanup |
| `web/src/accounts/AccountsView.tsx` | Modify | Allow `'brokerage'` in picker; branch on `company.type` to render new wizard; add Link button to SnapTrade ConnectionCard |
| `web/src/accounts/AccountsView.test.tsx` | Modify | Add integration tests for both entry paths |

**No DB schema changes. No new migration. No changes to `TXN_COLS`.**

---

## Task 1: Export `countConnections` from snaptrade.ts

**Files:**
- Modify: `sidecar/src/snaptrade.ts:362`

- [ ] **Step 1: Change function declaration to add `export`**

The current line 362 reads:

```ts
async function countConnections(
  snaptrade: Snaptrade,
  userId: string,
  userSecret: string,
): Promise<number> {
```

Change it to:

```ts
export async function countConnections(
  snaptrade: Snaptrade,
  userId: string,
  userSecret: string,
): Promise<number> {
```

That's the only change — same body, same signature, just exported.

- [ ] **Step 2: Verify typecheck still passes**

Run: `cd Hon/sidecar && npm run typecheck`
Expected: clean exit, no errors. Adding `export` to a function that's only called inside the same file is safe — TypeScript doesn't flag re-exports of internally-used symbols.

- [ ] **Step 3: Commit**

```bash
cd Hon && git add sidecar/src/snaptrade.ts
git commit -m "$(cat <<'EOF'
sidecar: snaptrade — export countConnections

Enables the new GET /snaptrade/connections/:id/count endpoint to reuse
the same helper that loginSnapTradeUser uses, without minting a portal
URL each time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add count endpoint to server.ts

**Files:**
- Modify: `sidecar/src/server.ts` (after the existing `/snaptrade/done` handler near line 388)

Following the existing SnapTrade route pattern in `server.ts`, no backend test is added here — the existing `/snaptrade/portal`, `/snaptrade/brokerages`, and `/snaptrade/done` routes have none. They're tested manually via the engine running. This plan follows that convention.

- [ ] **Step 1: Add import for `countConnections`**

Find the import block at the top of `sidecar/src/server.ts` (around line 15):

```ts
import { createPortalLink, listBrokerages, describeSnapError } from './snaptrade.js';
```

Change to add `countConnections`:

```ts
import {
  createPortalLink,
  listBrokerages,
  describeSnapError,
  countConnections,
  SNAPTRADE_COMPANY_ID,
} from './snaptrade.js';
```

(`SNAPTRADE_COMPANY_ID` is added in case the route needs to guard by company id — see Step 3 inline.)

- [ ] **Step 2: Add import for `getStoredUser` and `makeClient`**

The two helpers we need are currently file-local in `snaptrade.ts`. Export them too — same one-word change as Task 1 — and add to this import block.

In `sidecar/src/snaptrade.ts`, change lines 54 and 106 to add `export`:

```ts
export function getStoredUser(
  // … existing body …
)
```

```ts
export function makeClient(creds: Record<string, string>): Snaptrade {
  // … existing body …
}
```

Then update the import in `sidecar/src/server.ts`:

```ts
import {
  createPortalLink,
  listBrokerages,
  describeSnapError,
  countConnections,
  getStoredUser,
  makeClient,
} from './snaptrade.js';
```

- [ ] **Step 3: Add the new route handler**

Insert the following BELOW the existing `/snaptrade/done` route (find: `app.get('/snaptrade/done', async (_req, reply) =>`). Place the new handler between `/snaptrade/done` and the next non-snaptrade route:

```ts
// Read-only check of how many brokerages the SnapTrade user currently has
// linked. Used by the Link-a-brokerage flow to poll for completion without
// the side effect of minting a new portal URL (which loginSnapTradeUser
// does on every call). Safe to poll every few seconds.
app.get('/snaptrade/connections/:connectionId/count', async (req, reply) => {
  const { connectionId } = req.params as { connectionId: string };
  if (!vault?.unlocked) {
    return reply.code(409).send({ error: 'the credential vault is locked' });
  }
  const credentials = vault.loadCredentials(connectionId);
  if (!credentials || typeof credentials !== 'object') {
    return reply.code(400).send({ error: 'credentials are required' });
  }
  try {
    const snaptrade = makeClient(credentials);
    const stored = getStoredUser(credentials, vault);
    if (!stored) {
      // No persisted SnapTrade user yet — the user hasn't opened the
      // portal even once. Count is trivially 0; polling caller sees no
      // increase and waits until baseline is set by a /snaptrade/portal
      // call.
      return { count: 0 };
    }
    const count = await countConnections(snaptrade, stored.userId, stored.userSecret);
    return { count };
  } catch (err) {
    return reply.code(400).send({ error: describeSnapError(err) });
  }
});
```

- [ ] **Step 4: Run sidecar typecheck**

Run: `cd Hon/sidecar && npm run typecheck`
Expected: clean exit.

- [ ] **Step 5: Run sidecar tests to make sure nothing regressed**

Run: `cd Hon/sidecar && npm test`
Expected: 55 tests pass (the existing count from HANDOFF).

- [ ] **Step 6: Manual smoke (engine boots, route returns 401 without token)**

```bash
cd Hon && pkill -9 -f 'tsx.*server\.ts|node.*web\.mjs' 2>/dev/null; sleep 0.5
cd Hon/sidecar && npm run web &
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/snaptrade/connections/test/count
# Expected: 401 (no Bearer token, fine — proves the route is registered)
pkill -9 -f 'tsx.*server\.ts|node.*web\.mjs'
```

If you get 404 instead of 401, the route didn't register — check syntax.

- [ ] **Step 7: Commit**

```bash
cd Hon && git add sidecar/src/snaptrade.ts sidecar/src/server.ts
git commit -m "$(cat <<'EOF'
sidecar: add GET /snaptrade/connections/:id/count

Lightweight read-only count of linked brokerages. Used by the
Link-a-brokerage flow to poll for completion without minting a new
portal URL each tick. Wraps the existing countConnections + makeClient
+ getStoredUser helpers (now exported).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: SnapTradeBrokeragePicker — tests first

**Files:**
- Create: `web/src/accounts/SnapTradeBrokeragePicker.test.tsx`
- Create: `web/src/accounts/SnapTradeBrokeragePicker.tsx`

Pure presentation component. Reads `BrokerageOption[]`, renders a search box + grid. Re-used inside `SnapTradeLinkFlow`'s picking state.

- [ ] **Step 1: Add a shared type for `BrokerageOption`**

Open `web/src/accounts/types.ts` and append:

```ts
/** One brokerage SnapTrade can connect, returned by POST /snaptrade/brokerages. */
export interface BrokerageOption {
  slug: string;
  name: string;
  logoUrl?: string;
}
```

(The same shape exists server-side in `sidecar/src/snaptrade.ts` line 116 — we redeclare it here rather than cross-importing because web and sidecar are independent TypeScript projects.)

- [ ] **Step 2: Write the failing test file**

Create `web/src/accounts/SnapTradeBrokeragePicker.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SnapTradeBrokeragePicker } from './SnapTradeBrokeragePicker';
import type { BrokerageOption } from './types';

const SAMPLE: BrokerageOption[] = [
  { slug: 'INTERACTIVE_BROKERS', name: 'Interactive Brokers', logoUrl: '/ibkr.png' },
  { slug: 'SCHWAB',              name: 'Charles Schwab',     logoUrl: '/schwab.png' },
  { slug: 'ROBINHOOD',           name: 'Robinhood',          logoUrl: '/rh.png' },
];

describe('SnapTradeBrokeragePicker', () => {
  it('renders one card per brokerage', () => {
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    expect(screen.getByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charles Schwab/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Robinhood/i })).toBeInTheDocument();
  });

  it('filters case-insensitively by name', async () => {
    const user = userEvent.setup();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    await user.type(screen.getByPlaceholderText(/search brokerages/i), 'schw');
    expect(screen.queryByRole('button', { name: /Interactive Brokers/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Charles Schwab/i })).toBeInTheDocument();
  });

  it('calls onPick(slug) when a card is clicked', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={onPick} />);
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));
    expect(onPick).toHaveBeenCalledWith('INTERACTIVE_BROKERS');
  });

  it('shows an empty state when the filter matches nothing', async () => {
    const user = userEvent.setup();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    await user.type(screen.getByPlaceholderText(/search brokerages/i), 'xyzzy');
    expect(screen.getByText(/no brokerages match/i)).toBeInTheDocument();
  });

  it('flags IBKR as pre-focused via data attribute', () => {
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    const ibkr = screen.getByRole('button', { name: /Interactive Brokers/i });
    expect(ibkr).toHaveAttribute('data-pre-focused', 'true');
  });

  it('does not pre-focus anything when IBKR is absent', () => {
    const noIbkr = SAMPLE.filter((b) => b.slug !== 'INTERACTIVE_BROKERS');
    render(<SnapTradeBrokeragePicker brokerages={noIbkr} onPick={() => {}} />);
    expect(document.querySelector('[data-pre-focused="true"]')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test, verify all fail**

Run: `cd Hon/web && npm test SnapTradeBrokeragePicker`
Expected: 6 tests FAIL with "Cannot find module './SnapTradeBrokeragePicker'" or similar.

- [ ] **Step 4: Write the minimal component**

Create `web/src/accounts/SnapTradeBrokeragePicker.tsx`:

```tsx
import { useDeferredValue, useMemo, useState } from 'react';
import type { BrokerageOption } from './types';

interface Props {
  brokerages: BrokerageOption[];
  onPick: (slug: string) => void;
}

/**
 * Searchable grid of SnapTrade-supported brokerages. Pre-builds a lowercase
 * name index so the filter doesn't re-lowercase on every keystroke; the
 * search input value is wrapped in useDeferredValue so typing stays
 * responsive even with 50+ entries (per vercel-react-best-practices
 * `rerender-use-deferred-value`).
 */
export function SnapTradeBrokeragePicker({ brokerages, onPick }: Props) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const indexed = useMemo(
    () => brokerages.map((b) => ({ b, key: b.name.toLowerCase() })),
    [brokerages],
  );

  const filtered = useMemo(() => {
    const q = deferredQuery.toLowerCase().trim();
    if (!q) return indexed.map((i) => i.b);
    return indexed.filter((i) => i.key.includes(q)).map((i) => i.b);
  }, [indexed, deferredQuery]);

  return (
    <div className="snaptrade-picker">
      <label className="field">
        <span>Search</span>
        <input
          type="text"
          placeholder="Search brokerages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </label>
      {filtered.length === 0 ? (
        <p className="snaptrade-picker-empty">No brokerages match.</p>
      ) : (
        <ul className="snaptrade-picker-grid">
          {filtered.map((b) => (
            <li key={b.slug}>
              <button
                type="button"
                className="snaptrade-picker-card"
                onClick={() => onPick(b.slug)}
                data-pre-focused={b.slug === 'INTERACTIVE_BROKERS' ? 'true' : undefined}
              >
                {b.logoUrl ? (
                  <img src={b.logoUrl} alt="" className="snaptrade-picker-logo" />
                ) : (
                  <span className="snaptrade-picker-logo snaptrade-picker-logo-fallback">📈</span>
                )}
                <span className="snaptrade-picker-name">{b.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the test, verify all pass**

Run: `cd Hon/web && npm test SnapTradeBrokeragePicker`
Expected: 6 tests pass.

- [ ] **Step 6: Run typecheck**

Run: `cd Hon/web && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd Hon && git add web/src/accounts/SnapTradeBrokeragePicker.tsx web/src/accounts/SnapTradeBrokeragePicker.test.tsx web/src/accounts/types.ts
git commit -m "$(cat <<'EOF'
web: snaptrade — searchable brokerage picker component

Pure presentation. Search filter uses useDeferredValue to keep typing
responsive over 50+ entries; lowercase index pre-built via useMemo.
IBKR pre-focused via data attribute (tested).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: useSnapTradeConnectionPoll hook — tests first

**Files:**
- Create: `web/src/accounts/useSnapTradeConnectionPoll.test.ts`
- Create: `web/src/accounts/useSnapTradeConnectionPoll.ts`

The poll runs in the background. To keep the parent state machine from re-rendering every second, this hook does NOT expose `remainingMs` — the countdown is a separate `Countdown.tsx` with its own 1s ticker (Task 5). This hook only fires callbacks.

- [ ] **Step 1: Write the failing test file**

Create `web/src/accounts/useSnapTradeConnectionPoll.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { installFetchMock } from '../test/mockFetch';
import { useSnapTradeConnectionPoll } from './useSnapTradeConnectionPoll';

const POLL_PATH = '/api/snaptrade/connections/conn-1/count';

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
```

- [ ] **Step 2: Run the test, verify all fail**

Run: `cd Hon/web && npm test useSnapTradeConnectionPoll`
Expected: 6 tests FAIL with "Cannot find module './useSnapTradeConnectionPoll'".

- [ ] **Step 3: Write the minimal hook**

Create `web/src/accounts/useSnapTradeConnectionPoll.ts`:

```ts
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
 * the count exceeds `baseline`, `onTimeout()` if it never does, and
 * `onError(msg)` after 3 consecutive fetch failures. Callbacks are
 * mirrored into refs (use-latest pattern) so changing their identity
 * doesn't restart the interval.
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

    async function tick() {
      if (cancelled) return;
      if (Date.now() - startedAt >= PORTAL_TTL_MS) {
        onTimeoutRef.current();
        return;
      }
      try {
        const res = await api<{ count: number }>(
          `/snaptrade/connections/${connectionId}/count`,
        );
        if (cancelled) return;
        consecutiveFailures = 0;
        if (res.count > baseline) {
          onIncreaseRef.current(res.count);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          const msg = err instanceof Error ? err.message : String(err);
          onErrorRef.current(msg);
          return;
        }
      }
      handle = setTimeout(tick, POLL_INTERVAL_MS);
    }

    let handle: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [connectionId, baseline, enabled]);
}
```

- [ ] **Step 4: Run the test, verify all pass**

Run: `cd Hon/web && npm test useSnapTradeConnectionPoll`
Expected: 6 tests pass.

If the "does not restart" test is flaky, double-check that `args.onIncrease` isn't in the `useEffect` dependency array — only the three primitives (`connectionId`, `baseline`, `enabled`) should be.

- [ ] **Step 5: Run typecheck**

Run: `cd Hon/web && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd Hon && git add web/src/accounts/useSnapTradeConnectionPoll.ts web/src/accounts/useSnapTradeConnectionPoll.test.ts
git commit -m "$(cat <<'EOF'
web: snaptrade — connection-count polling hook

3s tick over the portal URL's 5-min TTL. Tolerates 3 consecutive
fetch failures before surfacing onError. Callbacks mirrored into refs
so changing their identity doesn't restart the interval.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Countdown component

**Files:**
- Create: `web/src/accounts/Countdown.tsx`
- Create: `web/src/accounts/Countdown.test.tsx`

Tiny. Owns its own 1s tick so the `SnapTradeLinkFlow` parent doesn't re-render every second.

- [ ] **Step 1: Write the failing test**

Create `web/src/accounts/Countdown.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Countdown } from './Countdown';

describe('Countdown', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 4, 27, 12, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders MM:SS remaining', () => {
    const deadlineMs = Date.now() + 4 * 60 * 1000 + 30 * 1000; // 4:30
    render(<Countdown deadlineMs={deadlineMs} />);
    expect(screen.getByText('4:30')).toBeInTheDocument();
  });

  it('ticks down every second', () => {
    const deadlineMs = Date.now() + 5_000;
    render(<Countdown deadlineMs={deadlineMs} />);
    expect(screen.getByText('0:05')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByText('0:04')).toBeInTheDocument();
  });

  it('clamps to 0:00 once the deadline has passed', () => {
    const deadlineMs = Date.now() - 1_000;
    render(<Countdown deadlineMs={deadlineMs} />);
    expect(screen.getByText('0:00')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify all fail**

Run: `cd Hon/web && npm test Countdown`
Expected: 3 fails with "Cannot find module './Countdown'".

- [ ] **Step 3: Write the component**

Create `web/src/accounts/Countdown.tsx`:

```tsx
import { useEffect, useState } from 'react';

interface Props {
  deadlineMs: number;
}

/**
 * Displays MM:SS remaining until `deadlineMs`. Owns its own 1s tick so
 * the parent doesn't re-render every second (per
 * vercel-react-best-practices `rerender-split-combined-hooks`).
 */
export function Countdown({ deadlineMs }: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  const remainingMs = Math.max(0, deadlineMs - Date.now());
  const total = Math.floor(remainingMs / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return <span className="snaptrade-countdown">{minutes}:{String(seconds).padStart(2, '0')}</span>;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd Hon/web && npm test Countdown`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
cd Hon && git add web/src/accounts/Countdown.tsx web/src/accounts/Countdown.test.tsx
git commit -m "$(cat <<'EOF'
web: snaptrade — isolated countdown component

Owns its own 1s tick so the SnapTradeLinkFlow parent state machine
doesn't re-render every second.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: SnapTradeLinkFlow orchestrator — tests first

**Files:**
- Create: `web/src/accounts/SnapTradeLinkFlow.test.tsx`
- Create: `web/src/accounts/SnapTradeLinkFlow.tsx`

Owns the state machine. Sub-views declared at module level (NOT inline) per `rerender-no-inline-components`. Lazy-loaded from callers in Task 7+.

- [ ] **Step 1: Write the failing test file**

Create `web/src/accounts/SnapTradeLinkFlow.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock, jsonResponse } from '../test/mockFetch';
import { SnapTradeLinkFlow } from './SnapTradeLinkFlow';

const BROKERS = [
  { slug: 'INTERACTIVE_BROKERS', name: 'Interactive Brokers' },
  { slug: 'SCHWAB', name: 'Charles Schwab' },
];

function defaultRoutes(overrides: Record<string, unknown> = {}): Record<string, () => unknown> {
  return {
    'POST /api/snaptrade/brokerages': () => ({ brokerages: BROKERS }),
    'POST /api/snaptrade/portal': () => ({
      portal: {
        userId: 'u1', userSecret: 's1',
        redirectURI: 'https://snaptrade.com/portal/abc',
        connectionCount: 0, atLimit: false,
      },
    }),
    'GET /api/snaptrade/connections/conn-1/count': () => ({ count: 0 }),
    ...overrides,
  };
}

describe('SnapTradeLinkFlow', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads brokerages on mount and shows the picker', async () => {
    installFetchMock(defaultRoutes() as never);
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
    });
  });

  it('picking a broker opens the portal in a new tab and starts polling', async () => {
    installFetchMock(defaultRoutes() as never);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        'https://snaptrade.com/portal/abc', 'snaptrade-portal', 'noopener,noreferrer',
      );
    });
    expect(screen.getByText(/finish linking in the SnapTrade tab/i)).toBeInTheDocument();
  });

  it('when the poll detects a new connection, calls onLinked and shows done', async () => {
    let count = 0;
    installFetchMock(defaultRoutes({
      'GET /api/snaptrade/connections/conn-1/count': () => ({ count }),
    }) as never);
    const onLinked = vi.fn().mockResolvedValue({ accountsAdded: 3 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={onLinked} onCancel={() => {}} />);

    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));

    // After portal opens, baseline is 0. Bump count to 1, advance one tick.
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    count = 1;
    await vi.advanceTimersByTimeAsync(3_000);

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText(/Interactive Brokers/i)).toBeInTheDocument();
      expect(screen.getByText(/3 accounts/i)).toBeInTheDocument();
    });
  });

  it('shows the atLimit error when /portal reports atLimit', async () => {
    installFetchMock(defaultRoutes({
      'POST /api/snaptrade/portal': () => ({
        portal: {
          userId: 'u1', userSecret: 's1', redirectURI: '',
          connectionCount: 5, atLimit: true,
        },
      }),
    }) as never);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));

    await waitFor(() => {
      expect(screen.getByText(/5-brokerage SnapTrade free tier limit/i)).toBeInTheDocument();
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('shows "vault is locked" when /brokerages returns 409', async () => {
    installFetchMock(defaultRoutes({
      'POST /api/snaptrade/brokerages': () => jsonResponse(409, { error: 'the credential vault is locked' }),
    }) as never);
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => {
      expect(screen.getByText(/unlock your vault/i)).toBeInTheDocument();
    });
  });

  it('cancel during polling fires onCancel and stops polling', async () => {
    const fetchRoutes = defaultRoutes();
    const fetchSpy = installFetchMock(fetchRoutes as never);
    const onCancel = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SnapTradeLinkFlow connectionId="conn-1" onLinked={async () => ({ accountsAdded: 0 })} onCancel={onCancel} />);

    await vi.advanceTimersByTimeAsync(0);
    await screen.findByRole('button', { name: /Interactive Brokers/i });
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));
    await waitFor(() => expect(openSpy).toHaveBeenCalled());

    const callsAtCancel = fetchSpy.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy.mock.calls.length).toBe(callsAtCancel);
  });
});
```

- [ ] **Step 2: Run the test, verify all fail**

Run: `cd Hon/web && npm test SnapTradeLinkFlow`
Expected: 6 fails with "Cannot find module './SnapTradeLinkFlow'".

- [ ] **Step 3: Write the orchestrator component**

Create `web/src/accounts/SnapTradeLinkFlow.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { SnapTradeBrokeragePicker } from './SnapTradeBrokeragePicker';
import { Countdown } from './Countdown';
import { useSnapTradeConnectionPoll } from './useSnapTradeConnectionPoll';
import type { BrokerageOption } from './types';

interface PortalResult {
  userId: string;
  userSecret: string;
  redirectURI: string;
  connectionCount: number;
  atLimit: boolean;
  error?: string;
}

interface Props {
  connectionId: string;
  /** Triggered by the parent's existing scrape path. Resolves with the account count added. */
  onLinked: () => Promise<{ accountsAdded: number }>;
  onCancel: () => void;
}

const PORTAL_TTL_MS = 5 * 60 * 1000;

type State =
  | { kind: 'loading' }
  | { kind: 'picking'; brokerages: BrokerageOption[] }
  | { kind: 'opening'; brokerSlug: string; brokerName: string }
  | { kind: 'waiting'; brokerName: string; baseline: number; deadlineMs: number }
  | { kind: 'syncing'; brokerName: string }
  | { kind: 'done'; brokerName: string; accountsAdded: number }
  | { kind: 'error'; message: string; canRetry: boolean };

export function SnapTradeLinkFlow({ connectionId, onLinked, onCancel }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  // Load brokerages on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ brokerages: BrokerageOption[] }>(
          '/snaptrade/brokerages', 'POST', { connectionId },
        );
        if (cancelled) return;
        setState({ kind: 'picking', brokerages: res.brokerages });
      } catch (err) {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 409) {
          setState({ kind: 'error', message: 'Unlock your vault to connect a brokerage.', canRetry: false });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          setState({ kind: 'error', message: msg, canRetry: true });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId]);

  // Open portal when a broker is picked.
  useEffect(() => {
    if (state.kind !== 'opening') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ portal: PortalResult }>('/snaptrade/portal', 'POST', {
          connectionId,
          broker: state.brokerSlug,
          customRedirect: `${window.location.origin}/api/snaptrade/done`,
        });
        if (cancelled) return;
        const p = res.portal;
        if (p.atLimit) {
          setState({
            kind: 'error',
            message: "You're at the 5-brokerage SnapTrade free tier limit. Unlink a brokerage first.",
            canRetry: false,
          });
          return;
        }
        if (p.error) {
          setState({ kind: 'error', message: p.error, canRetry: true });
          return;
        }
        if (!p.redirectURI) {
          setState({ kind: 'error', message: "SnapTrade didn't return a portal URL — try again.", canRetry: true });
          return;
        }
        window.open(p.redirectURI, 'snaptrade-portal', 'noopener,noreferrer');
        setState({
          kind: 'waiting',
          brokerName: state.brokerName,
          baseline: p.connectionCount,
          deadlineMs: Date.now() + PORTAL_TTL_MS,
        });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message: msg, canRetry: true });
      }
    })();
    return () => { cancelled = true; };
  }, [state, connectionId]);

  // Polling — runs only in the `waiting` state.
  useSnapTradeConnectionPoll({
    connectionId,
    baseline: state.kind === 'waiting' ? state.baseline : 0,
    enabled: state.kind === 'waiting',
    onIncrease: async () => {
      if (state.kind !== 'waiting') return;
      const brokerName = state.brokerName;
      setState({ kind: 'syncing', brokerName });
      try {
        const result = await onLinked();
        setState({ kind: 'done', brokerName, accountsAdded: result.accountsAdded });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message: `Linked the brokerage, but the first sync failed: ${msg}`, canRetry: false });
      }
    },
    onTimeout: () => {
      setState({ kind: 'error', message: 'The SnapTrade portal expired (5 min).', canRetry: true });
    },
    onError: (msg) => {
      setState({ kind: 'error', message: `Lost connection to the engine: ${msg}`, canRetry: true });
    },
  });

  if (state.kind === 'loading') return <LoadingPanel />;
  if (state.kind === 'picking') {
    return (
      <PickingPanel
        brokerages={state.brokerages}
        onPick={(slug) => {
          const brokerName = state.brokerages.find((b) => b.slug === slug)?.name ?? slug;
          setState({ kind: 'opening', brokerSlug: slug, brokerName });
        }}
        onCancel={onCancel}
      />
    );
  }
  if (state.kind === 'opening') return <OpeningPanel />;
  if (state.kind === 'waiting') {
    return <WaitingPanel brokerName={state.brokerName} deadlineMs={state.deadlineMs} onCancel={onCancel} />;
  }
  if (state.kind === 'syncing') return <SyncingPanel brokerName={state.brokerName} />;
  if (state.kind === 'done') {
    return <DonePanel brokerName={state.brokerName} accountsAdded={state.accountsAdded} onDone={onCancel} />;
  }
  return <ErrorPanel message={state.message} canRetry={state.canRetry} onRetry={() => setState({ kind: 'loading' })} onCancel={onCancel} />;
}

// ---- Sub-panels (declared at module level — rerender-no-inline-components) ----

function LoadingPanel() {
  return <p className="snaptrade-flow-loading">Loading brokerages…</p>;
}

function PickingPanel(
  { brokerages, onPick, onCancel }:
    { brokerages: BrokerageOption[]; onPick: (slug: string) => void; onCancel: () => void },
) {
  return (
    <div className="snaptrade-flow">
      <h2>Link a brokerage</h2>
      <p>Pick the brokerage you want to connect. You'll finish signing in on SnapTrade's secure page.</p>
      <SnapTradeBrokeragePicker brokerages={brokerages} onPick={onPick} />
      <div className="modal-actions"><button type="button" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function OpeningPanel() {
  return <p className="snaptrade-flow-loading">Opening the SnapTrade portal…</p>;
}

function WaitingPanel(
  { brokerName, deadlineMs, onCancel }:
    { brokerName: string; deadlineMs: number; onCancel: () => void },
) {
  return (
    <div className="snaptrade-flow">
      <h2>Finish linking in the SnapTrade tab</h2>
      <p>
        We've opened SnapTrade's secure portal for <strong>{brokerName}</strong>. Complete the sign-in
        there — we'll pull your accounts the moment it finishes.
      </p>
      <p className="snaptrade-flow-meta">Portal expires in <Countdown deadlineMs={deadlineMs} />.</p>
      <div className="modal-actions"><button type="button" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function SyncingPanel({ brokerName }: { brokerName: string }) {
  return <p className="snaptrade-flow-loading">Pulling your {brokerName} accounts…</p>;
}

function DonePanel(
  { brokerName, accountsAdded, onDone }:
    { brokerName: string; accountsAdded: number; onDone: () => void },
) {
  return (
    <div className="snaptrade-flow">
      <h2>Connected {brokerName}</h2>
      <p>{accountsAdded} account{accountsAdded === 1 ? '' : 's'} added.</p>
      <div className="modal-actions"><button type="button" onClick={onDone}>Done</button></div>
    </div>
  );
}

function ErrorPanel(
  { message, canRetry, onRetry, onCancel }:
    { message: string; canRetry: boolean; onRetry: () => void; onCancel: () => void },
) {
  return (
    <div className="snaptrade-flow">
      <h2>Something went wrong</h2>
      <p className="snaptrade-flow-error">{message}</p>
      <div className="modal-actions">
        {canRetry && <button type="button" onClick={onRetry}>Try again</button>}
        <button type="button" onClick={onCancel}>Close</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify all pass**

Run: `cd Hon/web && npm test SnapTradeLinkFlow`
Expected: 6 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `cd Hon/web && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd Hon && git add web/src/accounts/SnapTradeLinkFlow.tsx web/src/accounts/SnapTradeLinkFlow.test.tsx
git commit -m "$(cat <<'EOF'
web: snaptrade — link-flow state-machine orchestrator

Picker → opening → waiting → syncing → done|error. Sub-views declared
at module level (no inline components). Calls back to the parent for
the actual scrape so it can reuse the existing scrape-poll path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire the Add Account flow

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx`

Today the Add Account picker filters `companies.filter((c) => c.type === 'bank' || c.type === 'card')`. We're adding brokerage — and after the credentials form succeeds for a brokerage company, immediately mount `SnapTradeLinkFlow` inside the same modal portal.

- [ ] **Step 1: Add lazy import at the top of the file**

Open `web/src/accounts/AccountsView.tsx`. Find the existing React import block and add `lazy, Suspense`:

```ts
import { useCallback, useEffect, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
```

Then add a `lazy` declaration below the imports (before any top-level function/constant — line 12 area):

```ts
const SnapTradeLinkFlow = lazy(() =>
  import('./SnapTradeLinkFlow').then((m) => ({ default: m.SnapTradeLinkFlow })),
);
```

- [ ] **Step 2: Allow `'brokerage'` in the AddConnectionPicker filter**

Find line 1083 (inside `AddConnectionPicker`):

```ts
const supported = companies.filter((c) => c.type === 'bank' || c.type === 'card');
```

Change to:

```ts
const supported = companies.filter(
  (c) => c.type === 'bank' || c.type === 'card' || c.type === 'brokerage',
);
```

And update the comment above (line 1081–1082) from:

```ts
// Only bank + card flows are handled here; brokerage (SnapTrade) and
// pension have their own multi-step flows that land in later sessions.
```

to:

```ts
// Bank + card + brokerage (SnapTrade) routed here. Pension still uses
// its own multi-step flow that lands in a later session.
```

- [ ] **Step 3: Add `addBrokerageLinkFor` state alongside `addFlow`**

Find the `addFlow` state declaration (around line 178):

```ts
type AddFlow = null | 'picker' | 'manual-asset' | 'manual-loan' | Company;
const [addFlow, setAddFlow] = useState<AddFlow>(null);
```

Add a second state below it:

```ts
// When set, render <SnapTradeLinkFlow> in its own modal portal. Holds the
// connectionId of the newly-created (or existing) SnapTrade connection.
const [linkSnapTradeFor, setLinkSnapTradeFor] = useState<string | null>(null);
```

- [ ] **Step 4: Modify `AddConnectionForm` to surface the new connection id**

Find the `AddConnectionFormProps` interface (around line 1247):

```ts
interface AddConnectionFormProps {
  company: Company;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}
```

Change `onSaved` to accept the new connection id:

```ts
interface AddConnectionFormProps {
  company: Company;
  onClose: () => void;
  onSaved: (connectionId: string) => void | Promise<void>;
}
```

Then inside `AddConnectionForm`'s `submit` (around line 1262–1275):

```ts
await api('/connections', 'POST', {
  companyId: company.id,
  displayName: displayName.trim(),
  credentials,
});
await onSaved();
```

Change to capture the response:

```ts
import type { Connection } from './types';

// inside submit():
const created = await api<{ connection: Connection }>(
  '/connections', 'POST', {
    companyId: company.id,
    displayName: displayName.trim(),
    credentials,
  },
);
await onSaved(created.connection.id);
```

(Verified against `sidecar/src/server.ts` line 209: `POST /connections`
returns `{ connection }` where `connection` is the full `Connection`
shape from `repo.createConnection`. The `Connection` type lives in
`web/src/accounts/types.ts`.)

- [ ] **Step 5: Branch on `company.type === 'brokerage'` in the existing onSaved handler**

`AccountsView.tsx` renders `<AddConnectionForm>` at lines 435–441:

```tsx
{typeof addFlow === 'object' && addFlow !== null && (
  <AddConnectionForm
    company={addFlow}
    onClose={() => setAddFlow(null)}
    onSaved={async () => { setAddFlow(null); await refresh(); }}
  />
)}
```

Replace the `onSaved` prop with the brokerage-aware version:

```tsx
{typeof addFlow === 'object' && addFlow !== null && (
  <AddConnectionForm
    company={addFlow}
    onClose={() => setAddFlow(null)}
    onSaved={async (connectionId) => {
      await refresh();
      if (addFlow.type === 'brokerage') {
        setAddFlow(null);
        setLinkSnapTradeFor(connectionId);
      } else {
        setAddFlow(null);
      }
    }}
  />
)}
```

The `addFlow` narrowing to `Company` (and access to `.type`) is safe
inside the `typeof addFlow === 'object'` branch — the existing
`AddFlow` union narrows `addFlow` to `Company` once strings are ruled
out.

- [ ] **Step 6: Render the link-flow modal**

Add a new modal portal in AccountsView's JSX, alongside the other modal portals (search for `<ModalPortal>` to find them). Insert:

```tsx
{linkSnapTradeFor !== null && (
  <ModalPortal>
    <div className="overlay">
      <div role="dialog" aria-label="Link a brokerage" className="modal">
        <Suspense fallback={<p className="snaptrade-flow-loading">Loading…</p>}>
          <SnapTradeLinkFlow
            connectionId={linkSnapTradeFor}
            onLinked={async () => {
              await api('/connections/' + linkSnapTradeFor + '/scrape', 'POST', {});
              // Existing scrape-poll loop in AccountsView will refresh as
              // it transitions to 'success'. For a clean handoff, force
              // an immediate refresh so the new accounts show right away.
              const before = data?.accounts.length ?? 0;
              await refresh();
              const after = data?.accounts.length ?? 0;
              return { accountsAdded: Math.max(0, after - before) };
            }}
            onCancel={() => setLinkSnapTradeFor(null)}
          />
        </Suspense>
      </div>
    </div>
  </ModalPortal>
)}
```

Note on `accountsAdded`: the count is the delta between `data.accounts.length` before and after refresh. The exact API for triggering scrape from inside this callback may need to use the same `triggerScrape` helper the existing Sync button uses — search for `setSyncForConnection(connection.id, { kind: 'starting' });` in this file and copy the surrounding logic if a direct `api('/connections/.../scrape', 'POST', …)` call is insufficient.

- [ ] **Step 7: Run web tests for AccountsView**

Run: `cd Hon/web && npm test AccountsView`
Expected: existing tests still pass. (We'll add integration tests in the next task.)

If a test fails because `'brokerage'` now matches in the picker filter and that breaks an assertion about "only bank/card show", update the test fixture to reflect the new behaviour.

- [ ] **Step 8: Typecheck**

Run: `cd Hon/web && npm run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
cd Hon && git add web/src/accounts/AccountsView.tsx
git commit -m "$(cat <<'EOF'
web: accounts — Add Account routes SnapTrade to the link flow

Brokerage companies appear in the Add Account picker. After credentials
save, AccountsView swaps the modal to <SnapTradeLinkFlow> (lazy-loaded
via React.lazy), which handles broker pick + portal handoff + polling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire the SnapTrade ConnectionCard button

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` (the `ConnectionCard` component, around line 557)

Adds a `"Link a brokerage"` button to the SnapTrade ConnectionCard. Becomes `"Link another brokerage"` once `connectionCount > 0`. Disabled with tooltip when `atLimit` (best-effort guardrail — server still enforces).

- [ ] **Step 1: Pass the SnapTrade-link handler down to ConnectionCard**

(No detector helper needed — `ConnectionCard` already receives `company`
as a prop, so the check is just `company.id === 'snaptrade'`.)

`AccountsView` has a `RowCallbacks` interface (around line 465 — verified
shape: `onEditBalance`, `onToggleAccountExcluded`, `onToggleAssetExcluded`,
`onToggleLoanExcluded`, `onRemoveConnection`, `onSetCredentials`,
`onSync`, `onToggleHoldings`, `onEditAsset`, `onRemoveAsset`,
`onEditLoan`, `onRemoveLoan`, `syncStates`, `holdings`,
`expandedHoldings`). Add one entry:

```ts
interface RowCallbacks {
  // … existing entries …
  onLinkSnapTradeBrokerage: (connectionId: string) => void;
}
```

In the place where the `callbacks: RowCallbacks` bag is constructed
inside `AccountsView` (search for `const callbacks` near where
`renderSectionItems` is called), add:

```ts
onLinkSnapTradeBrokerage: (connectionId) => setLinkSnapTradeFor(connectionId),
```

- [ ] **Step 2: Render the button inside ConnectionCard for SnapTrade rows**

`ConnectionCard` (line 557) already receives `company` as a prop. Inside
its JSX, add — alongside the existing Sync / Edit / Remove buttons:

```tsx
{company.id === 'snaptrade' && (
  <LinkBrokerageButton
    connectionId={connection.id}
    accounts={accounts}
    onLink={() => callbacks.onLinkSnapTradeBrokerage(connection.id)}
  />
)}
```

(`accounts` and `callbacks` are already in scope — they're in
`ConnectionCardProps`.)

- [ ] **Step 3: Define `LinkBrokerageButton`**

Add a new top-level component in `AccountsView.tsx` (place near `LoanCard` / `AssetCard`):

```tsx
const SNAPTRADE_FREE_TIER_LIMIT = 5;

interface LinkBrokerageButtonProps {
  connectionId: string;
  accounts: Account[];
  onLink: () => void;
}

function LinkBrokerageButton({ connectionId, accounts, onLink }: LinkBrokerageButtonProps) {
  const brokerageAccounts = accounts.filter(
    (a) => a.connectionId === connectionId,
  );
  const atLimit = brokerageAccounts.length >= SNAPTRADE_FREE_TIER_LIMIT;
  const label = brokerageAccounts.length === 0 ? 'Link a brokerage' : 'Link another brokerage';
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={onLink}
      disabled={atLimit}
      title={atLimit ? "You're at the 5-brokerage SnapTrade free tier limit." : undefined}
    >
      {label}
    </button>
  );
}
```

Note: `connectionCount` for SnapTrade tracks linked *brokerage authorizations*, not accounts. The pre-flight guardrail here uses the local account count as a proxy because the engine's `/accounts` shape doesn't expose the SnapTrade authorization count. The server-side `/portal` call still enforces the actual `atLimit` flag — this is a UX nicety, not a security boundary.

- [ ] **Step 4: Run the AccountsView tests**

Run: `cd Hon/web && npm test AccountsView`
Expected: existing tests pass.

- [ ] **Step 5: Typecheck**

Run: `cd Hon/web && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd Hon && git add web/src/accounts/AccountsView.tsx
git commit -m "$(cat <<'EOF'
web: accounts — Link-a-brokerage button on SnapTrade card

ConnectionCard renders a Link button for SnapTrade connections (text
flips to 'Link another' once an account is connected). Disabled with
tooltip at the 5-broker free tier limit. Server-side /portal still
enforces atLimit as the source of truth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Integration tests in AccountsView

**Files:**
- Modify: `web/src/accounts/AccountsView.test.tsx`

Cover the two entry paths end-to-end with mocked fetches.

- [ ] **Step 1: Add a new `describe('SnapTrade link flow', …)` block**

Open `web/src/accounts/AccountsView.test.tsx` and append:

```tsx
describe('SnapTrade link flow', () => {
  it('Add Account → SnapTrade routes to the link flow after creds save', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/companies': () => ({ companies: [
        { id: 'snaptrade', name: 'SnapTrade (brokerages)', loginFields: ['clientId', 'consumerKey'], type: 'brokerage', domain: 'snaptrade.com' },
      ] }),
      'GET /api/connections': () => ({ connections: [] }),
      'GET /api/accounts':    () => ({ accounts: [] }),
      'GET /api/assets':      () => ({ assets: [] }),
      'GET /api/loans':       () => ({ loans: [] }),
      'GET /api/brokerage':   () => ({ holdings: [] }),
      'POST /api/connections': () => ({ connection: { id: 'new-st-conn' } }),
      'POST /api/snaptrade/brokerages': () => ({ brokerages: [
        { slug: 'INTERACTIVE_BROKERS', name: 'Interactive Brokers' },
      ] }),
    });

    render(<AccountsView />);

    // Wait for initial /companies fetch.
    await screen.findByRole('button', { name: /add account/i });
    await user.click(screen.getByRole('button', { name: /add account/i }));
    await user.click(await screen.findByRole('button', { name: /SnapTrade/i }));

    // Credentials form
    await user.type(await screen.findByLabelText(/clientId/i), 'demo-cid');
    await user.type(screen.getByLabelText(/consumerKey/i), 'demo-key');
    await user.click(screen.getByRole('button', { name: /save|add/i }));

    // SnapTradeLinkFlow modal opens with the brokerage picker
    await screen.findByText(/link a brokerage/i);
    expect(await screen.findByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
  });

  it('SnapTrade ConnectionCard renders a Link button that opens the flow', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/companies': () => ({ companies: [
        { id: 'snaptrade', name: 'SnapTrade (brokerages)', loginFields: ['clientId', 'consumerKey'], type: 'brokerage', domain: 'snaptrade.com' },
      ] }),
      'GET /api/connections': () => ({ connections: [
        {
          id: 'existing-st',
          companyId: 'snaptrade',
          displayName: 'SnapTrade',
          createdAt: '2026-05-27T00:00:00Z',
          lastScrapeAt: null,
          lastStatus: null,
          hasCredentials: true,
        },
      ] }),
      'GET /api/accounts':    () => ({ accounts: [] }),
      'GET /api/assets':      () => ({ assets: [] }),
      'GET /api/loans':       () => ({ loans: [] }),
      'GET /api/brokerage':   () => ({ holdings: [] }),
      'POST /api/snaptrade/brokerages': () => ({ brokerages: [
        { slug: 'INTERACTIVE_BROKERS', name: 'Interactive Brokers' },
      ] }),
    });

    render(<AccountsView />);

    await user.click(await screen.findByRole('button', { name: /link a brokerage/i }));
    await screen.findByText(/link a brokerage/i);
    expect(await screen.findByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
  });
});
```

(Verified `Connection` shape from `web/src/accounts/types.ts`: `id`,
`companyId`, `displayName`, `createdAt`, `lastScrapeAt`, `lastStatus`,
`hasCredentials` — no `accountIds`, no `lastSync`.)

- [ ] **Step 2: Run the new tests**

Run: `cd Hon/web && npm test AccountsView`
Expected: both new tests pass alongside the existing ones.

If the first test fails on the credential form's submit button — check the actual button label (it might be `Add` or `Save` or specific to the company name like `Add SnapTrade (brokerages)`).

- [ ] **Step 3: Run the full web test suite**

Run: `cd Hon/web && npm test`
Expected: 292 (existing) + 6 (picker) + 6 (poll) + 3 (countdown) + 6 (link flow) + 2 (AccountsView additions) = **315 passing**.

Adjust the expected count if any test name shifted; the total should grow by ~23 vs the baseline 292.

- [ ] **Step 4: Typecheck**

Run: `cd Hon/web && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd Hon && git add web/src/accounts/AccountsView.test.tsx
git commit -m "$(cat <<'EOF'
web: accounts — integration tests for SnapTrade link flow

Covers both entry paths: Add Account → SnapTrade → credentials →
link-flow modal, and existing SnapTrade card → Link button →
link-flow modal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Manual smoke test

This is the only step that requires the engine running. Per HANDOFF: do NOT `preview_start`; the user runs their own vite dev server.

- [ ] **Step 1: Boot engine + vite**

```bash
pkill -9 -f 'tsx.*server\.ts|node.*web\.mjs' 2>/dev/null; sleep 0.5
cd Hon && npm run dev
```

You'll see `Engine → http://127.0.0.1:4000` and `Vite → http://localhost:5173/#token=…`. Open the Vite URL with the printed token in your browser.

- [ ] **Step 2: Verify Add Account → SnapTrade appears**

In the Assets tab, click **Add Account**. SnapTrade (brokerages) should be in the picker (it wasn't before this work). Click it.

- [ ] **Step 3: Enter SnapTrade dev credentials**

Use the dev SnapTrade clientId + consumerKey saved in your password manager (or generate new ones at the SnapTrade dashboard). Click Save.

- [ ] **Step 4: Confirm the link-flow modal opens**

After save, the credentials modal closes and the **Link a brokerage** modal opens with the searchable brokerage list. IBKR should appear pre-focused. Search for "interactive" — only IBKR remains.

- [ ] **Step 5: Click Interactive Brokers**

A new browser tab opens with `snaptrade.com/portal/…`. The Hon modal switches to the **Finish linking** panel with a 5-minute countdown. The Cancel button is visible.

- [ ] **Step 6: Finish the SnapTrade flow**

Sign into IBKR in the SnapTrade tab. When the SnapTrade success page renders, return to the Hon tab.

Within 3 seconds (one poll tick), Hon transitions to **Pulling your accounts…** and then to **Connected Interactive Brokers — N accounts added**.

Click **Done**.

- [ ] **Step 7: Verify accounts rendered**

In the Investments section of Assets, you should see IBKR accounts with their balances. The SnapTrade connection card should now show a **Link another brokerage** button.

- [ ] **Step 8: Test the at-limit guardrail (optional, requires 5 linked brokerages)**

If you've linked 5 brokerages already, the button on the card should be disabled with the tooltip "You're at the 5-brokerage SnapTrade free tier limit."

- [ ] **Step 9: Test the cancel path**

Click Add Account → SnapTrade → save creds (you can use the same ones; the engine self-heals). When the link flow opens, click Cancel. Modal closes, no new connection state.

- [ ] **Step 10: If anything broke, capture the engine log and debug**

```bash
tail -200 "$HOME/Library/Application Support/Hon/sidecar.log"
```

Per CLAUDE.md "Common debugging patterns": failures in the SnapTrade flow show up as `[server]` or `[snaptrade]` lines. If polling fires but the count never increases, check that the SnapTrade portal actually completed (sometimes the IBKR sign-in stalls inside the portal).

- [ ] **Step 11: Stop the engine**

```bash
pkill -9 -f 'tsx.*server\.ts|node.*web\.mjs'
```

- [ ] **Step 12: Final commit message — none needed**

No code changes in this task. If the smoke surfaced bugs, fix them inline (with TDD: add a failing test that captures the bug, then fix), commit per existing patterns. **Do NOT push** — per HANDOFF: `git commit freely, git push never without explicit go-ahead`.

---

## Done criteria

- [ ] All 10 tasks complete, each with its own commit.
- [ ] `cd Hon/web && npm test` shows ~315 passing.
- [ ] `cd Hon/sidecar && npm test` shows 55 passing (unchanged).
- [ ] `cd Hon/web && npm run typecheck` clean.
- [ ] `cd Hon/sidecar && npm run typecheck` clean.
- [ ] Manual smoke: Add Account → SnapTrade → link IBKR → accounts appear. Link another brokerage from the card → same flow works.
- [ ] No `--no-verify`, no force pushes, no amends of pushed commits.
- [ ] User says "push" before any `git push`.
