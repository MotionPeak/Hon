# Insights drill-down + per-range stats + AI-insights card-bill fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the on-device AI insights summary from double-counting credit-card bill totals, and port the legacy SPA's brokerage holdings drill-down (clickable rows + stats grid + per-holding sparkline) plus the per-range stat tiles (rate of return, dividends, period-aware gain) to the React Insights tab.

**Architecture:** Item 5 is engine-side — thread a `cardProviders` exclude list (already supported by `repo.monthlySpending`) through `buildAnalytics` and the three analytics repo methods, pass it into both report builders inside `InsightsGenerator`, and have `POST /insights` accept it in the body; the React Generate button supplies it from `useSettings()`. Item 4 is client-only — every number is already in the `/brokerage` payload (`performance[].data.byRange`, `holdingSnapshots`); the React code just doesn't read it yet.

**Tech Stack:** TypeScript (strict), Fastify + better-sqlite3 (engine), React 19 + Vitest + Testing-Library (web). Tests run from `sidecar/` and `web/` directly, never repo root.

**Working directory:** the worktree `.claude/worktrees/insights-drilldown-aifix-2026-05-29` on branch `session/insights-drilldown-aifix-2026-05-29`. All commands below assume you `cd` into that worktree's `sidecar/` or `web/`.

**Spec:** `docs/superpowers/specs/2026-05-29-insights-drilldown-aifix-design.md`

---

## PART A — Item 5: AI `/insights` excludes card-bill totals (engine + 1 React call)

### Task A1: Repo analytics methods accept a description-exclude list

**Files:**
- Modify: `sidecar/src/repo.ts:1696` (`monthlyTotals`), `:1711` (`categorySpending`), `:1723` (`expenseStats`)
- Test: `sidecar/tests/repo.test.ts`

The private `buildExcludeClause(patterns, params)` helper already exists
(`repo.ts:1643`) and is used by `monthlySpending`/`monthlyInflow`. Reuse it.

- [ ] **Step 1: Write the failing tests** — append to `sidecar/tests/repo.test.ts`:

```ts
describe('analytics exclude patterns', () => {
  function seedSpending(repo: Repo) {
    const conn = repo.createConnection('beinleumi', 'Beinleumi');
    repo.saveScrapeResult(conn.id, [{
      accountNumber: '1', currency: 'ILS', balance: 0,
      transactions: [
        { externalId: 'a', date: '2026-05-02', amount: -100, currency: 'ILS', description: 'Cafe' },
        { externalId: 'b', date: '2026-05-03', amount: -9461, currency: 'ILS', description: 'מקס איט פיננסים' },
        { externalId: 'c', date: '2026-05-04', amount: 5000, currency: 'ILS', description: 'Salary' },
      ],
    }]);
  }

  it('monthlyTotals excludes matching descriptions', () => {
    const { repo } = makeRepo();
    seedSpending(repo);
    const base = repo.monthlyTotals('2026-05-01').find((m) => m.month === '2026-05');
    const excl = repo.monthlyTotals('2026-05-01', ['מקס איט']).find((m) => m.month === '2026-05');
    expect(base?.spending).toBe(9561);
    expect(excl?.spending).toBe(100);
  });

  it('categorySpending excludes matching descriptions', () => {
    const { repo } = makeRepo();
    seedSpending(repo);
    const total = (rows: { total: number }[]) => rows.reduce((s, r) => s + r.total, 0);
    expect(total(repo.categorySpending('2026-05-01', '2026-06-01'))).toBe(9561);
    expect(total(repo.categorySpending('2026-05-01', '2026-06-01', ['מקס איט']))).toBe(100);
  });

  it('expenseStats excludes matching descriptions', () => {
    const { repo } = makeRepo();
    seedSpending(repo);
    expect(repo.expenseStats('2026-05-01', '2026-06-01').count).toBe(2);
    expect(repo.expenseStats('2026-05-01', '2026-06-01', ['מקס איט']).count).toBe(1);
  });
});
```

> Note: `monthlyTotals` currently takes only `start`. The test calls it with a
> second positional `excludeDescPatterns` arg — that's the new signature.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sidecar && npm test -- repo.test.ts`
Expected: the three new tests FAIL (extra args ignored → excluded totals equal base totals).

- [ ] **Step 3: Implement** — edit the three methods in `sidecar/src/repo.ts`:

