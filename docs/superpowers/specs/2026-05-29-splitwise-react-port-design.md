# Splitwise — React port (design)

**Date:** 2026-05-29
**Status:** approved
**Scope:** Port the fully-built legacy-SPA Splitwise feature into the React app (`web/`). The sidecar backend already exposes the complete API; this is almost entirely UI work, plus one server-side security fix (H-3) in the flow we touch.

---

## Background

Splitwise lets the user split a Hon transaction onto Splitwise and track who owes them back. The sidecar implements it end-to-end; the legacy SPA (`sidecar/public/app.html`) has the full reference UI. The React app (`web/`) ships only a stub (`SplitwiseCard` → "Coming soon") and a disabled "+ Split on Splitwise" button in the activity sidebar. This port reaches feature parity in React.

### Existing backend (no changes except H-3)

All token-gated, vault-aware. Reference: `sidecar/src/server.ts:835-1005`, `sidecar/src/splitwise.ts`, `sidecar/src/repo.ts:628-695`.

| Route | Returns |
|---|---|
| `GET /splitwise/status` | `{ connected, user: { id, name } | null }` |
| `POST /splitwise/connect` `{ apiKey }` | saves account → `{ ok }` (409 if vault locked) |
| `POST /splitwise/disconnect` | `{ ok }` |
| `GET /splitwise/groups` | `{ friends: [{id,name}], groups: [{id,name,members:[{id,name}]}], me: {id} }` |
| `GET /splitwise/links` | `{ links: SplitwiseLink[] }` (local DB read, no round-trip) |
| `POST /splitwise/refresh` | `{ friends: [{name, balances:[{amount,currency}]}], links }` |
| `POST /splitwise/expense` `{ transactionId, groupId, shares:[{userId,name,owed}] }` | `{ link }` (409 if already split) |
| `DELETE /splitwise/expense/:transactionId` | `{ ok }` — **see H-3** |

`SplitwiseLink` shape (from `repo.ts`): `{ transactionId, expenseId, currency, owedToMe, paidAmount, paidState, counterparties: [{ id, name }], createdAt, syncedAt }`.

---

## Decisions (locked)

1. **Full parity** — Settings connect/disconnect, per-txn split sheet (friend + group), linked-state + unlink, Overview "Owed to you" card, activity-list "₪X owed to you" note.
2. **Inline connect in Settings** — API-key paste + help link live directly in the Settings Splitwise card (cleaner than the legacy "Assets + Add menu" route). Settings is the one place to connect/disconnect.
3. **Fix H-3** — `DELETE /splitwise/expense/:id` currently returns `{ok:true}` when the vault is locked, removing the local link while the remote expense stays live for every other participant. Fix: return 409 when `link && !acct` so the local link is preserved and the UI shows the unlock gate.

---

## Architecture

Follows existing React conventions (CLAUDE.md "React-side conventions"): Radix Dialog for the sheet, custom window events instead of prop-drilling, `installFetchMock` tests, `DelayedLoader` for async.

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| `useSplitwise` hook | `web/src/splitwise/useSplitwise.ts` | Single source of truth: `{ connected, user, links, friends, vaultLocked }` + `linkByTxnId` map + actions `connect/disconnect/refresh/createExpense/deleteExpense`. Module-level cache; syncs instances via `hon.splitwise-changed` window event. | `api.ts` |
| `SplitwiseCard` | `web/src/settings/SplitwiseCard.tsx` (replace stub) | Connected → "Connected as {name}" + Disconnect. Not connected → API-key field + "get a free key" help link + Connect. | `useSplitwise` |
| `SplitwiseSection` | `web/src/activity/SplitwiseSection.tsx` | Sidebar section mirroring `RefundSection`. Unlinked → "+ Split on Splitwise" (opens sheet). Linked → "{remaining} owed to you" / "paid back" + counterparty names + unlink ✕. Hidden when not connected. | `useSplitwise`, `SplitwiseSheet` |
| `SplitwiseSheet` | `web/src/splitwise/SplitwiseSheet.tsx` | Radix Dialog, 3 steps: pick (friends/groups) → configure (friend: "how much owed", default cost/2; group: member checkboxes, equal split incl. you) → create. Inline validation + error. | `useSplitwise` |
| `OwedToYouCard` | `web/src/overview/OwedToYouCard.tsx` | "Owed to you · via Splitwise" card; friends with positive balances, else "all settled up". Hidden when not connected. | `useSplitwise` |
| txn-list note | `web/src/activity/ActivityView.tsx` | "· {remaining} owed to you" / "· paid back" appended to split rows via `linkByTxnId`. | `useSplitwise` |
| H-3 fix | `sidecar/src/server.ts:989-1005` | Return 409 when vault locked + link exists. | — |

