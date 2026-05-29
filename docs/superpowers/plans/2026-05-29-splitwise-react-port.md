# Splitwise React Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the legacy-SPA Splitwise feature to full parity in the React app (`web/`), and fix the H-3 locked-vault delete bug in the flow we touch.

**Architecture:** A self-fetching `useSplitwise` hook is the single source of truth for connection status, links, and friend balances; it syncs across mounted instances (Settings / Activity / Overview) via a `hon.splitwise-changed` window event — the same intra-tab signal pattern CLAUDE.md documents for `hon.loan-ids-changed`. UI follows existing React conventions: Radix Dialog for the split sheet, `ApiError` (status 409 = locked vault) for error branching, `installFetchMock` for tests.

**Tech Stack:** React 19 + TypeScript (strict) + Vitest + Testing Library + Radix UI. Backend is Fastify (sidecar) — only the H-3 route changes.

**Reference (read before starting):**
- Spec: `docs/superpowers/specs/2026-05-29-splitwise-react-port-design.md`
- Legacy UI: `sidecar/public/app.html` — `splitwiseSheet` (9665), `splitwiseCard` (9583), `splitwiseSectionHtml` (9623), `loadSplitwise` (9561).
- Backend contract: `sidecar/src/server.ts:835-1005`; types in `sidecar/src/repo.ts:251-270`.
- Patterns to mirror: `web/src/activity/ActivityView.tsx` `LoansSection` (984), `RefundSection` (1154); `web/src/api.ts`; `web/src/test/mockFetch.ts`.

**Conventions (PROJECT-RULES):** Work happens in worktree `.claude/worktrees/splitwise-react-2026-05-29`. No `VaultLocked` class exists in `web/` — branch on `err instanceof ApiError && err.status === 409`. Sidecar route handlers have **no test harness** (tests are pure-logic only) — H-3 is verified manually. Both `web` and `sidecar` typecheck + test must pass before each commit. Final UI verification via chrome-devtools + screenshot (PROJECT-RULES §2).

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `sidecar/src/server.ts` | Modify `:989-1005` | H-3: return 409 when vault locked + link exists |
| `web/src/splitwise/types.ts` | Create | Shared TS types matching the backend contract |
| `web/src/splitwise/useSplitwise.ts` | Create | Data hook: status/links/friends + actions + cross-instance sync |
| `web/src/splitwise/useSplitwise.test.ts` | Create | Hook tests |
| `web/src/splitwise/SplitwiseSheet.tsx` | Create | Radix split modal (friend + group flows) |
| `web/src/splitwise/SplitwiseSheet.test.tsx` | Create | Sheet tests |
| `web/src/settings/SplitwiseCard.tsx` | Replace | Connect (API key) / connected status / disconnect |
| `web/src/settings/SplitwiseCard.test.tsx` | Replace | Card tests |
| `web/src/activity/SplitwiseSection.tsx` | Create | Sidebar section: split / linked-state / unlink |
| `web/src/activity/SplitwiseSection.test.tsx` | Create | Section tests |
| `web/src/activity/ActivityView.tsx` | Modify | Mount `SplitwiseSection`; add "owed to you" row note |
| `web/src/overview/OwedToYouCard.tsx` | Create | Overview "Owed to you · via Splitwise" card |
| `web/src/overview/OwedToYouCard.test.tsx` | Create | Card tests |
| `web/src/overview/OverviewView.tsx` | Modify | Mount `OwedToYouCard` |

---

## Task 1: H-3 — locked-vault delete returns 409

**Files:**
- Modify: `sidecar/src/server.ts:989-1005`

No automated test (sidecar route handlers are tested manually per PROJECT-RULES §5).

- [ ] **Step 1: Apply the fix**

In `sidecar/src/server.ts`, change the DELETE handler. Replace:

```ts
  const link = repo.getSplitwiseLink(transactionId);
  const acct = loadSplitwiseAccount();
  if (link && acct) {
```

with:

```ts
  const link = repo.getSplitwiseLink(transactionId);
  const acct = loadSplitwiseAccount();
  // A locked vault means we cannot reach Splitwise to delete the remote
  // expense. Deleting only the local link would silently orphan the bill
  // for everyone it is shared with, so refuse — keep the link, surface 409.
  if (link && !acct) {
    return reply
      .code(409)
      .send({ error: 'unlock the credential vault to delete the linked Splitwise expense' });
  }
  if (link && acct) {
```

- [ ] **Step 2: Typecheck**

Run: `cd sidecar && npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Manual verification**

Run: `cd sidecar && npm test` (confirm pure-logic suite still green — 55+).
Then manually confirm against a running engine if available: with the vault locked and a transaction that has a Splitwise link, `DELETE /splitwise/expense/:id` returns HTTP 409 and the link survives. (Document in commit body that this was confirmed by code inspection if no locked-vault fixture is handy.)

- [ ] **Step 4: Commit**

```bash
git add sidecar/src/server.ts
git commit -m "fix(splitwise): reject locked-vault expense delete with 409 (H-3)"
```

---

## Task 2: Shared types + `useSplitwise` hook

**Files:**
- Create: `web/src/splitwise/types.ts`
- Create: `web/src/splitwise/useSplitwise.ts`
- Test: `web/src/splitwise/useSplitwise.test.ts`

- [ ] **Step 1: Write the types**

Create `web/src/splitwise/types.ts`:

```ts
// Web-side mirror of the sidecar Splitwise contract (sidecar/src/repo.ts +
// /splitwise/* routes). Splitwise ids are numeric; Hon transaction ids are
// strings.

