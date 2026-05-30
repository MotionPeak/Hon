# Splitwise — settle from real repayments, not Splitwise settle-ups

**Date:** 2026-05-30
**Status:** Approved (design)
**Scope:** Splitwise paid-state sourcing. Touches sidecar (`db.ts`, `repo.ts`,
`splitwise.ts`, `server.ts`) + web (`useSplitwise`, Activity, Overview).

## Problem

When a friend hits **"settle up" in Splitwise**, Hon immediately treats the
split as paid — before any money reaches the user's bank:

- `attributePayments()` (`sidecar/src/splitwise.ts`) fetches Splitwise
  `payment:true` records via `GET /get_expenses` and allocates them across the
  user's open links, bumping `splitwise_links.paid_amount` / `paid_state`.
- That shrinks the `splitwise_virtual` refund in the `txn_effective` view
  (`db.ts`), so the original expense's effective spend jumps back toward full.
- `OwedToYouCard` + the Overview projection read Splitwise's **net friend
  balances** (`GET /get_friends`), which Splitwise also nets down on settle-up.

So a Splitwise settle-up (which can be recorded before — or without — the cash
actually arriving) silently changes the user's budget math, "owed to you," and
projection. The user wants Hon to keep the split owed until a **real incoming
transaction** proves the money arrived.

## Goal

Drive Splitwise paid-state from **real repayment transactions the user links**,
never from Splitwise's settle-up flag:

1. Stop reading Splitwise `payment:true` records. The `paid` pool comes from
   incoming Hon transactions the user marks as repayments from a friend.
2. "Owed to you" (card + projection) is computed from **Hon's own links**
   (`Σ owed − Σ paid` per friend over open splits), not Splitwise net balances.
3. The repaid-budget model is unchanged from today's math (decision below): a
   linked +₪60 repayment pays the split down, the expense reverts toward full,
   and the +₪60 is a normal inflow. Net spend nets out correctly.

## Decisions (from brainstorming)

- **Settle trigger:** the user links a real incoming transaction (no auto-match).
- **Scope:** everything — per-transaction budget effect AND owed-to-you/projection.
  Owed-to-you becomes Hon-tracked. **Accepted caveat:** only splits created
  through Hon are tracked; debts added directly in the Splitwise app won't show.
- **Repaid model:** reuse today's `virtual = owed − paid` math. When the real
  repayment is linked, `paid_amount` rises → `splitwise_virtual` shrinks → the
  expense reverts to full, and the linked incoming transaction stands as a normal
  inflow (net spend correct). No change to `txn_effective`.

## Non-goals

- No change to the `splitwise_virtual` / `txn_effective` formula.
- No auto-matching of incoming transactions to repayments.
- No tracking of Splitwise-app-native debts (only Hon-created splits).
- The `GET /get_friends` call stays (needed for the split-creation picker and the
  new repayment friend-picker). Only the `GET /get_expenses` payment fetch goes.

## Approach — source swap

Keep the existing oldest-first allocation algorithm in `attributePayments()`; only
**change the pool source** from Splitwise payment records to user-linked repayment
transactions. `paid_amount` / `paid_state` semantics, the `splitwise_virtual` CTE,
and `txn_effective` are all unchanged — when nothing is linked, a split stays fully
owed and the expense shows the user's share; when a real repayment is linked it
pays down exactly as today.

## Data model

### New table — `splitwise_repayments` (migration 37, `SCHEMA_VERSION = 37`)

```sql
CREATE TABLE splitwise_repayments (
  transaction_id    TEXT PRIMARY KEY,   -- the incoming Hon txn marked as a repayment
  counterparty_id   TEXT NOT NULL,      -- Splitwise friend (user) id who repaid
  counterparty_name TEXT NOT NULL,      -- denormalized for display
  currency          TEXT NOT NULL,      -- 3-char; must match the link currency to allocate
  created_at        TEXT NOT NULL
);
```

A friend's repayment **pool** for a currency = `Σ transactions.amount` over their
marked repayment transactions (incoming, positive). One transaction = one
repayment marking.

### Per-counterparty paid in `counterparties` JSON