### Data flow

1. `useSplitwise` mounts → `GET /splitwise/status` + `GET /splitwise/links` in parallel → store.
2. If connected → `POST /splitwise/refresh` for friend balances + refreshed paid state (best-effort; failure never blocks).
3. Mutation (connect / createExpense / deleteExpense / disconnect) → API call → update module cache → `window.dispatchEvent(new Event('hon.splitwise-changed'))` → every mounted hook re-reads. (Same intra-tab signal pattern as `hon.loan-ids-changed`; the browser `storage` event is cross-tab only.)

### Share math (ported verbatim from legacy)

- **Friend:** `owed` defaults to `cost/2`; validate `0 < owed <= cost`. Shares = `[{ userId, name, owed }]`, `groupId = null`.
- **Group:** `share = cost / (checkedMembers + 1)` (+1 for you). Shares = one `{ userId, name, owed: share }` per ticked member; pass `groupId`. Require ≥1 ticked.

---

## Error handling

- **Vault locked (409):** hook sets `vaultLocked`; consumers trigger the existing unlock gate (legacy `showGate()` equivalent) instead of a generic error. Applies to connect, refresh, createExpense, deleteExpense.
- **Splitwise upstream (502):** inline error in the sheet; toast for card/section actions.
- **Already split (409 on create):** inline error in the sheet.
- **H-3:** locked-vault delete returns 409; local link preserved; UI shows unlock gate. Matches the route's own promise ("local link is kept when the delete fails, so the user can retry").
- **Best-effort never blocks:** balance refresh failures are swallowed with the rest of the dashboard still rendering.

---

## Testing

Vitest + Testing Library; `installFetchMock` keyed `"METHOD /api/path"`; fake timers via `vi.useFakeTimers({ shouldAdvanceTime: true })` where needed.

- `useSplitwise` — load (status+links), connect, disconnect, refresh merges friends/links, `vaultLocked` on 409, `hon.splitwise-changed` re-read.
- `SplitwiseSheet` — friend flow validation + share; group flow share math (`cost/(n+1)`); ≥1-ticked guard; create posts correct body.
- `SplitwiseSection` — linked vs unlinked render; hidden when disconnected; unlink calls delete.
- `SplitwiseCard` — connected vs not; connect posts apiKey; disconnect.
- `OwedToYouCard` — positive balances vs all-settled.
- Sidecar — H-3: locked vault + existing link → 409, link not deleted.

Gates before commit: `cd web && npm test`, `cd web && npm run typecheck`, `cd sidecar && npm test`, `cd sidecar && npm run typecheck` all green. UI verified live via chrome-devtools + screenshot per PROJECT-RULES §2.

---

## Out of scope

- Splitwise OAuth (the backend uses a personal API key; unchanged).
- Editing an existing split (legacy has none — unlink + re-split).
- Settle-up / recording payments from Hon (Splitwise has no per-expense settle API; paid state is derived on refresh).
- The other CODE-REVIEW findings (M-B2 pagination, M-S1 fetch timeout) — separate security pass.
