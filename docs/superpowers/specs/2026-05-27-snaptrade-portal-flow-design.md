# SnapTrade Portal Flow — Design

**Date:** 2026-05-27
**Status:** Design approved, awaiting implementation plan
**HANDOFF item:** #30 (`SnapTrade portal flow — OAuth + portal handoff for IBKR`)

## What this delivers

A complete client-side UX for linking a brokerage through SnapTrade's
Connection Portal, plus the missing lightweight backend endpoint that
makes hands-free auto-detection cheap.

After this ships, the user can:

1. Pick **SnapTrade (brokerages)** in Add Account → enter their
   `clientId` + `consumerKey` → pick a brokerage (e.g. IBKR) → finish
   linking in the SnapTrade tab → return to Hon and see their
   accounts already pulled and rendered. No manual Sync click.
2. From the SnapTrade card in Assets, click **Link another
   brokerage** → same picker → same hands-free flow. Up to the
   5-broker SnapTrade free tier limit.

## Why now

The backend has been ready for weeks:

- `POST /snaptrade/portal` — returns a 5-minute portal URL.
- `POST /snaptrade/brokerages` — returns the supported list.
- `GET /snaptrade/done` — landing page after the user completes
  the OAuth handshake on the SnapTrade side.
- `runSnapTradeSync` — pulls accounts after a brokerage is linked.

The error message from `runSnapTradeSync` literally tells the user
to *"Use 'Link a brokerage'"*. That button doesn't exist. This spec
builds it, plus everything around it for a one-shot polished flow.

## Scope

**In scope:**
- Wizard entry path (Add Account → SnapTrade) with first-link inline.
- Connection-card entry path (Link another brokerage) for subsequent
  links from the SnapTrade card.
- Full searchable brokerage picker (all SnapTrade-supported, IBKR
  pre-focused when present).
- Auto-detect via background polling (3s tick over the portal's
  5-min TTL).
- Error UX for vault-locked, bad creds, atLimit, portal expiry,
  scrape failures.
- One new backend endpoint: `GET /snaptrade/connections/:id/count`.
- TDD on every component, with backend tests for the count endpoint.

**Out of scope (deferred):**
- Webhook-style portal callbacks (Hon is local; polling is enough).
- Multi-brokerage batch linking in one wizard pass.
- Pre-flight brokerage capability checks (positions/options support).
- Recommending specific brokerages by region or currency.
- Refresh of expired SnapTrade users (already self-heals on next
  portal call — no UI needed).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  AccountsView.tsx                                            │
│    - Add Account dropdown extended to route SnapTrade        │
│      through <AddSnapTradeWizard>                            │
│    - SnapTrade card renders <LinkBrokerageButton>            │
└──────────────────────────────────────────────────────────────┘
                ↓                              ↓
┌────────────────────────────┐  ┌────────────────────────────┐
│ AddSnapTradeWizard.tsx     │  │ LinkBrokerageButton.tsx    │
│   step 1: dev creds form   │  │   disabled+tooltip on      │
│   step 2: <SnapTradeLink…> │  │     atLimit / vault locked │
└────────────────────────────┘  │   onClick: open modal      │
                ↓                │   modal renders <Link…>    │
                └─────────┬──────┘                            │
                          ↓                                   │
            ┌────────────────────────────────┐                │
            │ SnapTradeLinkFlow.tsx          │ ← entry point  │
            │   state machine:               │   for both     │
            │     loading-brokerages →       │   paths        │
            │     picking-broker →           │                │
            │     opening-portal →           │                │
            │     waiting-for-link →         │                │
            │     syncing →                  │                │
            │     done | error               │                │
            └────────────────────────────────┘                │
                ↓              ↓               ↓              │
   ┌────────────────────┐ ┌─────────┐  ┌──────────────────┐   │
   │ SnapTradeBrokerage │ │Countdown│  │ useSnapTrade     │   │
   │ Picker.tsx         │ │.tsx     │  │ ConnectionPoll.ts│   │
   │  search + grid     │ │ 1s tick │  │  3s tick, 5min   │   │
   │  useDeferredValue  │ │ isolated│  │  use-latest cb   │   │
   └────────────────────┘ └─────────┘  └──────────────────┘   │
                                            ↓                 │
                          ┌────────────────────────────────┐  │
                          │ GET /snaptrade/connections/    │  │
                          │     :id/count  (new)           │  │
                          │ → { count }                    │  │
                          └────────────────────────────────┘  │