export interface SplitwiseCounterparty {
  id: number;
  name: string;
  owed: number;
}

export interface SplitwiseLink {
  transactionId: string;
  expenseId: string;
  groupId: string | null;
  currency: string;
  owedToMe: number;
  counterparties: SplitwiseCounterparty[];
  paidAmount: number;
  /** 'open' | 'partial' | 'paid' */
  paidState: string;
  createdAt: string;
  syncedAt: string | null;
}

export interface SplitwiseUser {
  id: number;
  name: string;
}

export interface SplitwiseFriend {
  id: number;
  name: string;
}

export interface SplitwiseGroupMember {
  id: number;
  name: string;
}

export interface SplitwiseGroup {
  id: number;
  name: string;
  members: SplitwiseGroupMember[];
}

export interface SplitwisePickList {
  friends: SplitwiseFriend[];
  groups: SplitwiseGroup[];
  me: SplitwiseUser | null;
}

/** A friend with the balances the user is owed (from POST /splitwise/refresh). */
export interface SplitwiseFriendBalance {
  name: string;
  balances: { amount: number; currency: string }[];
}

/** One share line sent to POST /splitwise/expense. */
export interface SplitwiseShare {
  userId: number;
  name: string;
  owed: number;
}
```

- [ ] **Step 2: Write the failing hook tests**

Create `web/src/splitwise/useSplitwise.test.ts`:

```ts
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
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({
        links: [{
          transactionId: 't1', expenseId: 'e1', groupId: null, currency: 'ILS',
          owedToMe: 50, counterparties: [{ id: 2, name: 'Roomie', owed: 50 }],
          paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
        }],
      }),
      'POST /api/splitwise/refresh': () => ({
        friends: [{ name: 'Roomie', balances: [{ amount: 50, currency: 'ILS' }] }],
        links: [],
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
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/connect': () => ({ ok: true, user: { id: 9, name: 'Ada' } }),
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
    await expect(
      act(async () => { await result.current.connect('K'); }),
    ).rejects.toThrow(/vault/i);
    expect(result.current.vaultLocked).toBe(true);
  });
});
```

- [ ] **Step 2b: Run to verify it fails**

Run: `cd web && npm test -- useSplitwise`
Expected: FAIL — `useSplitwise` / `__resetSplitwiseCache` not exported.

- [ ] **Step 3: Implement the hook**

Create `web/src/splitwise/useSplitwise.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  SplitwiseFriendBalance, SplitwiseLink, SplitwisePickList, SplitwiseShare, SplitwiseUser,
} from './types';

// Module-level cache so the Settings, Activity, and Overview consumers share
// one fetched copy. A 'hon.splitwise-changed' window event tells every mounted
// hook to re-read after a mutation — the same intra-tab signal pattern as
// 'hon.loan-ids-changed' (the browser 'storage' event is cross-tab only).
const CHANGED = 'hon.splitwise-changed';

interface CacheShape {
  loaded: boolean;
  connected: boolean;
  user: SplitwiseUser | null;
  links: SplitwiseLink[];
  friends: SplitwiseFriendBalance[];
}

let cache: CacheShape = {
  loaded: false, connected: false, user: null, links: [], friends: [],
};
let inFlight: Promise<void> | null = null;

/** Test-only: wipe the module cache between cases. */
export function __resetSplitwiseCache(): void {
  cache = { loaded: false, connected: false, user: null, links: [], friends: [] };
  inFlight = null;
}

function broadcast(): void {
  window.dispatchEvent(new Event(CHANGED));
}