`splitwise_links.counterparties` is today `[{id, name, owed}]`. Extend each entry
with `paid` (allocated during recompute): `[{id, name, owed, paid}]`. This lets
"owed to you" be computed **per friend with partial payments**
(`Σ (owed − paid)` over a friend's link entries). Back-compat: a missing `paid`
reads as `0`.

## Paid computation — `recomputePaidStates()` (replaces the Splitwise source)

Refactor `attributePayments()` (`sidecar/src/splitwise.ts`); drop the
`GET /get_expenses` fetch. New pure-ish flow over local data:

1. Build pool: `Map<"counterpartyId|currency", number>` =
   `Σ amount` of incoming transactions joined from `splitwise_repayments`.
2. For each link **oldest-first** (`created_at`), for each counterparty entry:
   - `take = min(entry.owed, pool["{entry.id}|{link.currency}"])`
   - set `entry.paid = take`; decrement the pool.
3. Persist per link: updated `counterparties` JSON, `paid_amount = Σ entry.paid`,
   `paid_state` = `'paid'` if `paid_amount >= owed_to_me`, `'partial'` if `> 0`,
   else `'open'`.

Triggered on: mark/unmark repayment, and on `POST /splitwise/refresh`. `refresh`
still fetches friends/groups (picker), then calls `recomputePaidStates()`.

## API routes (`sidecar/src/server.ts`)

- `POST /api/splitwise/repayment` — body `{ transactionId, counterpartyId, currency }`.
  Validates the txn exists and is incoming (amount > 0); upserts the repayment;
  runs `recomputePaidStates()`; returns updated links (+ repayments).
- `DELETE /api/splitwise/repayment/:transactionId` — removes the repayment; runs
  recompute; returns updated links. 404 if not found.
- `GET /api/splitwise/repayments` — list current repayment markings (for the UI to
  render chips). (Or fold into the existing `/splitwise/links` payload.)

`repo.ts`: `createRepayment`, `deleteRepayment`, `listRepayments`,
`getRepaymentPool()`; `recomputePaidStates()` consumes the pool.

## Frontend

### Activity — mark an incoming transaction as a repayment

In the move/categorize sidebar (Radix dialog), for an **incoming** transaction
(`amount > 0`) that isn't already a repayment: a **"Mark as Splitwise repayment"**
control → friend picker (from `useSplitwise().friends`). On confirm,
`POST /splitwise/repayment`. Marked rows show a chip **"↩ Repayment from {name}"**
with an unmark action (`DELETE`). The control is hidden when Splitwise is
disconnected or the amount is ≤ 0.

### Overview — owed-to-you + projection from links

`OwedToYouCard` and the projection stop reading `sw.friends` net balances. Instead
aggregate `useSplitwise().links`: per counterparty, `Σ (owed − paid)` over entries
in non-fully-paid links; positive only. Projection still same-currency-only. The
card lists per-friend remaining from Hon's tracked splits.

### `useSplitwise` hook + `types.ts`

- Add `markRepayment(transactionId, counterpartyId, currency)` /
  `unmarkRepayment(transactionId)` and a `repayments` list.
- Add a derived `owedByFriend` selector over `links` (the per-friend
  `Σ owed − Σ paid`) consumed by `OwedToYouCard` + the projection.
- Keep `friends` (picker) but no longer source owed-to-you from their balances.

## Behavior on existing data

Splits previously marked paid by a Splitwise settle-up recompute to **open** (no
real repayment linked) and reappear as owed — the intended effect. No data
migration of `paid_amount` is needed; the first recompute (on refresh or first
mark) rewrites it from the empty repayment set.

## Edge cases

- Repayment > friend's total open owed → excess stays unallocated (no over-pay).
- Multiple repayments from one friend → pool sums.
- Currency mismatch (repayment currency ≠ link currency) → not allocated.
- Non-incoming transaction → route rejects (400); UI never offers it.
- Unmark → recompute; the split reverts to owed and the expense's virtual refund
  returns.
- A transaction already linked as a split *expense* should not also be markable as
  a repayment (UI guards: only offer on positive amounts with no existing
  expense-link).

## Testing

**sidecar:**
- Migration 37 creates `splitwise_repayments`; `SCHEMA_VERSION = 37`.
- `recomputePaidStates()` from repayments: full pay, partial, multi-friend split,
  oldest-first ordering, currency mismatch ignored, over-pay leftover.
- Routes: `POST` (valid / non-incoming 400 / unknown txn 404), `DELETE` (recompute,
  404), list.
- `counterparties` JSON round-trips `paid`.

**web:**
- `useSplitwise`: `markRepayment`/`unmarkRepayment` POST/DELETE + refetch;
  `owedByFriend` aggregation (partial paid).
- Activity sidebar: repayment control shown only for incoming + connected; mark →
  chip; unmark.
- `OwedToYouCard`: renders per-friend remaining from links (not friend balances);
  a Splitwise settle-up alone does NOT change it (no repayment linked).
- Overview projection: owed line from links, same-currency only.

`cd web && npm test` + `cd sidecar && npm test` green; both typechecks clean.

## Verification (PROJECT-RULES §2)

chrome-devtools against the live engine: create/observe a split; mark an incoming
transaction as a repayment → split's remaining drops and the expense reverts;
unmark → reverts; confirm a Splitwise-side settle-up no longer changes Hon's
owed-to-you. Screenshots read back before any "done" claim.

## Risks

- **`counterparties` JSON shape change.** Adding `paid` must stay back-compatible
  (read missing as 0); all readers (Activity, recompute) updated together.
- **Owed-to-you semantics shift.** The card now reflects only Hon-tracked splits —
  intended, but visibly different from the old Splitwise-net-balance number.
- **Removing the Splitwise payment fetch** must not break `refresh` (still needs
  friends/groups for the picker).