```

## Backend changes

### One new endpoint

**`GET /snaptrade/connections/:connectionId/count`**

```ts
// sidecar/src/server.ts
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
    const user = getStoredUser(credentials, vault);
    if (!user) return { count: 0 };
    const count = await countConnections(snaptrade, user.userId, user.userSecret);
    return { count };
  } catch (err) {
    return reply.code(400).send({ error: describeSnapError(err) });
  }
});
```

`makeClient`, `getStoredUser`, `countConnections`, and `describeSnapError`
all exist in `sidecar/src/snaptrade.ts`. The endpoint exposes
`countConnections` (currently file-local — make it `export`) without
the side effect of minting a new portal URL. Safe to poll.

**No DB migration.** No schema changes. The 5-broker free tier limit
is already exposed via the existing `atLimit` field on `/snaptrade/portal`.

## Frontend changes

### Three new files in `web/src/accounts/`

#### `SnapTradeBrokeragePicker.tsx`

Pure presentation. Props:

```ts
type Props = {
  brokerages: BrokerageOption[];   // pre-fetched, sorted by name
  onPick(slug: string): void;
};
```

- Search input + grid of logo cards.
- `useDeferredValue` on the search term so typing stays responsive.
- Pre-builds a lowercase name index once via `useMemo` for O(1)-ish
  substring filtering (`js-set-map-lookups`).
- IBKR pre-focused when present in the list (auto-scrolls into view +
  `data-pre-focused` for tests).
- Empty state when filter matches nothing.

#### `useSnapTradeConnectionPoll.ts`

```ts
function useSnapTradeConnectionPoll(args: {
  connectionId: string;
  baseline: number;
  onIncrease(newCount: number): void;
  onError(message: string): void;
  enabled: boolean;
}): { remainingMs: number; pause(): void; resume(): void };
```

- Polls `GET /snaptrade/connections/:id/count` every 3s.
- Stops after 5 min (portal URL TTL); fires `onError('Portal expired')`.
- `onIncrease` stored in a ref via the use-latest pattern so the
  interval doesn't churn on parent re-renders (`advanced-use-latest`).
- Tolerates 3 consecutive failures silently; on the 4th, fires `onError`
  and pauses. `resume()` restarts the consecutive counter.
- Cleans up on unmount and on `enabled: false`.

#### `SnapTradeLinkFlow.tsx`

Orchestrator. Owns the state machine.

```ts
type Props = {
  connectionId: string;
  onLinked(): void;        // parent refreshes /accounts + /connections
  onCancel(): void;        // close modal
};

type FlowState =
  | { kind: 'loading-brokerages' }
  | { kind: 'picking-broker'; brokerages: BrokerageOption[] }
  | { kind: 'opening-portal'; brokerSlug: string }
  | { kind: 'waiting-for-link'; brokerSlug: string; baseline: number; portalUrl: string }
  | { kind: 'syncing'; brokerSlug: string }
  | { kind: 'done'; brokerSlug: string; accountsAdded: number }
  | { kind: 'error'; from: FlowState['kind']; message: string; canRetry: boolean };
