# Insights: holdings drill-down + per-range stats, and AI-insights card-bill fix

**Date:** 2026-05-29
**Scope:** Two of the five open Brokerage-Insights items (HANDOFF §"Still
open on the Brokerage Insights page"): item 4 (holdings drill-down +
sparkline + per-range stats) and item 5 (server-side AI `/insights`
double-counting card-bill totals).

---

## Item 5 — AI `/insights` excludes card-bill totals (engine)

### Problem

The on-device AI insights summary double-counts credit-card bills. When a
card statement is paid, the bank shows one lump-sum debit (e.g.
`מקס איט פיננסים` ₪9,461) **and** the card scraper shows the itemised
charges that make up that bill. The Activity and Insights-Spending tabs
already drop the bank-side lump sums via the `isExcludedFromCycle`
predicate (`cardProviders` substring match + `hideCardTotals` + per-txn
`excluded_manual` override) — fixed client-side in `1a94568`.

The server-side AI generator does not. `InsightsGenerator.run()`
(`sidecar/src/insights.ts:62`) calls `buildBudgetReport(this.repo)` with
no projection, so `cardProviders` defaults to `[]`; and it calls
`buildAnalytics(this.repo)`, whose repo queries (`monthlyTotals`,
`categorySpending`, `expenseStats`) apply **no** exclusion at all. So the
prompt the LLM phrases is built from inflated spending — "Other" and total
SPENT are too high, exactly the bug the React tabs already fixed.

### Design

Two halves:

**(a) Make the server-side spending math exclusion-aware.**
- `repo.monthlyTotals`, `repo.categorySpending`, `repo.expenseStats` gain
  an optional `excludeDescPatterns: string[] = []` parameter and reuse the
  existing private `buildExcludeClause` helper (already used by
  `monthlySpending`/`monthlyInflow`). Default `[]` preserves every existing
  caller's behaviour.
- `buildAnalytics(repo, cardProviders: string[] = [])` threads
  `cardProviders` into those three repo calls (both the this-month and
  last-month category reads, and the trailing-12-month + stats reads).
- `InsightsGenerator` passes `cardProviders` into both
  `buildBudgetReport(this.repo, { cardProviders })` and
  `buildAnalytics(this.repo, cardProviders)`.

**(b) Deliver the exclusion settings from client to engine.**
The `cardProviders` list and `hideCardTotals` toggle live only in the
browser (`web/src/settings/store.ts`). The engine never sees them. So the
client passes them in the request body:
- `POST /insights` accepts an optional JSON body
  `{ cardProviders?: string[] }`. (Mirrors how `/budget` already receives
  `cardProviders` via query params.)
- The React side reads `settings.hideCardTotals` + `settings.cardProviders`
  and sends `cardProviders: hideCardTotals ? settings.cardProviders : []`
  when it POSTs `/insights` — i.e. an empty list when the card-totals rule
  is toggled off, so the engine's behaviour tracks the toggle.
- `InsightsGenerator.start(cardProviders: string[])` stores the list for
  the run; `getStatus()` is unchanged.

### Fidelity boundary (intentional)

Scope to the `cardProviders` substring rule only. Per-txn `excluded_manual`
overrides (force-include / force-exclude individual rows) are **not**
honored server-side this session — they are a rounding error in a prose
summary and would require materially fiddlier SQL (an override can
force-INCLUDE a row the rule excludes). Deferred, noted in HANDOFF.

### Files

- `sidecar/src/repo.ts` — add `excludeDescPatterns` to three analytics
  methods.
- `sidecar/src/analytics.ts` — `buildAnalytics(repo, cardProviders)`.
- `sidecar/src/insights.ts` — thread `cardProviders` into both report
  builders; `start(cardProviders)`.
- `sidecar/src/server.ts` — `POST /insights` reads `cardProviders` from the
  body and forwards to `start`.
- `web/src/insights/InsightsView.tsx:183` (the `await api('/insights',
  'POST')` Generate call) — send a body with `cardProviders` derived from
  settings. `api()` will need to accept a JSON body on this POST if it
  doesn't already.

### Tests (sidecar)

- `buildAnalytics` with `cardProviders` drops matching lump sums from
  `byCategory`, `thisMonth.spending`, `expenseStats`, `months`.
- `buildAnalytics` with `[]` is byte-identical to today (regression).
- Repo methods: `categorySpending`/`monthlyTotals`/`expenseStats` with a
  pattern exclude the matching rows; without a pattern, unchanged.
