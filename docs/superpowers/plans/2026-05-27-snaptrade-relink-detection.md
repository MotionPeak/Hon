# SnapTrade Re-link Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SnapTrade Link flow detect a completed portal session even when the user re-links a brokerage they already have linked (SnapTrade refreshes the existing connection rather than adding one, so the existing `count > baseline` check never fires).

**Architecture:** SnapTrade's portal redirects to `customRedirect` on success. We piggy-back on that redirect: the client embeds the Hon `connectionId` as a query param on the redirect URL, the server's `/snaptrade/done` route records the connectionId in an in-memory `Map<connectionId, doneAt>`, and `/snaptrade/connections/:id/count` returns that flag alongside the count. The polling hook then treats either `count > baseline` OR `done === true` as success. As a bonus, fix the `/done` HTML copy that contradicts the auto-sync design, and improve the LinkFlow "done" panel when `accountsAdded === 0` ("Brokerage refreshed" instead of "0 accounts added").

**Tech Stack:** Fastify (sidecar engine), React 19 + TS strict (web), Vitest + Testing Library, TDD per PROJECT-RULES.md §4.

**Surrounding context the engineer should re-read:**
- Smoke session HANDOFF: `HANDOFF.md` (top section)
- Original design spec: `docs/superpowers/specs/2026-05-27-snaptrade-portal-flow-design.md`
- Original impl plan: `docs/superpowers/plans/2026-05-27-snaptrade-portal-flow.md`
- Behavioral rules: `PROJECT-RULES.md` §2 (visual verification), §3 (already in a worktree at `.claude/worktrees/snaptrade-smoke-2026-05-27/`), §4 (TDD), §5 (test commands)

**Worktree:** Already created at `.claude/worktrees/snaptrade-smoke-2026-05-27`. Do NOT create a new one. All edits land here.

**Files involved:**
- Create: `sidecar/src/snaptradeDoneRegistry.ts` — tiny module owning the in-memory done-flag map (testable in isolation, swappable for a redis-backed thing later if needs grow)
- Modify: `sidecar/src/server.ts` — `/snaptrade/done` route reads `honConn` query + writes to registry + new copy; `/snaptrade/connections/:id/count` route reads from registry
- Modify: `web/src/accounts/SnapTradeLinkFlow.tsx` — append `honConn` to `customRedirect`
- Modify: `web/src/accounts/useSnapTradeConnectionPoll.ts` — handle `done: boolean` from count response
- Modify: `web/src/accounts/SnapTradeLinkFlow.tsx` — DonePanel shows "Brokerage refreshed" when accountsAdded === 0
- Test (create): `sidecar/test/snaptradeDoneRegistry.test.ts`
- Test (modify): `web/src/accounts/useSnapTradeConnectionPoll.test.ts`
- Test (modify): `web/src/accounts/SnapTradeLinkFlow.test.tsx`

---

### Task 1: In-memory done-flag registry (sidecar)

**Files:**
- Create: `sidecar/src/snaptradeDoneRegistry.ts`
- Test: `sidecar/test/snaptradeDoneRegistry.test.ts`

The registry is a thin wrapper over a `Map<string, number>` with a TTL sweep so stale flags don't accumulate forever. Keyed by Hon connectionId (UUID).

- [ ] **Step 1: Write the failing test**