```ts
  /** Total ILS spending & income per calendar month, from @start onward. */
  monthlyTotals(
    start: string,
    excludeDescPatterns: string[] = [],
  ): { month: string; spending: number; income: number }[] {
    const params: Record<string, unknown> = { start };
    const exclude = this.buildExcludeClause(excludeDescPatterns, params);
    return this.db
      .prepare(
        `SELECT substr(date, 1, 7) AS month,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spending,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income
         FROM txn_effective
         WHERE currency = 'ILS' AND date >= @start ${exclude}
         GROUP BY substr(date, 1, 7)
         ORDER BY month`,
      )
      .all(params) as { month: string; spending: number; income: number }[];
  }

  /** ILS expense totals per category in [start, end); uncategorized included. */
  categorySpending(
    start: string,
    end: string,
    excludeDescPatterns: string[] = [],
  ): { category: string; total: number }[] {
    const params: Record<string, unknown> = { start, end };
    const exclude = this.buildExcludeClause(excludeDescPatterns, params);
    return this.db
      .prepare(
        `SELECT COALESCE(category, 'Uncategorized') AS category, SUM(-amount) AS total
         FROM txn_effective
         WHERE amount < 0 AND currency = 'ILS' AND date >= @start AND date < @end ${exclude}
         GROUP BY COALESCE(category, 'Uncategorized')`,
      )
      .all(params) as { category: string; total: number }[];
  }

  /** Count and mean of ILS expense transactions in [start, end). */
  expenseStats(
    start: string,
    end: string,
    excludeDescPatterns: string[] = [],
  ): { count: number; avg: number } {
    const params: Record<string, unknown> = { start, end };
    const exclude = this.buildExcludeClause(excludeDescPatterns, params);
    return this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(AVG(-amount), 0) AS avg
         FROM txn_effective
         WHERE amount < 0 AND currency = 'ILS' AND date >= @start AND date < @end ${exclude}`,
      )
      .get(params) as { count: number; avg: number };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sidecar && npm test -- repo.test.ts`
Expected: PASS (all, including the prior `listTransactions`/`historyMonths` suites).

- [ ] **Step 5: Typecheck + commit**

```bash
cd sidecar && npm run typecheck
git add src/repo.ts tests/repo.test.ts
git commit -m "sidecar: repo analytics methods accept description-exclude patterns"
```

---

### Task A2: `buildAnalytics` threads `cardProviders`

**Files:**
- Modify: `sidecar/src/analytics.ts:36` (the `buildAnalytics` signature + its repo calls)
- Test: `sidecar/tests/analytics.test.ts` (new)

- [ ] **Step 1: Write the failing test** — create `sidecar/tests/analytics.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { buildAnalytics } from '../src/analytics.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-analytics-'));
  const { db } = openDatabase(dir);
  return new Repo(db);
}

function seedThisMonth(repo: Repo) {
  const now = new Date();
  const iso = (day: number) =>
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const conn = repo.createConnection('beinleumi', 'Beinleumi');
  repo.saveScrapeResult(conn.id, [{
    accountNumber: '1', currency: 'ILS', balance: 0,
    transactions: [
      { externalId: 'a', date: iso(2), amount: -100, currency: 'ILS', description: 'Cafe' },
      { externalId: 'b', date: iso(3), amount: -9461, currency: 'ILS', description: 'מקס איט פיננסים' },
    ],
  }]);
}