function isLocked(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

async function fetchAll(): Promise<void> {
  const [status, links] = await Promise.all([
    api<{ connected: boolean; user: SplitwiseUser | null }>('/splitwise/status'),
    api<{ links: SplitwiseLink[] }>('/splitwise/links'),
  ]);
  cache = {
    loaded: true,
    connected: !!status.connected,
    user: status.user ?? null,
    links: links.links ?? [],
    friends: cache.friends,
  };
  broadcast();
  if (!cache.connected) return;
  try {
    const r = await api<{ friends: SplitwiseFriendBalance[]; links: SplitwiseLink[] }>(
      '/splitwise/refresh', 'POST',
    );
    cache = { ...cache, friends: r.friends ?? [], links: r.links ?? cache.links };
    broadcast();
  } catch { /* balances are best-effort — never block the dashboard */ }
}

function ensureLoaded(): void {
  if (cache.loaded || inFlight) return;
  inFlight = fetchAll().finally(() => { inFlight = null; });
}

export interface UseSplitwise {
  loading: boolean;
  connected: boolean;
  user: SplitwiseUser | null;
  links: SplitwiseLink[];
  friends: SplitwiseFriendBalance[];
  linkByTxnId: Map<string, SplitwiseLink>;
  vaultLocked: boolean;
  reload: () => Promise<void>;
  connect: (apiKey: string) => Promise<void>;
  disconnect: () => Promise<void>;
  loadPickList: () => Promise<SplitwisePickList>;
  createExpense: (
    transactionId: string, groupId: number | null, shares: SplitwiseShare[],
  ) => Promise<void>;
  deleteExpense: (transactionId: string) => Promise<void>;
}

export function useSplitwise(): UseSplitwise {
  const [, force] = useState(0);
  const [vaultLocked, setVaultLocked] = useState(false);

  useEffect(() => {
    const onChange = (): void => force((n) => n + 1);
    window.addEventListener(CHANGED, onChange);
    ensureLoaded();
    return () => window.removeEventListener(CHANGED, onChange);
  }, []);

  const reload = useCallback(async () => {
    cache = { ...cache, loaded: false };
    await fetchAll();
  }, []);

  const guard = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    try { await fn(); }
    catch (err) { if (isLocked(err)) setVaultLocked(true); throw err; }
  }, []);

  const connect = useCallback((apiKey: string) => guard(async () => {
    const r = await api<{ user: SplitwiseUser | null }>('/splitwise/connect', 'POST', { apiKey });
    cache = { ...cache, connected: true, user: r.user ?? cache.user };
    broadcast();
    await fetchAll();
  }), [guard]);

  const disconnect = useCallback(() => guard(async () => {
    await api('/splitwise/disconnect', 'POST');
    cache = { loaded: true, connected: false, user: null, links: [], friends: [] };
    broadcast();
  }), [guard]);

  const loadPickList = useCallback(async (): Promise<SplitwisePickList> => {
    try { return await api<SplitwisePickList>('/splitwise/groups'); }
    catch (err) { if (isLocked(err)) setVaultLocked(true); throw err; }
  }, []);

  const createExpense = useCallback((
    transactionId: string, groupId: number | null, shares: SplitwiseShare[],
  ) => guard(async () => {
    const r = await api<{ link: SplitwiseLink }>('/splitwise/expense', 'POST', {
      transactionId, groupId, shares,
    });
    cache = {
      ...cache,
      links: cache.links.filter((l) => l.transactionId !== transactionId).concat([r.link]),
    };
    broadcast();
  }), [guard]);

  const deleteExpense = useCallback((transactionId: string) => guard(async () => {
    await api(`/splitwise/expense/${encodeURIComponent(transactionId)}`, 'DELETE');
    cache = {
      ...cache,
      links: cache.links.filter((l) => l.transactionId !== transactionId),
    };
    broadcast();
  }), [guard]);

  const linkByTxnId = new Map(cache.links.map((l) => [l.transactionId, l]));

  return {
    loading: !cache.loaded,
    connected: cache.connected,
    user: cache.user,
    links: cache.links,
    friends: cache.friends,
    linkByTxnId,
    vaultLocked,
    reload,
    connect,
    disconnect,
    loadPickList,
    createExpense,
    deleteExpense,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test -- useSplitwise`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd web && npm run typecheck
git add web/src/splitwise/types.ts web/src/splitwise/useSplitwise.ts web/src/splitwise/useSplitwise.test.ts
git commit -m "feat(splitwise): add shared types + useSplitwise data hook"
```

---

## Task 3: `SplitwiseCard` (Settings) — connect / disconnect

**Files:**
- Replace: `web/src/settings/SplitwiseCard.tsx`
- Replace: `web/src/settings/SplitwiseCard.test.tsx`

- [ ] **Step 1: Rewrite the tests**

Replace `web/src/settings/SplitwiseCard.test.tsx`:

```ts
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
    const connect = vi.fn(() => ({ ok: true, user: { id: 1, name: 'Ada' } }));
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/connect': (body) => connect(body as never),
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- SplitwiseCard`
Expected: FAIL — the stub renders "Coming soon", no API-key field.

- [ ] **Step 3: Rewrite the component**

Replace `web/src/settings/SplitwiseCard.tsx`:

```tsx
import { useState } from 'react';
import { useSplitwise } from '../splitwise/useSplitwise';

// Connect Splitwise with a personal API key, or disconnect. The key is sent to
// the engine and stored encrypted in the vault — it never leaves the machine.
export function SplitwiseCard() {
  const sw = useSplitwise();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async (): Promise<void> => {
    if (!apiKey.trim()) { setError('Paste your Splitwise API key first.'); return; }
    setBusy(true); setError(null);
    try { await sw.connect(apiKey.trim()); setApiKey(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const onDisconnect = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { await sw.disconnect(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <section className="set-card set-card--wide">
      <div className="set-card-head">
        <span className="set-ico">🤝</span>
        <h3>Splitwise</h3>
      </div>
      {sw.connected ? (
        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-name">
              Connected{sw.user ? ` as ${sw.user.name}` : ''}
            </div>
            <div className="set-row-sub">
              Hon can split transactions onto Splitwise and track who has paid you back.
            </div>
          </div>
          <button
            type="button" className="btn-danger-sm" disabled={busy}
            onClick={() => void onDisconnect()}
          >Disconnect</button>
        </div>
      ) : (
        <>
          <p className="set-hint">
            Split transactions onto Splitwise and track repayments. Get a free
            personal API key from{' '}
            <a
              href="https://secure.splitwise.com/apps" target="_blank" rel="noreferrer"
            >your Splitwise apps page</a>.
          </p>
          <div className="field">
            <label htmlFor="sw-api-key">API key</label>
            <input
              id="sw-api-key" type="password" value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="paste your Splitwise API key"
              disabled={busy}
            />
          </div>
          <div className="form-actions">
            <button
              type="button" className="btn-primary" disabled={busy}
              onClick={() => void onConnect()}
            >Connect</button>
          </div>
        </>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
    </section>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test -- SplitwiseCard`
Expected: PASS (3 tests).

- [ ] **Step 5: Update SettingsView test + typecheck + commit**

The existing `web/src/settings/SettingsView.test.tsx` already expects a "Splitwise" heading — confirm it still passes:
Run: `cd web && npm test -- SettingsView && npm run typecheck`
Expected: PASS.

```bash
git add web/src/settings/SplitwiseCard.tsx web/src/settings/SplitwiseCard.test.tsx
git commit -m "feat(splitwise): real Settings card — connect/disconnect"
```

---

## Task 4: `SplitwiseSheet` — the split modal

**Files:**
- Create: `web/src/splitwise/SplitwiseSheet.tsx`
- Test: `web/src/splitwise/SplitwiseSheet.test.tsx`

Ports the legacy 3-step flow (`app.html:9665`): pick (friends/groups) → configure (friend: amount owed, default cost/2; group: equal split among ticked members + you) → create.

- [ ] **Step 1: Write the failing tests**

Create `web/src/splitwise/SplitwiseSheet.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SplitwiseSheet } from './SplitwiseSheet';
import type { SplitwisePickList } from './types';
import type { Transaction } from '../activity/types';

const txn = {
  id: 't1', description: 'Dinner', amount: -100, currency: 'ILS', date: '2026-05-10',
} as unknown as Transaction;

const pickList: SplitwisePickList = {
  me: { id: 1, name: 'Me' },
  friends: [{ id: 2, name: 'Roomie' }],
  groups: [{ id: 9, name: 'Flat', members: [
    { id: 1, name: 'Me' }, { id: 2, name: 'Roomie' }, { id: 3, name: 'Sam' },
  ] }],
};

afterEach(() => vi.restoreAllMocks());

function setup(overrides: Partial<Parameters<typeof SplitwiseSheet>[0]> = {}) {
  const onCreate = vi.fn(async () => {});
  const loadPickList = vi.fn(async () => pickList);
  render(
    <SplitwiseSheet
      open transaction={txn} loadPickList={loadPickList}
      onCreate={onCreate} onClose={() => {}} {...overrides}
    />,
  );
  return { onCreate, loadPickList };
}

describe('SplitwiseSheet', () => {
  it('friend flow defaults owed to half and creates with one share', async () => {
    const { onCreate } = setup();
    await userEvent.click(await screen.findByText('Roomie'));
    const owed = await screen.findByLabelText(/owe you/i) as HTMLInputElement;
    expect(owed.value).toBe('50.00');
    await userEvent.click(screen.getByRole('button', { name: /add to splitwise/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      null, [{ userId: 2, name: 'Roomie', owed: 50 }],
    ));
  });

  it('group flow splits equally among ticked members + you', async () => {
    const { onCreate } = setup();
    await userEvent.click(await screen.findByText('Flat'));
    // Both other members ticked by default → split 3 ways → 33.333…
    await userEvent.click(await screen.findByRole('button', { name: /add to splitwise/i }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
      const [groupId, shares] = onCreate.mock.calls[0];
      expect(groupId).toBe(9);
      expect(shares).toHaveLength(2);
      expect(shares[0].owed).toBeCloseTo(100 / 3, 5);
    });
  });

  it('friend flow rejects an owed amount over the cost', async () => {
    const { onCreate } = setup();
    await userEvent.click(await screen.findByText('Roomie'));
    const owed = await screen.findByLabelText(/owe you/i);
    await userEvent.clear(owed);
    await userEvent.type(owed, '150');
    await userEvent.click(screen.getByRole('button', { name: /add to splitwise/i }));
    expect(await screen.findByText(/more than the expense/i)).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- SplitwiseSheet`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sheet**

Create `web/src/splitwise/SplitwiseSheet.tsx`:

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { money } from '../format';
import type { Transaction } from '../activity/types';
import type { SplitwisePickList, SplitwiseShare } from './types';

interface Props {
  open: boolean;
  transaction: Transaction;
  loadPickList: () => Promise<SplitwisePickList>;
  onCreate: (groupId: number | null, shares: SplitwiseShare[]) => Promise<void>;
  onClose: () => void;
}

type Picked =
  | { kind: 'friend'; id: number; name: string }
  | { kind: 'group'; id: number; name: string; members: { id: number; name: string }[] };

export function SplitwiseSheet({ open, transaction, loadPickList, onCreate, onClose }: Props) {
  const cost = Math.abs(transaction.amount);
  const [data, setData] = useState<SplitwisePickList | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Picked | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null); setLoadErr(null); setPick(null);
    let live = true;
    loadPickList()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setLoadErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [open, loadPickList]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay" />
        <Dialog.Content className="rx-dialog rx-dialog-sm" aria-label="Split on Splitwise">
          <Dialog.Title>
            {pick ? `Split with ${pick.name}` : 'Split on Splitwise'}
          </Dialog.Title>
          <Dialog.Description className="rx-dialog-desc">
            {transaction.description} · {money(cost, transaction.currency)}
          </Dialog.Description>

          {loadErr && <p className="set-error" role="alert">{loadErr}</p>}
          {!loadErr && !data && <p className="rx-dialog-desc">Loading your friends and groups…</p>}

          {data && !pick && (
            <PickStep
              data={data}
              onPickFriend={(f) => setPick({ kind: 'friend', id: f.id, name: f.name })}
              onPickGroup={(g) =>
                setPick({ kind: 'group', id: g.id, name: g.name, members: g.members })}
            />
          )}

          {data && pick?.kind === 'friend' && (
            <FriendStep
              cost={cost} currency={transaction.currency} name={pick.name}
              onBack={() => setPick(null)}
              onCreate={(owed) => onCreate(null, [{ userId: pick.id, name: pick.name, owed }])}
            />
          )}

          {data && pick?.kind === 'group' && (
            <GroupStep
              cost={cost} currency={transaction.currency} meId={data.me?.id ?? null}
              group={pick}
              onBack={() => setPick(null)}
              onCreate={(shares) => onCreate(pick.id, shares)}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PickStep({ data, onPickFriend, onPickGroup }: {
  data: SplitwisePickList;
  onPickFriend: (f: { id: number; name: string }) => void;
  onPickGroup: (g: { id: number; name: string; members: { id: number; name: string }[] }) => void;
}) {
  if (data.friends.length === 0 && data.groups.length === 0) {
    return <p className="set-error">No Splitwise friends or groups — add some in the Splitwise app first.</p>;
  }
  return (
    <>
      {data.friends.length > 0 && <div className="label sb-label">Friends</div>}
      {data.friends.map((f) => (
        <button key={f.id} type="button" className="loan-pick-row" onClick={() => onPickFriend(f)}>
          <span className="loan-pick-name">🧑 {f.name}</span>
        </button>
      ))}
      {data.groups.length > 0 && <div className="label sb-label">Groups</div>}
      {data.groups.map((g) => (
        <button key={g.id} type="button" className="loan-pick-row" onClick={() => onPickGroup(g)}>
          <span className="loan-pick-name">👥 {g.name}</span>
        </button>
      ))}
    </>
  );
}

function FriendStep({ cost, currency, name, onBack, onCreate }: {
  cost: number; currency: string; name: string;
  onBack: () => void; onCreate: (owed: number) => Promise<void>;
}) {
  const [owed, setOwed] = useState((cost / 2).toFixed(2));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = Number(owed);

  const submit = async (): Promise<void> => {
    if (!Number.isFinite(v) || v <= 0) { setErr(`Enter how much ${name} owes you.`); return; }
    if (v > cost + 0.001) { setErr('That is more than the expense.'); return; }
    setBusy(true); setErr(null);
    try { await onCreate(v); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="field">
        <label htmlFor="sw-owed">How much does {name} owe you?</label>
        <input
          id="sw-owed" type="number" min="0" step="0.01" value={owed}
          onChange={(e) => setOwed(e.target.value)}
        />
      </div>
      <p className="sub-hint">
        You keep {money(Math.max(0, cost - (Number.isFinite(v) ? v : 0)), currency)}; {name} owes
        you {money(Number.isFinite(v) ? Math.min(cost, Math.max(0, v)) : 0, currency)}.
      </p>
      {err && <p className="set-error" role="alert">{err}</p>}
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={onBack}>‹ Back</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>
          Add to Splitwise
        </button>
      </div>
    </>
  );
}

function GroupStep({ cost, currency, meId, group, onBack, onCreate }: {
  cost: number; currency: string; meId: number | null;
  group: { members: { id: number; name: string }[] };
  onBack: () => void; onCreate: (shares: SplitwiseShare[]) => Promise<void>;
}) {
  const others = group.members.filter((m) => m.id !== meId);
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(others.map((m) => m.id)));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (others.length === 0) {
    return <p className="set-error">That group has no one else in it to split with.</p>;
  }
  const n = ticked.size + 1; // +1 for you
  const share = cost / n;

  const toggle = (id: number): void => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async (): Promise<void> => {
    if (ticked.size === 0) { setErr('Tick at least one person.'); return; }
    setBusy(true); setErr(null);
    const shares: SplitwiseShare[] = others
      .filter((m) => ticked.has(m.id))
      .map((m) => ({ userId: m.id, name: m.name, owed: cost / (ticked.size + 1) }));
    try { await onCreate(shares); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="sw-members">
        {others.map((m) => (
          <label key={m.id} className="sw-member">
            <input type="checkbox" checked={ticked.has(m.id)} onChange={() => toggle(m.id)} />
            <span>{m.name}</span>
          </label>
        ))}
      </div>
      <p className="sub-hint">
        Each of {n} pays {money(share, currency)}; you're owed {money(cost - share, currency)}.
      </p>
      {err && <p className="set-error" role="alert">{err}</p>}
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={onBack}>‹ Back</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>
          Add to Splitwise
        </button>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test -- SplitwiseSheet`
Expected: PASS (3 tests). If Radix Dialog needs jsdom pointer polyfills they already exist in `web/src/test/setup.ts`.

- [ ] **Step 5: Typecheck + commit**

```bash
cd web && npm run typecheck
git add web/src/splitwise/SplitwiseSheet.tsx web/src/splitwise/SplitwiseSheet.test.tsx
git commit -m "feat(splitwise): split sheet — friend + group flows"
```

---

## Task 5: `SplitwiseSection` (Activity sidebar) + wire into ActivityView

**Files:**
- Create: `web/src/activity/SplitwiseSection.tsx`
- Test: `web/src/activity/SplitwiseSection.test.tsx`
- Modify: `web/src/activity/ActivityView.tsx:937-943` (replace the disabled stub)

- [ ] **Step 1: Write the failing tests**

Create `web/src/activity/SplitwiseSection.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { SplitwiseSection } from './SplitwiseSection';
import type { Transaction } from './types';

const txn = { id: 't1', description: 'Dinner', amount: -100, currency: 'ILS', date: '2026-05-10' } as unknown as Transaction;

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); });

describe('SplitwiseSection', () => {
  it('renders nothing when Splitwise is not connected', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
    });
    const { container } = render(<SplitwiseSection transaction={txn} />);
    // Hook resolves async; section stays empty when disconnected.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.txn-sidebar-section')).toBeNull();
  });

  it('offers "+ Split on Splitwise" when connected and unlinked', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [] }),
    });
    render(<SplitwiseSection transaction={txn} />);
    expect(await screen.findByRole('button', { name: /split on splitwise/i })).toBeEnabled();
  });

  it('shows owed amount + unlink when the transaction is linked', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [{
        transactionId: 't1', expenseId: 'e1', groupId: null, currency: 'ILS',
        owedToMe: 50, counterparties: [{ id: 2, name: 'Roomie', owed: 50 }],
        paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
      }] }),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [{
        transactionId: 't1', expenseId: 'e1', groupId: null, currency: 'ILS',
        owedToMe: 50, counterparties: [{ id: 2, name: 'Roomie', owed: 50 }],
        paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
      }] }),
    });
    render(<SplitwiseSection transaction={txn} />);
    expect(await screen.findByText(/owed to you/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete from splitwise/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- SplitwiseSection`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the section**

Create `web/src/activity/SplitwiseSection.tsx`:

```tsx
import { useState } from 'react';
import { money } from '../format';
import { useSplitwise } from '../splitwise/useSplitwise';
import { SplitwiseSheet } from '../splitwise/SplitwiseSheet';
import type { Transaction } from './types';

// The Splitwise block in a transaction's sidebar. Hidden entirely until
// Splitwise is connected. Unlinked → opens the split sheet; linked → shows the
// outstanding balance + a delete button (which removes the expense remotely too).
export function SplitwiseSection({ transaction }: { transaction: Transaction }) {
  const sw = useSplitwise();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sw.connected) return null;

  const link = sw.linkByTxnId.get(transaction.id);
  const remaining = link ? Math.max(0, link.owedToMe - (link.paidAmount || 0)) : 0;
  const who = link ? link.counterparties.map((c) => c.name).join(', ') : '';

  const onUnlink = async (): Promise<void> => {
    if (!window.confirm(
      'Delete this expense from Splitwise? It will be removed for everyone it is shared with.',
    )) return;
    setBusy(true); setError(null);
    try { await sw.deleteExpense(transaction.id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="txn-sidebar-section">
      <div className="label">Splitwise</div>
      {link ? (
        <div className="rf-linked">
          <div className="rf-linked-name">
            {link.paidState === 'paid'
              ? 'Paid back'
              : `${money(remaining, link.currency)} owed to you`}
            {who && <span className="txn-sub"> · {who}</span>}
          </div>
          <button
            type="button" className="rf-unlink" aria-label="Delete from Splitwise"
            disabled={busy} onClick={() => void onUnlink()}
          >✕</button>
        </div>
      ) : (
        <button type="button" className="txn-sidebar-action" onClick={() => setOpen(true)}>
          + Split on Splitwise
        </button>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
      <SplitwiseSheet
        open={open}
        transaction={transaction}
        loadPickList={sw.loadPickList}
        onCreate={async (groupId, shares) => {
          await sw.createExpense(transaction.id, groupId, shares);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
```

- [ ] **Step 4: Wire into ActivityView**

In `web/src/activity/ActivityView.tsx`, add the import after the existing local imports (near line 13):

```tsx
import { SplitwiseSection } from './SplitwiseSection';
```

Replace the stub block at lines 937-943:

```tsx
            <div className="txn-sidebar-section">
              <div className="label">Splitwise</div>
              <button type="button" className="txn-sidebar-action" disabled>
                + Split on Splitwise
              </button>
              <p className="txn-sidebar-hint">Coming soon.</p>
            </div>
```

with:

```tsx
            <SplitwiseSection transaction={transaction} />
```

(The local variable in that sidebar scope is `transaction` — confirm by checking the surrounding `RefundSection`/`LoansSection` props, which pass `transaction={transaction}`.)

- [ ] **Step 5: Run to verify it passes**

Run: `cd web && npm test -- SplitwiseSection && npm test -- ActivityView`
Expected: PASS. (The existing `ActivityView.test.tsx:447` checks that the Splitwise section disappears when the category picker takes over — keep that behavior; the section is inside the same sidebar block.)

- [ ] **Step 6: Typecheck + commit**

```bash
cd web && npm run typecheck
git add web/src/activity/SplitwiseSection.tsx web/src/activity/SplitwiseSection.test.tsx web/src/activity/ActivityView.tsx
git commit -m "feat(splitwise): activity sidebar section — split, linked state, unlink"
```

---

## Task 6: "owed to you" note on activity rows

**Files:**
- Modify: `web/src/activity/ActivityView.tsx` (txn-row rendering)

The legacy `splitwiseNote(t)` (app.html:9548) appends "· ₪X owed to you" / "· paid back" under a split row. Add the equivalent to the React row.

- [ ] **Step 1: Locate the row meta render**

Run: `grep -n "txn-sub\|txn-meta\|row.category\|t.category" web/src/activity/ActivityView.tsx | head`
Identify where each transaction row renders its sub-line (category / date). Read ~15 lines around it to get the exact JSX and the loop variable name (likely `t`).

- [ ] **Step 2: Add a helper near the top-level module scope (after `fmtDate`)**

```tsx
import type { SplitwiseLink } from '../splitwise/types';

/** "· ₪X owed to you" / "· paid back" suffix for a split row, else null. */
function splitwiseNote(link: SplitwiseLink | undefined): string | null {
  if (!link) return null;
  if (link.paidState === 'paid') return 'paid back';
  const remaining = Math.max(0, link.owedToMe - (link.paidAmount || 0));
  return `${money(remaining, link.currency)} owed to you`;
}
```

- [ ] **Step 3: Pull the link map into the row render**

In `ActivityView`, call the hook once near the other state:

```tsx
  const sw = useSplitwise();
```

(import: `import { useSplitwise } from '../splitwise/useSplitwise';`)

In the row JSX sub-line, append the note (adapt the surrounding element to whatever the row uses — example assuming a `.txn-sub` span and loop var `t`):

```tsx
            {(() => {
              const note = splitwiseNote(sw.linkByTxnId.get(t.id));
              return note ? <span className="txn-sw"> · {note}</span> : null;
            })()}
```

- [ ] **Step 4: Add a test to ActivityView.test.tsx**

Append a case that mocks `/splitwise/status` connected + a link for a visible transaction and asserts "owed to you" appears in the list. Mirror the existing fetch-mock setup already in that file (add the three `/api/splitwise/*` routes to whatever `installFetchMock` map the list-render test uses, since unmocked calls throw).

- [ ] **Step 5: Run + typecheck**

Run: `cd web && npm test -- ActivityView && npm run typecheck`
Expected: PASS. If existing ActivityView tests now throw "unmocked fetch: GET /api/splitwise/status", add the three Splitwise routes (`status`→`{connected:false}`, `links`→`{links:[]}`) to those tests' mock maps so the hook's load resolves quietly.

- [ ] **Step 6: Commit**

```bash
git add web/src/activity/ActivityView.tsx web/src/activity/ActivityView.test.tsx
git commit -m "feat(splitwise): owed-to-you note on split activity rows"
```

---

## Task 7: `OwedToYouCard` (Overview)

**Files:**
- Create: `web/src/overview/OwedToYouCard.tsx`
- Test: `web/src/overview/OwedToYouCard.test.tsx`
- Modify: `web/src/overview/OverviewView.tsx`

Ports the legacy `splitwiseCard()` (app.html:9583): friends who currently owe the user, else "all settled up". Hidden when not connected.

- [ ] **Step 1: Write the failing tests**

Create `web/src/overview/OwedToYouCard.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { OwedToYouCard } from './OwedToYouCard';

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); });

describe('OwedToYouCard', () => {
  it('renders nothing when not connected', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: false, user: null }),
      'GET /api/splitwise/links': () => ({ links: [] }),
    });
    const { container } = render(<OwedToYouCard />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.card')).toBeNull();
  });

  it('lists friends with positive balances', async () => {
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [] }),
      'POST /api/splitwise/refresh': () => ({ links: [], friends: [
        { name: 'Roomie', balances: [{ amount: 50, currency: 'ILS' }] },
        { name: 'Owes nothing', balances: [{ amount: -10, currency: 'ILS' }] },
      ] }),
    });
    render(<OwedToYouCard />);
    expect(await screen.findByText('Roomie')).toBeInTheDocument();
    expect(screen.queryByText('Owes nothing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- OwedToYouCard`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the card**

Create `web/src/overview/OwedToYouCard.tsx`:

```tsx
import { money } from '../format';
import { useSplitwise } from '../splitwise/useSplitwise';

// Overview card: Splitwise friends who currently owe the user money. Hidden
// until Splitwise is connected; "all settled up" when no one owes anything.
export function OwedToYouCard() {
  const sw = useSplitwise();
  if (!sw.connected) return null;

  const owing = sw.friends
    .map((f) => ({ name: f.name, owed: f.balances.filter((b) => b.amount > 0) }))
    .filter((f) => f.owed.length > 0);

  return (
    <section className="card">
      <div className="card-head">
        <h3>Owed to you</h3>
        <span className="spacer" />
        <span className="meta">via Splitwise</span>
      </div>
      {owing.length > 0 ? (
        <div className="list">
          {owing.map((f) => (
            <div key={f.name} className="row">
              <div className="name">{f.name}</div>
              <span className="amount pos">
                {f.owed.map((b) => money(b.amount, b.currency)).join(' · ')}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">You're all settled up on Splitwise.</div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test -- OwedToYouCard`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount in OverviewView**

Run: `grep -n "return (\|<section\|className=\"overview" web/src/overview/OverviewView.tsx | head`
Read the JSX return to find where cards are laid out. Add the import:

```tsx
import { OwedToYouCard } from './OwedToYouCard';
```

and place `<OwedToYouCard />` among the other Overview cards (after the bank-projection / summary cards — match the existing card container). If OverviewView has its own `installFetchMock` tests, add `status`→`{connected:false}` + `links`→`{links:[]}` routes so the hook's load doesn't throw "unmocked fetch".

- [ ] **Step 6: Run + typecheck**

Run: `cd web && npm test -- OverviewView && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/overview/OwedToYouCard.tsx web/src/overview/OwedToYouCard.test.tsx web/src/overview/OverviewView.tsx
git commit -m "feat(splitwise): Overview 'Owed to you' card"
```

---

## Task 8: Full-suite green, live verification, HANDOFF update

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Full test + typecheck sweep**

Run:
```bash
cd web && npm test && npm run typecheck
cd ../sidecar && npm test && npm run typecheck
```
Expected: all green. Fix any "unmocked fetch: GET /api/splitwise/*" failures by adding the three Splitwise routes to that test's mock map (the hook auto-loads on mount in any view that now calls it).

- [ ] **Step 2: Live UI verification (PROJECT-RULES §2 — mandatory)**

Confirm chrome-devtools MCP is connected (launch headed Chrome on :9222 per PROJECT-RULES §2 if not). Read the dev token from `~/Library/Application Support/Hon/dev-token`, navigate to `http://localhost:5173/#token=<TOKEN>`, then:
- Settings → Splitwise card renders connect form (or connected state).
- Activity → open a transaction → "+ Split on Splitwise" present (when connected).
- Overview → "Owed to you" card present (when connected).
Take a screenshot of each and `Read` it. Do not claim done until the screenshots confirm render. If Splitwise isn't connected in the dev DB, verify at least the not-connected states render correctly and note that the connected flow needs a real API key to exercise end-to-end.

- [ ] **Step 3: Update HANDOFF.md**

Move "Splitwise card body in Settings + Activity sidebar Splitwise section" out of the deferred list; add a shipped-this-session entry noting: React Splitwise parity (Settings connect/disconnect, split sheet, sidebar section + unlink, owed-to-you note, Overview card) + H-3 fix. Reference the spec/plan paths.

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: HANDOFF — Splitwise React port shipped"
```

- [ ] **Step 5: Present the branch diff for merge decision**

Per PROJECT-RULES §3, show `git log --oneline main..HEAD` and `git diff main...HEAD --stat`; let Shahar decide merge / PR / keep-on-branch. Do not push or merge without explicit instruction.

---

## Self-Review

**Spec coverage:** Full parity decision → Tasks 3 (Settings), 4+5 (split sheet + sidebar), 5 (unlink), 6 (row note), 7 (Overview card). Inline-connect decision → Task 3. H-3 fix → Task 1. Data hook + cross-instance sync → Task 2. All spec sections map to a task.

**Placeholder scan:** Tasks 6 and 7 Step-1/Step-5 ask the engineer to grep for the exact row/card render site rather than hard-coding line numbers, because those JSX sites weren't fully read during planning — the surrounding code and loop-variable names are given so the insertion is unambiguous. All component code is complete (no TODO/TBD).

**Type consistency:** `SplitwiseLink`/`SplitwiseShare`/`SplitwisePickList` defined in Task 2 `types.ts` and used unchanged in Tasks 4–7. Hook method names (`connect`, `disconnect`, `loadPickList`, `createExpense`, `deleteExpense`, `linkByTxnId`) are identical across the hook definition and every consumer. `createExpense(transactionId, groupId, shares)` signature matches the POST body the backend expects (`{ transactionId, groupId, shares }`). Backend `groupId` is numeric in the request, stored as string in the link — handled (hook passes `number | null`; server coerces).