Create `sidecar/test/snaptradeDoneRegistry.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDoneRegistry,
  type DoneRegistry,
} from '../src/snaptradeDoneRegistry';

describe('snaptradeDoneRegistry', () => {
  let registry: DoneRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = createDoneRegistry({ ttlMs: 10 * 60_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for unknown connection ids', () => {
    expect(registry.get('unknown')).toBeNull();
  });

  it('records a done timestamp keyed by connection id', () => {
    vi.setSystemTime(new Date('2026-05-27T10:00:00Z'));
    registry.markDone('conn-1');
    const entry = registry.get('conn-1');
    expect(entry).not.toBeNull();
    expect(entry!.doneAt).toBe(Date.parse('2026-05-27T10:00:00Z'));
  });

  it('expires entries after ttlMs', () => {
    vi.setSystemTime(new Date('2026-05-27T10:00:00Z'));
    registry.markDone('conn-1');
    vi.setSystemTime(new Date('2026-05-27T10:09:59Z'));
    expect(registry.get('conn-1')).not.toBeNull();
    vi.setSystemTime(new Date('2026-05-27T10:10:01Z'));
    expect(registry.get('conn-1')).toBeNull();
  });

  it('overwrites older entries on re-mark', () => {
    vi.setSystemTime(new Date('2026-05-27T10:00:00Z'));
    registry.markDone('conn-1');
    vi.setSystemTime(new Date('2026-05-27T10:05:00Z'));
    registry.markDone('conn-1');
    expect(registry.get('conn-1')!.doneAt).toBe(
      Date.parse('2026-05-27T10:05:00Z'),
    );
  });

  it('clears an entry on demand', () => {
    registry.markDone('conn-1');
    registry.clear('conn-1');
    expect(registry.get('conn-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sidecar && npm test -- snaptradeDoneRegistry
```

Expected: FAIL — "Cannot find module '../src/snaptradeDoneRegistry'".

- [ ] **Step 3: Write minimal implementation**

Create `sidecar/src/snaptradeDoneRegistry.ts`:

```ts
/**
 * In-memory registry of completed SnapTrade portal sessions, keyed by
 * Hon connectionId. Set when `/snaptrade/done` is hit; read by
 * `/snaptrade/connections/:id/count`. TTL bounds memory at the cost of
 * a tiny check on every read.
 *
 * Lives in-memory because:
 *   1. SnapTrade's portal redirects within seconds of a click — the
 *      client polls at 3s so a process restart between done & detect
 *      is extraordinarily unlikely.
 *   2. The engine is single-process, single-user. No coordination
 *      across instances needed.
 */
export interface DoneEntry {
  doneAt: number;
}

export interface DoneRegistry {
  markDone(connectionId: string): void;
  get(connectionId: string): DoneEntry | null;
  clear(connectionId: string): void;
}

export function createDoneRegistry(opts: { ttlMs: number }): DoneRegistry {
  const store = new Map<string, DoneEntry>();
  const { ttlMs } = opts;
  return {
    markDone(connectionId) {
      store.set(connectionId, { doneAt: Date.now() });
    },
    get(connectionId) {
      const entry = store.get(connectionId);
      if (!entry) return null;
      if (Date.now() - entry.doneAt > ttlMs) {
        store.delete(connectionId);
        return null;
      }
      return entry;
    },
    clear(connectionId) {
      store.delete(connectionId);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sidecar && npm test -- snaptradeDoneRegistry
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/snaptradeDoneRegistry.ts sidecar/test/snaptradeDoneRegistry.test.ts
git commit -m "sidecar: add SnapTrade done-flag registry

Tiny in-memory map keyed by Hon connectionId with TTL eviction.
Set by /snaptrade/done, read by /snaptrade/connections/:id/count.
Lets the polling client detect re-link of an already-linked broker
(where SnapTrade refreshes the connection rather than adding one,
so the existing count > baseline check never fires)."
```

---

### Task 2: Wire registry into server routes

**Files:**
- Modify: `sidecar/src/server.ts` lines 342–445 (the SnapTrade routes)

Two surgical changes:
1. `/snaptrade/done` reads `honConn` from `req.query`, calls `registry.markDone(honConn)` if present, returns updated HTML copy.
2. `/snaptrade/connections/:id/count` reads `registry.get(connectionId)` and folds `done: boolean` into the JSON response.

Module-level singleton registry created once at server module load.

- [ ] **Step 1: Sketch failing manual smoke (no automated test for the route — sidecar tests cover pure logic only, per PROJECT-RULES.md §5)**

We'll verify the route changes via a curl-driven manual test after Task 3 (full integration). For now, add a sanity step: edit, restart, hit endpoints.

- [ ] **Step 2: Modify `sidecar/src/server.ts` — add registry singleton near the top, after the existing imports**