```

Sub-views declared at module level (`rerender-no-inline-components`):
`<PickingPanel>`, `<PollingPanel>`, `<SyncingPanel>`, `<DonePanel>`,
`<ErrorPanel>`. The state machine renders one at a time.

The flow component is **lazy-loaded** from the call sites via
`React.lazy` (`bundle-dynamic-imports`):

```tsx
const SnapTradeLinkFlow = React.lazy(
  () => import('./SnapTradeLinkFlow')
);
```

### Integration changes

**`AccountsView.tsx`:**

- Extend the Add Account dropdown's SnapTrade route to render
  `<AddSnapTradeWizard>` instead of just the bank credentials form.
  The wizard collects clientId + consumerKey (step 1), saves to vault
  via the existing `POST /connections` path, then renders
  `<SnapTradeLinkFlow>` in step 2 (already inside the same modal).
- On the SnapTrade card render, add `<LinkBrokerageButton connectionId={…} />`.
  Pulls `atLimit` and `connectionCount` from the existing accounts
  query response. Disables with tooltip when at-limit or vault-locked
  (best-effort guardrail; server enforces both anyway).
- After `onLinked()` callback fires, call the same refresh path the
  manual Sync button uses today (re-fetches `/accounts` and `/connections`).

### `web/src/test/setup.ts`

No changes needed — Radix Dialog polyfills already in place. Add
`window.open` stub in `installFetchMock` (or alongside) if existing
tests don't already stub it.

## Data flow

```
USER                           HON FRONTEND                  HON BACKEND        SNAPTRADE
 │                                  │                            │                  │
 │  Add Account → SnapTrade         │                            │                  │
 ├─────────────────────────────────►│                            │                  │
 │  fill clientId + consumerKey     │                            │                  │
 ├─────────────────────────────────►│                            │                  │
 │                                  │  POST /connections         │                  │
 │                                  ├───────────────────────────►│                  │
 │                                  │  201 { connectionId }      │                  │
 │                                  │◄───────────────────────────┤                  │
 │                                  │  lazy-load LinkFlow chunk  │                  │
 │                                  │  POST /snaptrade/brokerages│                  │
 │                                  ├───────────────────────────►├─────────────────►│
 │                                  │  brokerages[]              │                  │
 │                                  │◄───────────────────────────┤◄─────────────────┤
 │  picker grid renders             │                            │                  │
 │  searches "IBKR", clicks card    │                            │                  │
 ├─────────────────────────────────►│                            │                  │
 │                                  │  POST /snaptrade/portal    │                  │
 │                                  ├───────────────────────────►├─loginSnapTrade──►│
 │                                  │  { redirectURI, baseline } │                  │
 │                                  │◄───────────────────────────┤◄─────────────────┤
 │  window.open(redirectURI)        │                            │                  │
 │◄─────────────────────────────────┤                            │                  │
 │  (new tab; user logs into IBKR)  │  start poll: every 3s      │                  │
 │                                  ├───────────────────────────►├─listUserAccts───►│
 │                                  │  { count: baseline } x N   │                  │
 │                                  │◄───────────────────────────┤◄─────────────────┤
 │  finishes linking in SnapTrade   │                            │                  │
 ├──────────────────────────────────┼────────────────────────────┼─────────────────►│
 │                                  │  next poll: { count: +1 }  │                  │
 │                                  │◄───────────────────────────┤◄─────────────────┤
 │                                  │  onIncrease →              │                  │
 │                                  │  POST /connections/:id/    │                  │
 │                                  │       scrape               │                  │
 │                                  ├───────────────────────────►├─runSnapTradeSync►│
 │                                  │  202 (kicks off run)       │                  │
 │                                  │  ...polls run status...    │                  │
 │                                  │  { success, accounts: N }  │                  │
 │                                  │◄───────────────────────────┤◄─────────────────┤
 │                                  │  onLinked() →              │                  │
 │                                  │  refresh /accounts         │                  │
 │  "Linked IBKR — 3 accounts"      │                            │                  │
 │◄─────────────────────────────────┤                            │                  │
 │  click Done                      │                            │                  │
 ├─────────────────────────────────►│  close modal               │                  │