describe('buildAnalytics cardProviders', () => {
  it('excludes matching card-bill lump sums from this-month spending', () => {
    const repo = makeRepo();
    seedThisMonth(repo);
    expect(buildAnalytics(repo).thisMonth.spending).toBe(9561);
    expect(buildAnalytics(repo, ['מקס איט']).thisMonth.spending).toBe(100);
  });

  it('default (no patterns) is unchanged', () => {
    const repo = makeRepo();
    seedThisMonth(repo);
    const a = buildAnalytics(repo);
    expect(a.txnCount).toBe(2);
    expect(buildAnalytics(repo, []).txnCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npm test -- analytics.test.ts`
Expected: FAIL — `buildAnalytics(repo, ['מקס איט']).thisMonth.spending` is `9561`, not `100` (the arg is ignored).

- [ ] **Step 3: Implement** — edit `sidecar/src/analytics.ts`. Change the signature and pass `cardProviders` to every repo analytics call:

```ts
export function buildAnalytics(repo: Repo, cardProviders: string[] = []): Analytics {
```

Then update the four repo calls inside the function body:

```ts
  const rows = new Map(repo.monthlyTotals(windowStart, cardProviders).map((r) => [r.month, r]));
```
```ts
  const lastCats = new Map(
    repo.categorySpending(lastStart, thisStart, cardProviders).map((c) => [c.category, c.total]),
  );
  const byCategory: CategorySlice[] = repo
    .categorySpending(thisStart, nextStart, cardProviders)
    .map((c) => {
```
```ts
  const stats = repo.expenseStats(windowStart, nextStart, cardProviders);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npm test -- analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd sidecar && npm run typecheck
git add src/analytics.ts tests/analytics.test.ts
git commit -m "sidecar: buildAnalytics threads cardProviders exclude list"
```

---

### Task A3: `InsightsGenerator` accepts + applies `cardProviders`; `POST /insights` reads the body

**Files:**
- Modify: `sidecar/src/insights.ts` (`start`, `run`, the two report-builder calls)
- Modify: `sidecar/src/server.ts:2298` (`POST /insights` handler)

- [ ] **Step 1: Implement `InsightsGenerator`** — edit `sidecar/src/insights.ts`.

Add a field and accept the list in `start`:

```ts
export class InsightsGenerator {
  private cardProviders: string[] = [];

  // ...existing status field + constructor unchanged...

  start(cardProviders: string[] = []): void {
    if (this.status.state === 'generating') return;
    this.cardProviders = cardProviders;
    this.status = { ...this.status, state: 'generating', message: 'Generating insights…' };
    void this.run();
  }
```

Inside `run()`, pass `this.cardProviders` into both builders (replacing the
two current no-arg / single-arg calls):

```ts
      const report = buildBudgetReport(this.repo, undefined, { cardProviders: this.cardProviders });
      if (report.totalSpent <= 0) {
        this.fail('No spending this month yet — sync and categorize transactions first.');
        return;
      }
      const analytics = buildAnalytics(this.repo, this.cardProviders);
```

> `buildBudgetReport(repo, range, projection)` — pass `undefined` for `range`
> to keep the default `currentMonthRange()`, and the projection carries
> `cardProviders`. `BudgetProjection.cardProviders` already exists (`budget.ts:86`).

- [ ] **Step 2: Implement the route** — edit `sidecar/src/server.ts:2298`:

```ts
app.post('/insights', async (req, reply) => {
  if (!insights) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as { cardProviders?: unknown };
  const cardProviders = Array.isArray(body.cardProviders)
    ? body.cardProviders.filter((p): p is string => typeof p === 'string')
    : [];
  insights.start(cardProviders);
  return { ok: true };
});
```

- [ ] **Step 3: Typecheck + run full sidecar suite**

Run: `cd sidecar && npm run typecheck && npm test`
Expected: typecheck clean; all sidecar tests PASS (route handlers aren't unit-tested per the existing convention, so no new test here — the generator plumbing is covered transitively by A1/A2 and verified live at the end).

- [ ] **Step 4: Commit**

```bash
git add src/insights.ts src/server.ts
git commit -m "sidecar: AI /insights excludes card-bill totals via cardProviders from request body"
```

---

### Task A4: React Generate button sends `cardProviders`

**Files:**
- Modify: `web/src/insights/InsightsView.tsx` (`AiAnalysisCard`, ~line 159–183)
- Test: `web/src/insights/InsightsView.test.tsx`

`AiAnalysisCard` is a module-level component rendered under the app's
`SettingsProvider`, so it can call `useSettings()` directly.

- [ ] **Step 1: Write the failing test** — add to `web/src/insights/InsightsView.test.tsx`. Match the file's existing render+mockFetch harness (it already renders `InsightsView` with `installFetchMock`). Add a test that clicking Generate POSTs `/insights` with the cardProviders body:

```tsx
it('Generate POSTs /insights with cardProviders from settings', async () => {
  const calls: { path: string; body: unknown }[] = [];
  installFetchMock({
    'GET /api/insights': { state: 'idle', text: '', generatedAt: null, message: '' },
    'POST /api/insights': (init?: RequestInit) => {
      calls.push({ path: '/api/insights', body: init?.body ? JSON.parse(String(init.body)) : null });
      return { ok: true };
    },
    // ...reuse whatever GET stubs the existing Spending-tab tests rely on...
  });
  // render InsightsView inside SettingsProvider with hideCardTotals: true and
  // cardProviders: ['מקס איט'] (use the same provider wrapper the other tests use),
  // switch to the Spending sub-tab, click the Generate button.
  // Then:
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].body).toEqual({ cardProviders: ['מקס איט'] });
});
```

> Look at the existing Spending-tab tests in this file for the exact
> `installFetchMock` keys, the `SettingsProvider` wrapper, and the Generate
> button query (it renders the AI analysis card). Mirror them — do not invent
> a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- InsightsView.test.tsx`
Expected: FAIL — body is currently `undefined` (the POST sends no body).

- [ ] **Step 3: Implement** — in `web/src/insights/InsightsView.tsx`, add `useSettings` to `AiAnalysisCard` and send the body:

```tsx
function AiAnalysisCard() {
  const [settings] = useSettings();
  const [status, setStatus] = useState<InsightsStatus | null>(null);
  // ...
  const generate = async (): Promise<void> => {
    try {
      const cardProviders = settings.hideCardTotals ? settings.cardProviders : [];
      await api('/insights', 'POST', { cardProviders });
      // ...existing optimistic setStatus(...) unchanged...
```

`useSettings` is already imported at the top of the file (line 6). `api` already
accepts a JSON body as its third arg.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- InsightsView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd web && npm run typecheck
git add src/insights/InsightsView.tsx src/insights/InsightsView.test.tsx
git commit -m "web: AI insights Generate sends cardProviders so the prompt excludes card-bill totals"
```

---

## PART B — Item 4: Holdings drill-down + per-range stats (React, client-only)

### Task B1: `buildHoldingSeries` pure module + extend `PerformanceEntry.data` type

**Files:**
- Create: `web/src/insights/holdingSeries.ts`
- Create: `web/src/insights/holdingSeries.test.ts`
- Modify: `web/src/insights/equitySeries.ts:24` (extend `PerformanceEntry.data`)

- [ ] **Step 1: Write the failing test** — create `web/src/insights/holdingSeries.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHoldingSeries } from './holdingSeries';
import type { HoldingSnapshot } from './equitySeries';

const id = (value: number) => value; // identity convert (no FX)

function snap(accountId: string, date: string, value: number): HoldingSnapshot {
  return { accountId, symbol: 'VT', date, value, currency: 'USD' };
}

describe('buildHoldingSeries', () => {
  it('sums a symbol across its accounts per day', () => {
    const snaps = [
      snap('a', '2026-01-01', 10), snap('b', '2026-01-01', 5),
      snap('a', '2026-01-02', 12),
    ];
    const out = buildHoldingSeries(snaps, 'VT', ['a', 'b'], (v) => id(v), 'USD', {});
    expect(out).toEqual([
      { date: '2026-01-01', value: 15 },
      { date: '2026-01-02', value: 12 },
    ]);
  });

  it('ignores other symbols and out-of-scope accounts', () => {
    const snaps = [
      snap('a', '2026-01-01', 10),
      { ...snap('a', '2026-01-01', 99), symbol: 'AAPL' },
      snap('z', '2026-01-01', 50),
    ];
    const out = buildHoldingSeries(snaps, 'VT', ['a'], (v) => id(v), 'USD', {});
    expect(out).toEqual([{ date: '2026-01-01', value: 10 }]);
  });

  it('clips points before an account inception date', () => {
    const snaps = [snap('a', '2026-01-01', 10), snap('a', '2026-02-01', 20)];
    const out = buildHoldingSeries(snaps, 'VT', ['a'], (v) => id(v), 'USD', { a: '2026-01-15' });
    expect(out).toEqual([{ date: '2026-02-01', value: 20 }]);
  });

  it('drops points the converter cannot price (null)', () => {
    const snaps = [snap('a', '2026-01-01', 10)];
    const out = buildHoldingSeries(snaps, 'VT', ['a'], () => null, 'USD', {});
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- holdingSeries.test.ts`
Expected: FAIL with "buildHoldingSeries is not a function / cannot find module".

- [ ] **Step 3: Implement** — create `web/src/insights/holdingSeries.ts`:

```ts
import type { HoldingSnapshot, SeriesPoint, Convert } from './equitySeries';

/** Per-holding value series: sums one symbol's daily value across the given
 *  accounts, clips each account's points before its inception date, and
 *  converts each point to the display currency. Faithful port of the legacy
 *  SPA's buildHoldingSeries (sidecar/public/app.html ~6342). Points the
 *  converter returns null for (unknown FX rate) are dropped. */
export function buildHoldingSeries(
  snapshots: HoldingSnapshot[],
  symbol: string,
  accountIds: string[],
  convert: Convert,
  fallbackCurrency: string,
  inceptionByAccount: Record<string, string>,
): SeriesPoint[] {
  const ids = new Set(accountIds);
  const byDate = new Map<string, number>();
  for (const s of snapshots) {
    if (s.symbol !== symbol || !ids.has(s.accountId)) continue;
    const cap = inceptionByAccount[s.accountId];
    if (cap && s.date < cap) continue;
    const v = convert(s.value, s.currency || fallbackCurrency);
    if (v == null) continue;
    byDate.set(s.date, (byDate.get(s.date) ?? 0) + v);
  }
  return [...byDate.keys()]
    .sort()
    .map((date) => ({ date, value: byDate.get(date)! }));
}
```

> `Convert` and `SeriesPoint` are already exported from `equitySeries.ts`
> (lines 47–54). `HoldingSnapshot` too (line 39).

- [ ] **Step 4: Extend the `PerformanceEntry.data` type** — edit `web/src/insights/equitySeries.ts:24`:

```ts
export interface BrokerageRangeStats {
  rateOfReturn: number | null;
  dividendIncome: number | null;
  contributions: number | null;
}

export interface PerformanceEntry {
  connectionId: string;
  data: {
    totalEquity: { date: string; value: number; currency?: string }[];
    currency?: string;
    rateOfReturn?: number | null;
    dividendIncome?: number | null;
    byRange?: Record<string, BrokerageRangeStats>;
  };
}
```

> Pure type-widening — no runtime change. `byRange` is already present in the
> JSON the engine sends (`sidecar/src/scrapers.ts` `BrokeragePerformanceData`).

- [ ] **Step 5: Run test + typecheck**

Run: `cd web && npm test -- holdingSeries.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/insights/holdingSeries.ts src/insights/holdingSeries.test.ts src/insights/equitySeries.ts
git commit -m "web: buildHoldingSeries helper + widen PerformanceEntry.data with byRange stats"
```

---

### Task B2: Consolidate holdings by symbol + clickable expand rows + stats grid

**Files:**
- Modify: `web/src/insights/InsightsView.tsx` — replace the holdings `<ul>` (lines ~693–764) and add module-level `HoldingRow` + `HoldingDetail` components and a consolidation step.
- Test: `web/src/insights/InsightsView.test.tsx`

This task delivers consolidation + the expand affordance + the stats grid.
The sparkline (B3) and per-range tiles (B4) build on it.

- [ ] **Step 1: Add `openHolding` state + consolidation in `BrokerageSubTab`.**

Add near the other `useState` calls in `BrokerageSubTab` (~line 442):

```tsx
  const [openHolding, setOpenHolding] = useState<string | null>(null);
```

After `scopedHoldings` is computed (~line 537), build a by-symbol
consolidation (place it just before the `return`):

```tsx
  // Consolidate by symbol across in-scope accounts — matches the legacy SPA's
  // holdings panel and lets a symbol's sparkline sum across the accounts it
  // sits in. Each consolidated row carries its contributing accountIds.
  interface ConsolidatedHolding {
    symbol: string;
    description: string | null;
    units: number;
    price: number | null;
    currency: string;
    value: number | null;
    cost: number | null;
    gain: number | null;
    gainPct: number | null;
    accountIds: string[];
  }
  const consolidatedMap = new Map<string, ConsolidatedHolding>();
  for (const h of scopedHoldings) {
    const s = holdingStats(h);
    let e = consolidatedMap.get(h.symbol);
    if (!e) {
      e = {
        symbol: h.symbol, description: h.description, units: 0, price: h.price,
        currency: h.currency, value: null, cost: null, gain: null,
        gainPct: null, accountIds: [],
      };
      consolidatedMap.set(h.symbol, e);
    }
    e.units += h.units;
    if (s.value != null) e.value = (e.value ?? 0) + s.value;
    if (s.cost != null) e.cost = (e.cost ?? 0) + s.cost;
    if (s.gain != null) e.gain = (e.gain ?? 0) + s.gain;
    e.accountIds.push(h.accountId);
  }
  const consolidated = [...consolidatedMap.values()]
    .map((e) => ({
      ...e,
      gainPct: e.gain != null && e.cost ? (e.gain / Math.abs(e.cost)) * 100 : null,
    }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  // Per-account inception map for the sparkline clip (B3).
  const inceptionByAccount: Record<string, string> = {};
  for (const a of accounts) if (a.inceptionDate) inceptionByAccount[a.id] = a.inceptionDate;
```

- [ ] **Step 2: Replace the holdings list render.** Swap the existing
`scopedHoldings.slice().sort(...).map(...)` block (the `<li>` items, lines
~694–739) for a map over `consolidated` that renders `<HoldingRow>`. Keep the
existing Cash row exactly as-is. The list becomes:

```tsx
          <ul className="brokerage-holdings" data-testid="brokerage-holdings">
            {consolidated.map((r, i) => (
              <HoldingRow
                key={r.symbol}
                row={r}
                index={i}
                portfolioValue={portfolioValue}
                displayCur={cur}
                rates={rates}
                open={openHolding === r.symbol}
                onToggle={() =>
                  setOpenHolding((cur) => (cur === r.symbol ? null : r.symbol))}
                range={range}
                holdingSnapshots={data.holdingSnapshots}
                inceptionByAccount={inceptionByAccount}
              />
            ))}
            {hasCashRow && (
              /* ...existing Cash <li> unchanged... */
            )}
          </ul>
```

Also update the header count to use `consolidated.length`:

```tsx
            <div className="ins-sub">
              Holdings · {consolidated.length}
              {' '}position{consolidated.length === 1 ? '' : 's'}
            </div>
```

> The `StatBox label="Holdings"` tile keeps using `scopedHoldings.length`
> (raw positions) — leave it; legacy shows the consolidated count in the panel
> header and the raw count in the tile, and parity isn't worth a behavior change.
> If you prefer one number, use `consolidated.length` in both — but do it
> consistently. Pick `consolidated.length` for the panel header only.

- [ ] **Step 3: Add the `HoldingRow` + `HoldingDetail` module-level components**
(place them after the `StatBox` component, ~line 783). `HoldingDetail` renders
only the stats grid in this task; the sparkline is added in B3.

```tsx
const HOLDING_PALETTE = ['#5C9EF5', '#5CC773', '#A880ED', '#F59942', '#E96B6B',
  '#74d0c2', '#ffb74d', '#c2b3ff', '#ff8a76', '#a0a6ff'];

interface ConsolidatedHoldingRow {
  symbol: string; description: string | null; units: number; price: number | null;
  currency: string; value: number | null; cost: number | null; gain: number | null;
  gainPct: number | null; accountIds: string[];
}

function HoldingRow({
  row, index, portfolioValue, displayCur, rates, open, onToggle,
  range, holdingSnapshots, inceptionByAccount,
}: {
  row: ConsolidatedHoldingRow; index: number; portfolioValue: number;
  displayCur: string; rates: Record<string, number> | null; open: boolean;
  onToggle: () => void; range: Range; holdingSnapshots: HoldingSnapshot[];
  inceptionByAccount: Record<string, string>;
}) {
  const dot = HOLDING_PALETTE[index % HOLDING_PALETTE.length];
  const valCur = convertAmount(row.value ?? 0, row.currency, displayCur, rates);
  const weight = portfolioValue > 0 ? (valCur / portfolioValue) * 100 : 0;
  const pnlCur = convertAmount(row.gain ?? 0, row.currency, displayCur, rates);
  const pnlPct = row.gainPct ?? 0;
  return (
    <li className={`bh-item${open ? ' open' : ''}`}>
      <button
        type="button"
        className={`bh-row brk-row${open ? ' open' : ''}`}
        aria-expanded={open}
        onClick={onToggle}
        data-testid={`holding-row-${row.symbol}`}
      >
        <span className="bh-dot" style={{ background: dot }} />
        <div className="bh-main">
          <div className="bh-symbol">{row.symbol}</div>
          {row.description && <div className="bh-desc">{row.description}</div>}
        </div>
        <div className="bh-weight">
          <span className="bh-weight-fill"
            style={{ width: `${Math.max(2, weight)}%`, background: dot }} />
        </div>
        <div className="bh-value">
          {money(valCur, displayCur)}
          <div className="bh-weight-pct">{weight.toFixed(1)}%</div>
        </div>
        {row.gain != null && (
          <span className={`brk-pnl ${pnlCur >= 0 ? 'good' : 'bad'}`}>
            {pnlCur >= 0 ? '▲' : '▼'} {Math.abs(pnlPct).toFixed(2)}%{' '}
            {pnlCur >= 0 ? '+' : '−'}{money(Math.abs(pnlCur), displayCur)}
          </span>
        )}
        <span className="bh-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <HoldingDetail
          row={row} displayCur={displayCur} rates={rates} range={range}
          holdingSnapshots={holdingSnapshots} inceptionByAccount={inceptionByAccount}
        />
      )}
    </li>
  );
}

function HoldingDetail({
  row, displayCur, rates, range, holdingSnapshots, inceptionByAccount,
}: {
  row: ConsolidatedHoldingRow; displayCur: string;
  rates: Record<string, number> | null; range: Range;
  holdingSnapshots: HoldingSnapshot[]; inceptionByAccount: Record<string, string>;
}) {
  const conv = (v: number, c: string) => convertAmount(v, c, displayCur, rates);
  const avgPrice = row.cost != null && row.units ? row.cost / row.units : null;
  const stat = (label: string, value: string, tone: 'good' | 'bad' | '' = '') => (
    <div className="hd-stat">
      <div className="hd-stat-cap">{label}</div>
      <div className={`hd-stat-val${tone ? ' ' + tone : ''}`}>{value}</div>
    </div>
  );
  const gainTone: 'good' | 'bad' | '' = row.gain == null ? '' : row.gain >= 0 ? 'good' : 'bad';
  const m = (v: number | null) => v == null ? '—' : money(conv(v, row.currency), displayCur);
  return (
    <div className="hp-detail" data-testid={`holding-detail-${row.symbol}`}>
      <div className="hd-stats">
        {stat('Units', row.units.toLocaleString(undefined, { maximumFractionDigits: 4 }))}
        {stat('Last price', m(row.price))}
        {stat('Avg cost', m(avgPrice))}
        {stat('Market value', m(row.value))}
        {stat('Total cost', m(row.cost))}
        {stat(`Unrealized · ALL`,
          row.gain == null ? '—'
            : `${row.gain >= 0 ? '+' : '−'}${money(Math.abs(conv(row.gain, row.currency)), displayCur)}`,
          gainTone)}
      </div>
      {/* sparkline added in Task B3 */}
    </div>
  );
}
```

> Ensure `HoldingSnapshot` is imported in `InsightsView.tsx` (it already is —
> line 17 `type HoldingSnapshot`).

- [ ] **Step 4: Write the test** — add to `web/src/insights/InsightsView.test.tsx`, reusing the file's brokerage render harness (the existing brokerage tests stub `GET /api/brokerage` + `GET /api/accounts`). Add a holdings-with-two-positions stub and assert expand:

```tsx
it('clicking a holding row reveals its stats grid; clicking again hides it', async () => {
  // ...render the Brokerage sub-tab with a /brokerage stub that returns two
  // holdings (e.g. VT and VBR) for one account, mirroring the existing
  // brokerage test stubs in this file...
  const user = userEvent.setup();
  const row = await screen.findByTestId('holding-row-VT');
  expect(screen.queryByTestId('holding-detail-VT')).toBeNull();
  await user.click(row);
  expect(screen.getByTestId('holding-detail-VT')).toBeInTheDocument();
  await user.click(row);
  await waitFor(() => expect(screen.queryByTestId('holding-detail-VT')).toBeNull());
});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd web && npm test -- InsightsView.test.tsx && npm run typecheck`
Expected: PASS. (Existing brokerage tests still green — the row markup classes
`bh-row brk-row`, value, weight and P&L pill are preserved.)

- [ ] **Step 6: Commit**

```bash
git add src/insights/InsightsView.tsx src/insights/InsightsView.test.tsx
git commit -m "web: consolidate brokerage holdings by symbol + clickable expand with stats grid"
```

---

### Task B3: Per-holding sparkline inside the expanded detail

**Files:**
- Modify: `web/src/insights/InsightsView.tsx` (`HoldingDetail`)
- Test: `web/src/insights/InsightsView.test.tsx`

- [ ] **Step 1: Implement** — in `HoldingDetail`, build the series and render a
`LineChart`. Add imports if missing: `buildHoldingSeries` from `./holdingSeries`,
`sliceRange` is already imported (line 15), `LineChart` is already imported.

Replace the `{/* sparkline added in Task B3 */}` comment with:

```tsx
      <HoldingSparkline
        row={row} displayCur={displayCur} rates={rates} range={range}
        holdingSnapshots={holdingSnapshots} inceptionByAccount={inceptionByAccount}
      />
```

And add the module-level component:

```tsx
function HoldingSparkline({
  row, displayCur, rates, range, holdingSnapshots, inceptionByAccount,
}: {
  row: ConsolidatedHoldingRow; displayCur: string;
  rates: Record<string, number> | null; range: Range;
  holdingSnapshots: HoldingSnapshot[]; inceptionByAccount: Record<string, string>;
}) {
  const convert = (v: number, c: string) => convertAmount(v, c, displayCur, rates);
  const fullSeries = buildHoldingSeries(
    holdingSnapshots, row.symbol, row.accountIds, convert, row.currency, inceptionByAccount,
  );
  const series = sliceRange(fullSeries, range);
  if (series.length < 2) {
    return (
      <div className="hd-empty" data-testid={`holding-spark-empty-${row.symbol}`}>
        {fullSeries.length >= 1
          ? 'No data in this window — try ALL.'
          : 'Per-position history starts collecting on each sync — the sparkline appears after a couple of syncs.'}
      </div>
    );
  }
  const tone: 'good' | 'bad' =
    series.at(-1)!.value - series[0]!.value >= 0 ? 'good' : 'bad';
  return (
    <div className="hd-chart-wrap" data-testid={`holding-spark-${row.symbol}`}>
      <LineChart series={series} currency={displayCur} tone={tone} showAxis={false} />
    </div>
  );
}
```

- [ ] **Step 2: Write the test** — add to `InsightsView.test.tsx`. Extend the
`/brokerage` stub with `holdingSnapshots` for VT spanning ≥2 dates, then:

```tsx
it('expanded holding shows a sparkline when it has ≥2 snapshots', async () => {
  // /brokerage stub holdingSnapshots: [
  //   { accountId:'acc1', symbol:'VT', date:'2026-01-01', value:100, currency:'USD' },
  //   { accountId:'acc1', symbol:'VT', date:'2026-02-01', value:120, currency:'USD' },
  // ]
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('holding-row-VT'));
  expect(screen.getByTestId('holding-spark-VT')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests + typecheck**

Run: `cd web && npm test -- InsightsView.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/insights/InsightsView.tsx src/insights/InsightsView.test.tsx
git commit -m "web: per-holding sparkline in the expanded holdings detail"
```

---

### Task B4: Per-range stat tiles (rate of return, dividends) + period-aware Gain tile

**Files:**
- Modify: `web/src/insights/InsightsView.tsx` (the `brk-stats` block, ~line 600–627, plus a derivation above the return)
- Test: `web/src/insights/InsightsView.test.tsx`

- [ ] **Step 1: Derive the per-range numbers** — add above the `return` in
`BrokerageSubTab` (after `scopedBrkAccounts`, ~line 540):

```tsx
  // Per-range reporting stats, scoped to the in-focus accounts' connections.
  // performance[] is connectionId-scoped; map the in-scope accounts to their
  // connection ids and aggregate byRange[range] across the matching entries.
  // Average rate of return; sum dividends; convert to display currency.
  const scopedConnIds = new Set(scopedBrkAccounts.map((a) => a.connectionId));
  let rateSum = 0, rateCount = 0, dividend = 0, haveDividend = false;
  for (const p of data.performance) {
    if (!scopedConnIds.has(p.connectionId)) continue;
    const w = p.data.byRange?.[range] ?? {
      rateOfReturn: p.data.rateOfReturn ?? null,
      dividendIncome: p.data.dividendIncome ?? null,
      contributions: null,
    };
    if (typeof w.rateOfReturn === 'number') { rateSum += w.rateOfReturn; rateCount += 1; }
    if (typeof w.dividendIncome === 'number') {
      const v = convertAmount(w.dividendIncome, p.data.currency ?? cur, cur, rates);
      dividend += v; haveDividend = true;
    }
  }
  const rateOfReturn = rateCount ? (rateSum / rateCount) * 100 : null;

  // Period-aware gain: first-vs-last over the sliced equity window (replaces
  // the fixed Gain · 1Y). `change`/`changePct` (computed above) are exactly
  // that — reuse them so the tile and the chart's header pill agree.
  const periodGain = change;
  const periodGainPct = changePct;
```

> `change` and `changePct` already exist (lines 530–531) and are the
> sliced-window first-vs-last delta — reuse them; do not recompute.

- [ ] **Step 2: Update the `brk-stats` tiles** — replace the fixed "Gain · 1Y"
StatBox and append the two new conditional tiles. The block becomes:

```tsx
      <div className="brk-stats" data-testid="brokerage-stats">
        <StatBox label="Portfolio value" value={money(portfolioValue, cur)} tone="" />
        <StatBox
          label={`Gain · ${range}`}
          value={`${periodGain >= 0 ? '+' : '−'}${money(Math.abs(periodGain), cur)}`}
          sub={`${periodGainPct >= 0 ? '+' : '−'}${Math.abs(periodGainPct).toFixed(2)}%`}
          tone={periodGain >= 0 ? 'good' : 'bad'}
        />
        <StatBox
          label="Unrealized P&L"
          value={`${unrealized >= 0 ? '+' : '−'}${money(Math.abs(unrealized), cur)}`}
          tone={unrealized >= 0 ? 'good' : 'bad'}
        />
        <StatBox
          label="Return on cost"
          value={`${returnOnCost >= 0 ? '+' : '−'}${Math.abs(returnOnCost).toFixed(2)}%`}
          tone={returnOnCost >= 0 ? 'good' : 'bad'}
        />
        {rateOfReturn != null && (
          <StatBox
            label={`Rate of return · ${range}`}
            value={`${rateOfReturn >= 0 ? '+' : ''}${rateOfReturn.toFixed(1)}%`}
            tone={rateOfReturn >= 0 ? 'good' : 'bad'}
          />
        )}
        {haveDividend && (
          <StatBox label={`Dividends · ${range}`} value={money(dividend, cur)} tone="good" />
        )}
        <StatBox label="Holdings" value={String(scopedHoldings.length)} tone="" />
      </div>
```

- [ ] **Step 2b: Verify the data flows into `buildEquitySeries`.** No change —
`buildEquitySeries` already receives `data.performance`. The widened type from
B1 makes `byRange`/`rateOfReturn`/`dividendIncome` readable here.

- [ ] **Step 3: Write the test** — add to `InsightsView.test.tsx`. Extend the
`/brokerage` stub's `performance` entry with `byRange`:

```tsx
it('shows rate-of-return and dividend tiles for the active range', async () => {
  // performance: [{ connectionId:'conn1', data: {
  //   totalEquity: [{date:'2026-01-01',value:100},{date:'2026-05-01',value:120}],
  //   currency:'USD',
  //   byRange: { '1Y': { rateOfReturn: 0.085, dividendIncome: 42, contributions: 0 } },
  // }}]
  // accounts: [{ id:'acc1', connectionId:'conn1', ... balance ... }]
  await screen.findByTestId('brokerage-stats');
  expect(screen.getByText('Rate of return · 1Y')).toBeInTheDocument();
  expect(screen.getByText('+8.5%')).toBeInTheDocument();
  expect(screen.getByText('Dividends · 1Y')).toBeInTheDocument();
});

it('hides the rate/dividend tiles when byRange has no numbers', async () => {
  // performance entry with byRange: { '1Y': { rateOfReturn:null, dividendIncome:null, contributions:null } }
  await screen.findByTestId('brokerage-stats');
  expect(screen.queryByText(/Rate of return/)).toBeNull();
  expect(screen.queryByText(/Dividends ·/)).toBeNull();
});
```

> Reuse the exact `/brokerage` + `/accounts` stub shape the existing brokerage
> tests use; only add the `byRange` field and a matching `connectionId` on the
> account. Confirm the default range pill is `1Y` (it is — `useState<Range>('1Y')`).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npm test -- InsightsView.test.tsx && npm run typecheck`
Expected: PASS. Existing brokerage tests that asserted the literal label
"Gain · 1Y" still pass (default range is `1Y`); if any asserted it as a fixed
string regardless of range, update them to the `Gain · ${range}` form.

- [ ] **Step 5: Commit**

```bash
git add src/insights/InsightsView.tsx src/insights/InsightsView.test.tsx
git commit -m "web: per-range rate-of-return + dividend tiles and period-aware Gain tile"
```

---

## PART C — Verify, style, and wrap up

### Task C1: CSS for the new drill-down elements

**Files:**
- Modify: the brokerage/insights stylesheet (find with
  `grep -rn "bh-row\|brk-row\|hp-detail\|hd-stat" web/src --include=*.css`).
  Reuse existing `.bh-*`/`.brk-*` tokens; add `.bh-item`, `.bh-chev`,
  `.hp-detail`, `.hd-stats`, `.hd-stat`, `.hd-stat-cap`, `.hd-stat-val`,
  `.hd-chart-wrap`, `.hd-empty` mirroring the legacy SPA's look.

- [ ] **Step 1:** Locate the brokerage CSS block and the legacy class styles
  in `sidecar/public/app.html` (search `hp-detail`, `hd-stat`, `hp-row`).
  Port the relevant rules (stats grid layout, chevron, detail padding,
  open-state background). Respect `prefers-reduced-motion` for any transition.
- [ ] **Step 2:** Commit.

```bash
git add web/src/**/*.css
git commit -m "web: styles for holdings drill-down stats grid + sparkline"
```

> No test step — CSS is verified visually in C2.

### Task C2: Live visual verification (MANDATORY — PROJECT-RULES §2)

> A UI change is NOT done until chrome-devtools has loaded the live app and a
> screenshot confirms it. No "done" claim before the screenshot exists.

- [ ] **Step 1:** Run the worktree's engine + vite. Because `git worktree`
  doesn't copy `node_modules`, run them directly from the worktree's subdirs
  (per HANDOFF "Worktree-vs-dev-server friction"):
  - engine: `cd <worktree>/sidecar && npm run web` (or reuse the main `:4000`
    engine — the engine changes A1–A3 only affect a fresh fetch, so for the
    UI half the running engine is fine; restart it to exercise A1–A3 live).
  - vite: `cd <worktree>/web && npm run dev` (note the port it picks).
- [ ] **Step 2:** If chrome-devtools MCP isn't connected, launch headed Chrome
  with CDP per PROJECT-RULES §2. Read the dev token from
  `"$HOME/Library/Application Support/Hon/dev-token"` and open
  `http://localhost:<viteport>/#token=<token>`.
- [ ] **Step 3:** Navigate to Insights → Brokerage. Verify, screenshotting each:
  - a holding row expands on click, showing the stats grid + sparkline;
  - flipping the range pills (1M/3M/YTD/1Y/ALL) updates the Gain tile label,
    the rate-of-return/dividend tiles, the chart, AND the open holding's
    sparkline;
  - the account filter pills scope the tiles + holdings;
  - the Cash row still renders and weights sum to ~100%.
  Compare against the legacy SPA at `:4000` for parity.
- [ ] **Step 4:** Switch to Insights → Spending. Restart the worktree engine so
  A1–A3 are live, set a card provider in Settings with "hide card totals" on,
  click **Generate**, and confirm the AI summary's SPENT/Other no longer
  include the card-bill lump sum (compare the prompt's effect to the
  Spending breakdown, which already excludes it). Screenshot.
- [ ] **Step 5:** Read each screenshot back and confirm with your own eyes.

### Task C3: Full suites + HANDOFF update + merge offer

- [ ] **Step 1:** Green baseline:
  ```bash
  cd <worktree>/sidecar && npm test && npm run typecheck
  cd <worktree>/web && npm test && npm run typecheck
  ```
  All must pass.
- [ ] **Step 2:** Update `HANDOFF.md`: move items 4 + 5 out of "Still open on
  the Brokerage Insights page" into a "shipped this session" note (branch +
  commits), and record the deferred `excluded_manual` server-side fidelity gap.
  Commit.
- [ ] **Step 3:** Show the user the branch diff
  (`git log --oneline main..HEAD`, `git diff main...HEAD --stat`) and ask
  whether to merge `--no-ff` into `main`, open a PR, or leave on the branch.
  **Do not push.** **Do not merge without explicit instruction.**

---

## Self-review notes

- **Spec coverage:** Item 5 halves (a)+(b) → A1/A2/A3 (engine) + A4 (client);
  fidelity boundary (no `excluded_manual` server-side) honored, recorded in C3.
  Item 4: consolidate-by-symbol → B2; clickable expand + stats grid → B2;
  sparkline → B1+B3; per-range tiles + period-aware Gain → B1(type)+B4. CSS →
  C1. Visual verification → C2. No engine changes for item 4 (only the TS type
  widens) — matches spec.
- **Type consistency:** `buildHoldingSeries(snapshots, symbol, accountIds,
  convert, fallbackCurrency, inceptionByAccount)` — same arg order in B1 def,
  B1 tests, and B3 call. `ConsolidatedHoldingRow` shape defined once (B2) and
  reused by `HoldingRow`/`HoldingDetail`/`HoldingSparkline`. `BrokerageRangeStats`
  added in B1, consumed in B4 via `byRange[range]`. `start(cardProviders)` in
  A3 matches the A4 POST body key `cardProviders`.
- **No placeholders:** every code step shows real code. The only deliberately
  abbreviated spots are test harness reuse (existing `installFetchMock` keys /
  `SettingsProvider` wrapper in `InsightsView.test.tsx`) — flagged explicitly to
  copy the existing pattern rather than invent one, because the file's harness
  is the source of truth and must not be duplicated.