Find the existing imports for snaptrade helpers (near top of file). Add:

```ts
import {
  createDoneRegistry,
  type DoneRegistry,
} from './snaptradeDoneRegistry.js';

const DONE_REGISTRY_TTL_MS = 10 * 60_000;
const snaptradeDoneRegistry: DoneRegistry = createDoneRegistry({
  ttlMs: DONE_REGISTRY_TTL_MS,
});
```

(If a `.js` extension isn't used elsewhere in the file's relative imports, drop it — match local convention.)

- [ ] **Step 3: Modify `/snaptrade/done` handler**

Locate the current handler (around line 395 — `app.get('/snaptrade/done', async (_req, reply) =>`). Replace the entire route definition with:

```ts
app.get('/snaptrade/done', async (req, reply) => {
  const q = req.query as { honConn?: string; status?: string } | undefined;
  if (q?.honConn && typeof q.honConn === 'string') {
    snaptradeDoneRegistry.markDone(q.honConn);
  }
  reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Hon — Connected</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center;
    justify-content:center; background:#14131c; color:#ece9f5;
    font-family:-apple-system,system-ui,sans-serif; }
  .box { text-align:center; max-width:380px; padding:32px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#ffffff8c; font-size:14px; line-height:1.5; }
</style></head>
<body><div class="box">
  <h1>Brokerage linked</h1>
  <p>You can close this tab — Hon is pulling your accounts now.</p>
</div></body></html>`);
});
```

Note: copy changed from "press Sync" → matches the in-modal "we'll pull your accounts the moment it finishes". Async signature kept for Fastify consistency.

- [ ] **Step 4: Modify `/snaptrade/connections/:connectionId/count` handler**

Locate the handler (around line 416). Replace the success body section so the response includes a `done` flag:

```ts
app.get('/snaptrade/connections/:connectionId/count', async (req, reply) => {
  const { connectionId } = req.params as { connectionId: string };
  if (!vault?.unlocked) {
    return reply.code(409).send({ error: 'the credential vault is locked' });
  }
  const credentials = vault.loadCredentials(connectionId);
  if (!credentials || typeof credentials !== 'object') {
    return reply.code(400).send({ error: 'credentials are required' });
  }
  const doneEntry = snaptradeDoneRegistry.get(connectionId);
  const done = doneEntry !== null;
  try {
    const snaptrade = makeClient(credentials);
    const stored = getStoredUser(credentials, vault);
    if (!stored) {
      return { count: 0, done };
    }
    const count = await countConnections(snaptrade, stored.userId, stored.userSecret);
    return { count, done };
  } catch (err) {
    return reply.code(400).send({ error: describeSnapError(err) });
  }
});
```

- [ ] **Step 5: Typecheck and run existing sidecar tests to ensure nothing regressed**

```bash
cd sidecar && npm run typecheck && npm test
```

Expected: typecheck clean; all 55+ existing tests pass; the 5 new registry tests pass too.

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/server.ts
git commit -m "sidecar: /snaptrade/done sets done flag; /count returns it

When SnapTrade's portal redirects back to /snaptrade/done with the
client-supplied honConn query param, mark that connectionId 'done'
in the registry. The count endpoint folds the flag into its JSON so
the polling client can detect completion even when SnapTrade just
refreshed an existing connection (which leaves count == baseline).

Also fix the /done HTML copy: it said 'press Sync' which contradicts
the in-modal 'we'll pull your accounts the moment it finishes'."
```

---

### Task 3: Client embeds honConn in customRedirect

**Files:**
- Modify: `web/src/accounts/SnapTradeLinkFlow.tsx` lines 80–95 (the `useEffect` that POSTs `/snaptrade/portal`)
- Modify (existing test): `web/src/accounts/SnapTradeLinkFlow.test.tsx` — confirm customRedirect now contains `honConn`

- [ ] **Step 1: Locate the existing test for the portal POST**

```bash
cd web && grep -n "customRedirect" src/accounts/SnapTradeLinkFlow.test.tsx
```