- `POST /insights` is tested manually per the sidecar convention (route
  handlers aren't unit-tested), but the generator's `start(cardProviders)`
  plumbing can be asserted via a small unit test if it doesn't require the
  LLM.

---

## Item 4 — Holdings drill-down + per-range stats (React, client-only)

### Problem

The React Brokerage Insights tab lists holdings as flat, non-clickable rows
and shows a fixed stat row. The legacy SPA (`sidecar/public/app.html`)
offers more, and all the underlying data is **already on the wire** in the
`/brokerage` payload — React simply doesn't read it:

- `performance[].data` carries `byRange` (per-window `rateOfReturn`,
  `dividendIncome`, `contributions`) but the React `PerformanceEntry.data`
  type only declares `totalEquity`/`currency`, so those numbers are unused.
- `holdingSnapshots` (per-`(account,symbol)` daily value history) is fetched
  and used for the equity series, but not for any per-holding sparkline.

### Design — three additions, all faithful to the legacy SPA

**1. Consolidate holdings by symbol.**
Current React lists one row per `(account, symbol)`. Legacy consolidates by
symbol across in-scope accounts, summing units/value/cost/gain and carrying
the contributing `accountIds[]`. Adopt the legacy behaviour — it is a
prerequisite for the sparkline (which sums a symbol across its accounts) and
matches the legacy holdings panel. The Cash row stays as-is.

**2. Clickable rows → single-open expand.**
A `openHolding: string | null` state (the symbol). Clicking a row toggles
it; opening one closes the other (legacy `state.brkOpenHolding`). Expanded
detail is a stats grid — Units, Last price, Avg cost, Market value, Total
cost, Gain · {range}, Unrealized · ALL — using the existing `holdingStats`
and `convertAmount` helpers, in the active display currency.

**3. Per-holding sparkline.**
Port the legacy `buildHoldingSeries`: from `holdingSnapshots`, sum the
symbol's daily value across its `accountIds`, applying each account's
`inceptionDate` clip, then `sliceRange(..., range)` by the active pill.
Render with the existing `LineChart`. Extract this as a pure function (e.g.
`web/src/insights/holdingSeries.ts`) with unit tests, mirroring
`equitySeries.ts`.

**4. Per-range stat tiles.**
- Extend `PerformanceEntry.data` (in `equitySeries.ts`) to additionally
  declare `byRange?: Record<string, { rateOfReturn: number | null;
  dividendIncome: number | null; contributions: number | null }>` plus the
  top-level fallbacks (`rateOfReturn`, `dividendIncome`).
- Add "Rate of return · {range}" and "Dividends · {range}" tiles, derived
  from the in-scope `performance` entries' `byRange[range]` (fall back to
  the top-level fields for caches that predate per-range). When a specific
  account is focused, scope to that account's connection — matching legacy
  (`filteredPerf`). Average rate-of-return across in-scope connections; sum
  dividends; convert to display currency.
- Make the existing fixed "Gain · 1Y" tile **period-aware** ("Gain ·
  {range}") computed off the chart's sliced equity window (first-vs-last),
  with the cost-basis unrealized gain as fallback — matching legacy.

### No engine changes

`PENSION`-style: server already returns everything. This is a pure
client-side port. (`PerformanceEntry.data.byRange` is already in the JSON;
we only add it to the TS type.)

### Files

- `web/src/insights/equitySeries.ts` — extend `PerformanceEntry.data` type.
- `web/src/insights/holdingSeries.ts` (new) — `buildHoldingSeries` +
  `sliceRange` reuse.
- `web/src/insights/InsightsView.tsx` — consolidate-by-symbol, clickable
  rows + expand state, stats grid, sparkline mount, per-range tiles,
  period-aware Gain tile. New module-level sub-components
  (`HoldingRow`, `HoldingDetail`) per `rerender-no-inline-components`.

### Tests (web)

- `holdingSeries`: sums across accountIds, inception clip, range slice,
  empty/one-point cases (mirror `equitySeries.test.ts`).
- `InsightsView` integration: clicking a holding row reveals the stats grid;
  a second click / opening another collapses it; per-range tiles render the
  `byRange` numbers and re-derive when the range pill changes; period-aware
  Gain tile updates with the range.

### Visual verification (PROJECT-RULES §2 — mandatory)

Load `http://localhost:5173/#token=…` in chrome-devtools against the live
engine, expand a holding, flip the range pills, switch the account filter,
and screenshot — confirm parity with the legacy SPA at `:4000`. No "done"
claim before the screenshot exists.

---

## Out of scope (the other three open Insights items)

Items 1 (SnapTrade per-unit/null-`value` mapping), 2 (pill coverage for
accounts without snapshots), and 3 (transaction-based ALL cap) are
explicitly **not** in this session.

## Workflow

Per PROJECT-RULES: work in `session/insights-drilldown-aifix-2026-05-29`
worktree, TDD per task (`test-driven-development`), atomic commits, both
typechecks + both test suites green, visual verification for the UI half,
no push without explicit go-ahead.