```

## Error handling matrix

| State | Failure | Status | UX |
|---|---|---|---|
| `loading-brokerages` | Vault locked | 409 | "Unlock your vault to connect a brokerage" + Cancel |
| `loading-brokerages` | Bad SnapTrade creds | 400 | Inline error from `describeSnapError` + Cancel |
| `loading-brokerages` | Network | fetch reject | "Couldn't reach the engine — retry?" + Retry + Cancel |
| `opening-portal` | `error` on PortalResult | 200 with `error` | Show `error` string + Retry. userId/userSecret persisted server-side per existing contract |
| `opening-portal` | `atLimit: true` | 200 | "You're at the 5-brokerage SnapTrade free tier limit. Unlink one first." + Done |
| `opening-portal` | empty redirectURI, no error | 200 | "SnapTrade didn't return a portal URL — try again" + Retry |
| `waiting-for-link` | Poll fails | network | Silent. After 3 consecutive failures: "Lost connection to the engine" banner + Retry |
| `waiting-for-link` | 5-min timer expires | client-side | "Portal expired (5 min). [Try again]" — restarts at opening-portal |
| `waiting-for-link` | User closes SnapTrade tab without linking | invisible | Keeps polling until timeout. Cancel always available |
| `syncing` | Scrape fails | non-2xx | "Linked the brokerage, but first sync failed: {msg}. [Retry sync] [Done]". Done still fires `onLinked()` — connection IS in DB |
| Any | Vault locks mid-flow | 409 | Prompt to unlock; retry resumes from current step |

**Pre-flight guardrails (best-effort, server still enforces):**
- "Link a brokerage" button on SnapTrade card disables with tooltip when
  `vault.locked === true` OR `connectionCount >= 5`.

## Testing strategy

Per Hon convention: TDD with `cd web && npm test` / `cd sidecar && npm test`.

**Backend (`sidecar/test/`)**
- `snaptrade-count.test.ts`:
  - Returns `{ count }` on success.
  - 409 when vault locked.
  - 400 when credentials missing.
  - 400 with `describeSnapError` message when SDK throws.
  - Returns `{ count: 0 }` when no stored user (graceful for fresh creds).

**Frontend (`web/src/accounts/`)**
- `SnapTradeBrokeragePicker.test.tsx`: renders props, search filters
  case-insensitively, click → `onPick(slug)`, empty state, IBKR
  pre-focused when present.
- `useSnapTradeConnectionPoll.test.ts`: fake-timer ticks at 3s, fires
  `onIncrease` when count > baseline, cleans on unmount, 5-min timeout
  transition, 3-consecutive-fail tolerance, interval doesn't restart
  when the `onIncrease` ref identity changes.
- `SnapTradeLinkFlow.test.tsx`: every state transition + every error
  path + cancel cleanup. Uses `installFetchMock` for backend stubs and
  mocks `window.open`.
- `AccountsView.test.tsx` extensions: Add Account → SnapTrade opens
  the new wizard, SnapTrade card button opens the flow, button
  disabled+tooltip on `atLimit` or vault-locked, `onLinked` triggers
  `/accounts` refresh.

**TDD cycle order (one commit per cycle):**
1. RED: brokerage picker → GREEN: picker
2. RED: poll hook → GREEN: hook
3. RED: link flow state machine → GREEN: orchestrator
4. RED: backend count endpoint → GREEN: endpoint
5. RED: AccountsView wiring → GREEN: integration
6. Manual smoke (`cd Hon && npm run dev`, click through both entry paths)

## Performance principles applied

From `vercel-react-best-practices`, the subset relevant here:

- **`bundle-dynamic-imports`** — `SnapTradeLinkFlow` lazy-loaded.
  Picker + 50+ brokerage entries stay out of the main bundle until
  the user triggers the flow.
- **`rerender-no-inline-components`** — sub-panels declared at module
  level, not nested inside `SnapTradeLinkFlow`.
- **`rerender-use-deferred-value`** — search filter wraps results in
  `useDeferredValue` so typing stays responsive over 50+ items.
- **`rerender-split-combined-hooks`** — countdown state isolated in
  its own component; parent state machine doesn't re-render every 1s.
- **`advanced-use-latest`** — poll's `onIncrease` callback stored in
  a ref so the 3s interval doesn't restart on parent re-renders.
- **`js-set-map-lookups`** — brokerage search uses a pre-built
  lowercase index. Overkill for 50 items, free since the data is
  static post-fetch.

## Convention compliance

- Per `CLAUDE.md` data layer: per-component `useState` + `useEffect` +
  parallel fetches. No SWR. No Zustand.
- Per existing pattern: Radix `Dialog` with `.rx-overlay` / `.rx-dialog`
  classes. `DelayedLoader` for the brokerage list fetch.
- Per `installFetchMock` convention: keys like
  `"GET /api/snaptrade/connections/:id/count"`.
- Per HANDOFF branch policy: stay on `main`, commit freely, **ask
  before pushing**.
- Per `TXN_COLS` reminder: this work does NOT touch transactions
  schema, so no `TXN_COLS` change needed.

## Open questions

None. Three earlier decisions captured:

1. **Entry point** — Both (Add Account wizard handles first link,
   connection card handles subsequent).
2. **Completion signal** — Auto-detect via 3s background poll.
3. **Broker scope** — Full searchable list of all SnapTrade-supported
   brokerages.

## Next step

Invoke `superpowers:writing-plans` to convert this design into a
detailed implementation plan (TDD-ordered task list, per-file edits,
acceptance criteria per task).