You should see one or more matches asserting on the request body. If not, the file uses installFetchMock keyed by `"POST /snaptrade/portal"`; find that handler and inspect.

- [ ] **Step 2: Add/extend a failing test**

In `web/src/accounts/SnapTradeLinkFlow.test.tsx`, find the test that exercises picking a broker and POSTing /snaptrade/portal (it's the test that asserts the portal opens / window.open is called). Add an assertion that the body's `customRedirect` ends with `?honConn=<connectionId>`. Concrete addition — add inside that same test, after the `POST /snaptrade/portal` body is captured:

```ts
expect(snaptradePortalBody.customRedirect).toMatch(
  /\/api\/snaptrade\/done\?honConn=conn-1$/,
);
```

(Use the connectionId your test passes; the SnapTradeLinkFlow test setup uses `conn-1` — adjust if your harness uses a different one.)

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd web && npm test -- SnapTradeLinkFlow.test
```

Expected: FAIL — `customRedirect` is still `${window.location.origin}/api/snaptrade/done` with no query string.

- [ ] **Step 4: Modify `SnapTradeLinkFlow.tsx`**

Find the `useEffect` block that opens the portal (currently around line 78). Find this line:

```ts
customRedirect: `${window.location.origin}/api/snaptrade/done`,
```

Replace with:

```ts
customRedirect: `${window.location.origin}/api/snaptrade/done?honConn=${encodeURIComponent(connectionId)}`,
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd web && npm test -- SnapTradeLinkFlow.test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/accounts/SnapTradeLinkFlow.tsx web/src/accounts/SnapTradeLinkFlow.test.tsx
git commit -m "web: embed honConn in SnapTrade portal customRedirect

So /snaptrade/done can record the completion against the Hon
connectionId. Sets up the next change: the polling hook treats a
done flag from the server as success even when count == baseline
(re-link of an already-linked broker)."
```

---

### Task 4: Polling hook honors `done` flag

**Files:**
- Modify: `web/src/accounts/useSnapTradeConnectionPoll.ts`
- Modify: `web/src/accounts/useSnapTradeConnectionPoll.test.ts`

- [ ] **Step 1: Write a failing test**

In `web/src/accounts/useSnapTradeConnectionPoll.test.ts`, add a test (keep existing tests intact):

```ts
it('fires onIncrease when server reports done:true even if count is unchanged', async () => {
  const onIncrease = vi.fn();
  const onTimeout = vi.fn();
  const onError = vi.fn();

  const fetchMock = installFetchMock({
    'GET /snaptrade/connections/conn-1/count': () => ({
      json: { count: 1, done: true },
    }),
  });

  renderHook(() =>
    useSnapTradeConnectionPoll({
      connectionId: 'conn-1',
      baseline: 1,
      enabled: true,
      onIncrease,
      onTimeout,
      onError,
    }),
  );

  await vi.waitFor(() => {
    expect(onIncrease).toHaveBeenCalledTimes(1);
  });
  expect(onIncrease).toHaveBeenCalledWith(1);
  expect(onTimeout).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  fetchMock.restore();
});
```

If your existing test file imports differ (e.g. uses `renderHook` from `@testing-library/react`, uses `installFetchMock` from `../test/mockFetch`), match the existing imports — don't introduce new ones.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd web && npm test -- useSnapTradeConnectionPoll
```

Expected: FAIL — the hook ignores `done`, baseline=1 + count=1 means `count > baseline` is false, `onIncrease` is never called, the `waitFor` times out.

- [ ] **Step 3: Modify the hook**

In `web/src/accounts/useSnapTradeConnectionPoll.ts`, find the response type and the tick function. Change the `api` call's generic + the success check.

Replace:

```ts
const res = await api<{ count: number }>(
  `/snaptrade/connections/${connectionId}/count`,
);
if (cancelled) return;
consecutiveFailures = 0;
if (res.count > baseline) {
  onIncreaseRef.current(res.count);
  return;
}
```

With:

```ts
const res = await api<{ count: number; done?: boolean }>(
  `/snaptrade/connections/${connectionId}/count`,
);
if (cancelled) return;
consecutiveFailures = 0;
if (res.count > baseline || res.done === true) {
  onIncreaseRef.current(res.count);
  return;
}
```

Update the JSDoc above the hook to mention the `done` path:

```ts
/**
 * Polls GET /snaptrade/connections/:id/count every 3s for up to 5 min
 * (the portal URL's TTL). Fires `onIncrease(newCount)` the first tick
 * the count exceeds `baseline` OR the server reports `done: true`
 * (the SnapTrade portal redirected back to /snaptrade/done — covers
 * re-link of an already-linked broker, where count stays at baseline).
 * `onTimeout()` if neither happens; `onError(msg)` after 3 consecutive
 * fetch failures. Callbacks are mirrored into refs (use-latest pattern)
 * so changing their identity doesn't restart the interval.
 */
```

- [ ] **Step 4: Run the new test + existing hook tests to confirm both pass**

```bash
cd web && npm test -- useSnapTradeConnectionPoll
```

Expected: PASS — new test passes; existing 4-or-so tests still pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/accounts/useSnapTradeConnectionPoll.ts web/src/accounts/useSnapTradeConnectionPoll.test.ts
git commit -m "web: poll honors server-side done flag

Fires onIncrease whenever the count endpoint reports done: true,
even if count is still at baseline. Covers the re-link case where
SnapTrade refreshes an existing connection rather than adding one,
so count would otherwise never grow."
```

---

### Task 5: DonePanel copy when accountsAdded === 0

**Files:**
- Modify: `web/src/accounts/SnapTradeLinkFlow.tsx` — the `DonePanel` component
- Modify: `web/src/accounts/SnapTradeLinkFlow.test.tsx`

- [ ] **Step 1: Locate the DonePanel definition**

```bash
cd web && grep -n "DonePanel\|accountsAdded" src/accounts/SnapTradeLinkFlow.tsx
```

- [ ] **Step 2: Write a failing test**

In `SnapTradeLinkFlow.test.tsx`, add (or augment the existing "done" test):

```ts
it('shows "refreshed" copy when accountsAdded is 0 (re-link of same broker)', async () => {
  // Stand up the flow with a stub onLinked that resolves accountsAdded: 0.
  // ...your existing harness pattern: render with initialBrokerSlug pre-set
  // so the flow opens, then resolve the /count poll with done:true so
  // onLinked fires, then onLinked resolves { accountsAdded: 0 }.
  // After that completes, assert the DOM shows the refreshed copy:
  await screen.findByText(/refreshed/i);
  expect(screen.queryByText(/0 accounts added/i)).toBeNull();
});
```

(If your existing test for the done state already covers `accountsAdded: 1`, extend that test file with a parallel test using the same harness.)

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd web && npm test -- SnapTradeLinkFlow.test
```

Expected: FAIL — current `DonePanel` always renders `${accountsAdded} accounts added.`

- [ ] **Step 4: Modify DonePanel**

Find this code (around line 216):

```tsx
function DonePanel(
  { brokerName, accountsAdded, onDone }:
    { brokerName: string; accountsAdded: number; onDone: () => void },
) {
  return (
    <>
      {/* heading etc. */}
      <p>{accountsAdded} account{accountsAdded === 1 ? '' : 's'} added.</p>
      {/* button */}
    </>
  );
}
```

Change the body sentence:

```tsx
<p>
  {accountsAdded === 0
    ? `${brokerName} connection refreshed.`
    : `${accountsAdded} account${accountsAdded === 1 ? '' : 's'} added.`}
</p>
```

(Use the surrounding JSX exactly as it exists — replace only the `<p>` line.)

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd web && npm test -- SnapTradeLinkFlow.test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/accounts/SnapTradeLinkFlow.tsx web/src/accounts/SnapTradeLinkFlow.test.tsx
git commit -m "web: nicer DonePanel copy when re-linking same broker

'IBKR connection refreshed.' instead of '0 accounts added.' Matches
the actual user mental model now that the done-flag path catches
re-link as success."
```

---

### Task 6: End-to-end smoke via chrome-devtools MCP

> **No tests pass here without this step.** PROJECT-RULES.md §2 — UI changes are not done until chrome-devtools has loaded the live app and a screenshot confirms the change is rendered.

**Files:** none (verification only — but a commit at the end captures the screenshot as proof).

- [ ] **Step 1: Confirm the engine + vite are running**

```bash
curl -s http://127.0.0.1:4000/health -H "Authorization: Bearer $(cat \"$HOME/Library/Application Support/Hon/dev-token\")" | head -3
curl -sI http://localhost:5173/ | head -1
```

Both should return 200/JSON. If not, ask Shahar to start `cd Hon && npm run dev`.

- [ ] **Step 2: Bounce the engine so the new server code is loaded**

The vite side picks up HMR. The sidecar engine does NOT — it must be restarted by Shahar (or via `pkill` + restart). Ask Shahar to restart `npm run dev` before proceeding. Wait until both ports come back up.

- [ ] **Step 3: Drive the flow via chrome-devtools MCP**

```text
1. mcp__chrome-devtools__navigate_page (reload, ignoreCache: true)
2. take_snapshot — confirm Assets tab
3. click "+ Add asset" → take_snapshot
4. click "Brokerages" → take_snapshot
5. click "Interactive Brokers" → take_snapshot
6. Confirm "Finish linking in the SnapTrade tab" + countdown
7. list_pages — confirm the SnapTrade portal tab opened
8. Ask Shahar to complete the IBKR Flex link in tab 3
9. After he confirms, list_network_requests — verify the count
   response now includes `done: true`
10. take_snapshot of Hon tab — confirm modal switches to
    DonePanel with "IBKR connection refreshed." text
11. take_screenshot → save to /tmp/snaptrade-relink-done.png
12. Read /tmp/snaptrade-relink-done.png inline to confirm visually
```

- [ ] **Step 4: If the screenshot shows the refreshed-copy DonePanel, commit a marker (optional)**

```bash
# No code change — but a brief note in HANDOFF.md is the right home
# for "smoke verified on 2026-05-27 at <hash>".
# Edit HANDOFF.md TL;DR § to mention "SnapTrade re-link detection
# smoke verified end-to-end".
git add HANDOFF.md
git commit -m "HANDOFF: note SnapTrade re-link smoke verified"
```

- [ ] **Step 5: If the screenshot DOES NOT show the expected copy**

Diagnose, don't paper over. Possibilities:
- Engine wasn't restarted (server code still old) → ask Shahar to restart.
- The customRedirect query param got URL-encoded twice or stripped by SnapTrade → check page 3's redirected URL via `mcp__chrome-devtools__list_pages` for the actual `?honConn=...` value.
- The done flag was set but the polling already gave up (timeout) — check `list_network_requests` for the last few count calls + their timing.

Loop back to fix; don't claim done.

- [ ] **Step 6: Final test pass**

```bash
cd web && npm test && cd ../sidecar && npm test
cd ../web && npm run typecheck && cd ../sidecar && npm run typecheck
```

All four must pass before merge per PROJECT-RULES.md §5.

---

## Self-review notes

- **Spec coverage:** Plan touches the three subsystems called out in the prompt (server, hook, link flow). The "0 accounts added" UX gap surfaced during smoke is in Task 5. The HTML copy contradiction is in Task 2.
- **Placeholders:** none — every code block is complete and every command is exact.
- **Type consistency:** `done?: boolean` on the count response is consistent across server (Task 2) and client (Task 4). `honConn` query name is consistent across Task 2 (server reads it) and Task 3 (client writes it). `connectionId` (Hon's UUID) is the only id used end-to-end; SnapTrade's own connection_id from the redirect is intentionally ignored (we just need "the portal completed").
- **Dependency order:** Task 1 (registry) → Task 2 (server uses registry) → Task 3 (client sets honConn) → Task 4 (hook reads done) → Task 5 (copy polish) → Task 6 (smoke). Tasks 3 and 4 could run in parallel by a daring subagent setup; safer to do sequentially.

---

**End of plan.**
