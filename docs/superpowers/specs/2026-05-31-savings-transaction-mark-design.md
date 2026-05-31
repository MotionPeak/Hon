# Savings transaction mark — design

## Problem

When the user moves money from a checking account into savings (a standing
order, a manual transfer, "in any way"), the outflow currently lands in the
cycle as a regular **minus** — it inflates spending in the budget, the spend
pie, and the variable-spent total. But it isn't spending; the money just
changed accounts.

Hon already has a per-transaction **"Exclude from cycle"** toggle that drops a
row out of the spend calc. This feature adds a *dedicated* **Savings** mark
that does the same exclusion **and** tallies the amount as "saved this cycle"
so the user can see how much they set aside.

## Goal

A transaction can be marked **Savings**. A savings transaction:
1. Is excluded from every spend / "minus" calculation (budget variable-spent,
   spend pie, cycle totals) — exactly like an excluded transaction.
2. Is counted toward a visible **"saved this cycle"** tally (Activity bucket +
   Overview line).
3. Leaves net worth unchanged (net worth is computed from account balances, not
   transactions, so a transfer between two tracked accounts is already neutral).

## Non-goals

- **No auto-detection** of transfers to savings accounts (manual mark only).
- **Does not feed** the budget's planned "Set aside for savings" reserve or the
  piggy-bank system — those stay independent.
- No change to net-worth math.
- **Legacy SPA (`sidecar/public/app.html`) UI is not modified.** The React app
  is the active UI and all recent feature work has targeted it; the legacy
  client's `cycleSpending` will keep counting these rows until it's retired.
  The shared backend (`/budget`, the new column + route) is updated regardless,
  so both clients agree on persisted data.

## Approach

A first-class `savings` flag on transactions, mirroring the existing
`excluded_manual` column + `PATCH /transactions/:id/excluded` pattern.

Rejected alternatives:
- **Reuse a "Savings" category** — overwrites the transaction's real category
  and categories are user-editable/fragile.
- **Account-level "savings account" auto-detect** — the auto-detect option the
  user explicitly did not choose; more infrastructure.

## Data model

- Migration: `ALTER TABLE transactions ADD COLUMN savings INTEGER;`
  (nullable, `1` = savings, null/0 = not). New `SCHEMA_VERSION`.
- `TXN_COLS` in `repo.ts` gains `savings`. **(Load-bearing: a column missing
  from TXN_COLS is silently dropped from the UI.)**
- `Transaction` type (web + repo `TxnRow`) gains `savings?: boolean | null`.
- Repo: `setTransactionSavings(id, savings: boolean)`.
- **Mutual exclusivity:** setting `savings = true` clears `excluded_manual`
  (and vice versa) — a savings row is a meaningful exclude, never both.

## API

- `PATCH /transactions/:id/savings` body `{ savings: boolean }` →
  `repo.setTransactionSavings`. Returns `{ ok: true, savings }`.
  Mirrors the existing `/transactions/:id/excluded` route.

## Spend-calc changes

Every place that sums spend must skip savings rows, the same way it skips
excluded rows:
- **Backend** `sidecar/src/budget.ts` — the variable-spent / per-category
  spend aggregation.
- **React** `web/src/activity/excluded.ts` (`isExcludedFromCycle`) is the
  single shared predicate the spend paths use — savings rows resolve as
  excluded-from-cycle there, so `categorySpend` (Overview pie), Insights, and
  Activity all inherit it. A row is "out of cycle" when
  `excludedManual === true` **or** `savings === true` (or the card-bill rule).
- **Legacy** `sidecar/public/app.html` is left unchanged (out of scope — see
  Non-goals).

## UI

### Activity — mark control
In the transaction sidebar (`ActivityView.tsx`), add a **"Savings"** toggle
beside the existing "Exclude from cycle" toggle. Turning Savings on turns
Exclude off (mutually exclusive). `PATCH /transactions/:id/savings`.

### Activity — tally bucket
A collapsible **"Savings"** section at the bottom of Activity, parallel to the
existing "Excluded from cycle" section, listing savings rows with the cycle
total in its header (the "saved this cycle" figure). Savings rows are filtered
out of the main counted list and out of the generic "Excluded" bucket.

### Overview — tally line
A small **"Saved this cycle: ₪X"** line in the Overview (under the budget
card's totals, or as its own subtle row), where X = sum of `|amount|` of
ILS savings rows in the current cycle. Hidden when zero.

## Edge cases

- Only ILS outflows meaningfully tally; the calc uses the same ILS / cycle
  filters as `cycleSpending`. Income rows marked savings (unusual) don't add to
  the saved tally (tally sums outflows).
- A savings row still shows its real category and account; it's just pulled
  from spend.

## Testing

- **Backend** (`repo`/route): `setTransactionSavings` persists + clears
  `excluded_manual`; `PATCH /transactions/:id/savings` validates body.
  budget spend excludes savings rows.
- **React unit**: `isExcludedFromCycle` returns true for `savings` rows;
  `categorySpend` drops them from the pie; the "saved this cycle" sum helper.
- **React component**: Activity Savings toggle calls the PATCH; the Savings
  bucket renders with its total; Overview "Saved this cycle" line renders and
  hides at zero.
- Visual verification (chrome-devtools): mark a real transfer → it leaves the
  spend pie / variable-spent, appears in the Savings bucket, and the Overview
  "saved this cycle" reflects it.

## Files touched

- `sidecar/src/db.ts` (migration + SCHEMA_VERSION)
- `sidecar/src/repo.ts` (TXN_COLS, TxnRow type, `setTransactionSavings`)
- `sidecar/src/server.ts` (`PATCH /transactions/:id/savings`)
- `sidecar/src/budget.ts` (skip savings in spend)
- `web/src/activity/types.ts` (`savings` field)
- `web/src/activity/excluded.ts` (savings ⇒ excluded-from-cycle)
- `web/src/activity/ActivityView.tsx` (Savings toggle + Savings bucket)
- `web/src/overview/OverviewView.tsx` (+ `spend.ts`) ("saved this cycle" tally)
- Tests alongside each.
