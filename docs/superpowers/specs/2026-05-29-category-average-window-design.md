# Category average window — design

**Date:** 2026-05-29
**Status:** Approved (brainstorming) → ready for writing-plans
**Topic:** User-selectable timeframe for the per-category spending averages in Insights.

## Problem

The Insights → Spending sub-tab shows two kinds of average comparison:

- An overall **"vs avg"** pill in the month header (`avgSpending`).
- A per-category **"vs avg"** delta chip on every category row (`avgByCat`).

Both are computed in `MonthDetail` (`web/src/insights/InsightsView.tsx`, ~L836–865)
as the mean over the *completed* cycles inside a hardcoded **12-month** window
(`cycleAnalytics` always builds 12 cycle buckets). The user cannot change how
many months feed those averages — a 12-month mean smooths over a recent habit
change, and there's no way to ask "how am I doing vs the last 3 months?".

## Goal

Add a Settings control to choose the timeframe over which the per-category
(and overall) spending averages are calculated:

- **Fixed presets:** 3 / 6 / 12 / 24 months.
- **Custom:** any month count (free number input).

Scope is **the averages only** — the 12-month bar chart and the per-row
**"vs last"** chip are unchanged.

## Decisions (locked during brainstorming)

1. **Custom = a custom number of months** (not a date range). The setting is a
   single integer; presets are quick-picks, "Custom" reveals a number input.
2. **Scope = averages only.** The bar chart stays 12 months; "vs last" stays
   the prior cycle. Only `avgSpending` + `avgByCat` move to the new window.
3. **A dedicated Settings card** ("Category averages"), not a row bolted onto
   the existing "Spending projection" card — clearer purpose, room to grow.
4. **Anchor = trailing N cycles before the *displayed* month.** Viewing March
   compares March against the N completed cycles before March. This is a small
   behavior change from today (today's average is anchored to the window's
   current month regardless of which month the picker shows) and is more
   correct for the month picker.
5. **No new data fetch.** Transactions are already full-history (~24 months),
   so a wider window is pure recomputation. A window larger than the available
   history simply averages over fewer completed cycles.

## Architecture

Three small, independently-testable units:

### 1. Settings data model — `web/src/settings/store.ts`

Add one field:

```ts
export interface Settings {
  // …existing…
  spendingAvgMonths: number; // default 12
}
```

`DEFAULT_SETTINGS.spendingAvgMonths = 12`. `loadSettings()` keeps the value
when present and falls back to 12 when absent or non-positive (guard against
malformed localStorage, same spirit as the existing `cardProviders` guard).

### 2. Pure computation helper — `web/src/insights/categoryAverages.ts` (new)

```ts
export interface CategoryAverages {
  avgSpending: number | null;            // overall trailing mean, null if no completed cycles
  avgByCat: Map<string, number>;         // per-category trailing mean
}

export function categoryAverages(
  transactions: Transaction[],
  monthStartDay: number,
  isExcluded: (t: Transaction) => boolean,
  windowMonths: number,
  displayedMonthKey: string,
): CategoryAverages;
```

Behavior:

- Build the `windowMonths` cycle keys **strictly before** `displayedMonthKey`
  (using `prevCycleKey` from `web/src/cycle.ts`), newest→oldest.
- Aggregate ILS, non-refund, non-excluded *spending* (`amount < 0`) per cycle,
  overall and per category (`t.category || 'Other'`), mirroring the existing
  filters in `MonthDetail` / `cycleAnalytics`.
- A cycle counts toward the average only if it has spending > 0 (matches the
  current "completed.filter(m => m.spending > 0)" rule), so empty pre-history
  months don't drag the mean toward zero.
- `avgSpending` = mean overall spending across qualifying cycles (`null` when
  none). `avgByCat[cat]` = (sum of that category across qualifying cycles) /
  (count of qualifying cycles).

Reuses the same per-category denominator as today (qualifying-cycle count),
so a category with no spend in some qualifying months still divides by the
full qualifying count — consistent with current `avgByCat` math.

### 3. Settings UI — `web/src/settings/CategoryAveragesCard.tsx` (new)

A `set-card` with its own icon + heading "Category averages". One `set-row col`
containing:

- A segmented `.seg` group (same markup as `SpendingProjectionCard`'s income
  control) with buttons `3 / 6 / 12 / 24` and a trailing `Custom` button.
- A preset button is `on` when `spendingAvgMonths === preset`.
- `Custom` is `on` when the value is **not** one of the presets; clicking it
  reveals a number `<input>` (min 1) bound to `spendingAvgMonths`. The input is
  also shown whenever Custom is the active state, pre-filled with the current
  value.
- Empty / non-positive input is ignored (keeps the last valid value); commit on
  change, same optimistic `update({ spendingAvgMonths: n })` pattern as the
  other cards.

Mounted in `SettingsView.tsx` in the `set-grid`, after `SpendingProjectionCard`.

### Wiring — `MonthDetail` in `InsightsView.tsx`

- `InsightsView` already reads `const [settings] = useSettings()` (L30) under
  the app-level `SettingsProvider` (App.tsx:105). `MonthDetail` receives
  settings as props (it already takes `monthStartDay`), so thread
  `spendingAvgMonths` in as a new prop the same way — no new `useSettings()`
  call inside `MonthDetail`.
- Replace the inline `avgSpending` + `avgByCat` computation with a call to
  `categoryAverages(transactions, monthStartDay, isExcluded, spendingAvgMonths, monthKey)`.
- Leave `byCatCycle` / `prevAmt` ("vs last") and the 12-month `months` chart
  data exactly as they are.

## Data flow

```
Settings (localStorage honSettings.spendingAvgMonths)
        │  useSettings()
        ▼
InsightsView → MonthDetail
        │  categoryAverages(txns, monthStartDay, isExcluded, N, monthKey)
        ▼
{ avgSpending, avgByCat }  →  TrendPill "vs avg"  +  DeltaChip "vs avg"
```

## Error / edge handling

- `windowMonths` < 1 → treated as 1 (guarded at store load and at input).
- Window larger than available history → averages over whatever qualifying
  cycles exist; `null` avg when none (pill/chip render their existing
  no-base state).
- `displayedMonthKey` is the earliest month → zero cycles before it →
  `avgSpending = null`, empty `avgByCat`. UI already handles null base.

## Testing (TDD order)

1. `store.test.ts` — default is 12; load preserves a saved value; malformed /
   non-positive falls back to 12.
2. `categoryAverages.test.ts` — window sizing (N cycles before displayed month);
   trailing-anchor correctness; spending>0 qualifying filter; per-category mean;
   excluded/refund/non-ILS rows skipped; null/empty when no prior cycles.
3. `CategoryAveragesCard.test.tsx` — renders presets + Custom; preset click
   PATCHes the store; Custom reveals input; typing a number updates the store;
   active-state highlighting (preset vs custom).
4. `InsightsView` integration — changing the window changes the "vs avg" base
   while "vs last" and the bar chart stay fixed.

## Out of scope

- Resizing the bar chart with the window.
- Changing the income-average control (`incomeAvgMonths`) — separate concern.
- A custom *date range* (explicitly decided against; month count only).
- Server-side `/insights` AI summary (engine-side, untouched).
