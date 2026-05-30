# Brokerage Insights Graceful Degradation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When SnapTrade revokes the `/performance/custom` (403, code 1141) and `/activities` (410) endpoints, make Hon's Brokerage Insights honest and resilient — stitch the equity chart (broker history up to its last point, then Hon's own snapshots), hide the now-wrong window-relative stat tiles, and stop the engine hammering the dead endpoints.

**Architecture:** Engine detects code 1141 inside the SnapTrade SDK layer and reports a `disabled` boolean up through the `ScrapeOutcome`; the runner owns reading/persisting a per-connection disabled marker in the existing `meta` table (no migration) and decides whether to skip the dead calls (re-probing every 24h). `GET /brokerage` surfaces the marker. The client widens `PerformanceEntry` with `fetchedAt`, stitches the equity series via a new pure `stitchSeries` helper (unconditional), and hides the Rate-of-return / Dividend tiles for disabled connections.

**Tech Stack:** TypeScript strict; Fastify + better-sqlite3 (engine, `sidecar/`); React 19 + Vitest + Testing-Library (web, `web/`). Tests run from `sidecar/` and `web/` directly, never repo root.

**Working directory:** worktree `.claude/worktrees/brokerage-degrade-2026-05-30` on branch `session/brokerage-degrade-2026-05-30`. All commands assume you `cd` into that worktree's `sidecar/` or `web/`. `node_modules` is symlinked.

**Spec:** `docs/superpowers/specs/2026-05-30-brokerage-degrade-design.md`

---

## File Structure

**Engine**
- `sidecar/src/snaptrade.ts` — add `isFeatureDisabled`; `fetchPerformanceHistory` returns `{ data?, disabled }`; `runSnapTradeSync` gains an `opts` arg (`skipPerformance`, `skipActivities`) and sets `outcome.performanceDisabled`. No repo access.
- `sidecar/src/scrapers.ts` — `ScrapeOutcome.performanceDisabled?: boolean`.
- `sidecar/src/repo.ts` — `getPerformanceDisabledAt` / `setPerformanceDisabled` (meta-backed; `deleteMeta` already exists).
- `sidecar/src/runner.ts` — `isSnapTrade` branch: read marker, decide skip vs probe (`PERF_REPROBE_MS`), pass opts, persist marker after.
- `sidecar/src/server.ts` — `GET /brokerage` adds `performanceDisabled`.

**Client**
- `web/src/insights/equitySeries.ts` — `PerformanceEntry.fetchedAt?`; new exported `stitchSeries`; `buildEquitySeries` returns `stitchSeries(broker, snapshot)`.
- `web/src/insights/InsightsView.tsx` — `BrokerageResp.performanceDisabled?`; skip disabled connections in the ROR/dividend accumulation.

---

## PART A — Engine

### Task A1: `isFeatureDisabled` predicate

**Files:**
- Modify: `sidecar/src/snaptrade.ts` (add predicate near the existing `isOneUserLimit`, ~line 139)
- Test: `sidecar/tests/snaptrade.test.ts` (file exists from the cash_equivalent work)

- [ ] **Step 1: Write the failing test** — append to `sidecar/tests/snaptrade.test.ts`:

```ts
import { isFeatureDisabled } from '../src/snaptrade.js';

describe('isFeatureDisabled', () => {
  it('is true for SnapTrade code 1141', () => {
    expect(isFeatureDisabled({ responseBody: { code: '1141', detail: 'x' } })).toBe(true);
  });
  it('is true when the detail mentions the feature is not enabled', () => {
    expect(isFeatureDisabled({ responseBody: JSON.stringify({
      detail: 'Feature is not enabled for this customer or this connection',
    }) })).toBe(true);
  });
  it('is false for other errors', () => {
    expect(isFeatureDisabled({ responseBody: { code: '1012', detail: 'nope' } })).toBe(false);
    expect(isFeatureDisabled(new Error('network'))).toBe(false);
  });
});
```

> The existing `snaptrade.test.ts` already imports from `'../src/snaptrade.js'`; add `isFeatureDisabled` to that import line rather than duplicating it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npm test -- snaptrade.test.ts`
Expected: FAIL — `isFeatureDisabled is not a function` / not exported.

- [ ] **Step 3: Implement** — in `sidecar/src/snaptrade.ts`, just after `isOneUserLimit` (~line 142), add an exported predicate. It reuses the existing `snapErrorBody` helper:

```ts
/** True when SnapTrade reports the reporting/performance feature is not
 *  enabled for this plan/connection (HTTP 403, code 1141). Distinct from a
 *  transient failure so the caller can persist the disabled state and stop
 *  calling the dead endpoint. */
export function isFeatureDisabled(err: unknown): boolean {
  const body = snapErrorBody(err);
  return body?.code === '1141'
    || /feature is not enabled/i.test(body?.detail ?? '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npm test -- snaptrade.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd sidecar && npm run typecheck
git add src/snaptrade.ts tests/snaptrade.test.ts
git commit -m "sidecar: snaptrade — isFeatureDisabled predicate for code 1141"
```

---

### Task A2: repo disabled-marker accessors

**Files:**
- Modify: `sidecar/src/repo.ts` (add two methods near the other meta-backed accessors, e.g. after `setMeta`/`deleteMeta` ~line 1768)
- Test: `sidecar/tests/repo.test.ts`

- [ ] **Step 1: Write the failing test** — append to `sidecar/tests/repo.test.ts`:

```ts
describe('snaptrade performance-disabled marker', () => {
  it('round-trips and clears', () => {
    const { repo } = makeRepo();
    expect(repo.getPerformanceDisabledAt('conn1')).toBeNull();
    repo.setPerformanceDisabled('conn1', '2026-05-30T10:00:00.000Z');
    expect(repo.getPerformanceDisabledAt('conn1')).toBe('2026-05-30T10:00:00.000Z');
    repo.setPerformanceDisabled('conn1', null);
    expect(repo.getPerformanceDisabledAt('conn1')).toBeNull();
  });
  it('is scoped per connection', () => {
    const { repo } = makeRepo();
    repo.setPerformanceDisabled('connA', '2026-05-30T10:00:00.000Z');
    expect(repo.getPerformanceDisabledAt('connB')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npm test -- repo.test.ts`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement** — add to the `Repo` class in `sidecar/src/repo.ts`:

```ts
  private perfDisabledKey(connectionId: string): string {
    return `snaptrade:perf-disabled:${connectionId}`;
  }

  /** ISO timestamp of when SnapTrade performance was last seen disabled for
   *  this connection, or null if currently considered available. */
  getPerformanceDisabledAt(connectionId: string): string | null {
    return this.getMeta(this.perfDisabledKey(connectionId)) ?? null;
  }

  /** Records (ISO string) or clears (null) the performance-disabled marker. */
  setPerformanceDisabled(connectionId: string, when: string | null): void {
    if (when === null) this.deleteMeta(this.perfDisabledKey(connectionId));
    else this.setMeta(this.perfDisabledKey(connectionId), when);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npm test -- repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd sidecar && npm run typecheck
git add src/repo.ts tests/repo.test.ts
git commit -m "sidecar: repo — per-connection snaptrade performance-disabled marker"
```

---

### Task A3: `fetchPerformanceHistory` reports `disabled`; `runSnapTradeSync` skip flags + outcome

**Files:**
- Modify: `sidecar/src/scrapers.ts` (`ScrapeOutcome` ~line 127)
- Modify: `sidecar/src/snaptrade.ts` (`fetchPerformanceHistory` ~455, `runSnapTradeSync` ~282–360)

No unit test here (route/SDK-integration code is tested manually per the sidecar convention; the SDK client is not mocked in this suite). Behaviour is exercised live at the end. Implement, typecheck, run the full sidecar suite (must stay green), commit.

- [ ] **Step 1: Add the outcome channel** — in `sidecar/src/scrapers.ts`, add to the `ScrapeOutcome` interface (alongside `brokeragePerformance?`):

```ts
  /** True when SnapTrade's performance feature is disabled for this plan
   *  (every reporting range returned 403 code 1141). The runner persists
   *  this so the UI can degrade and future syncs can skip the dead calls. */
  performanceDisabled?: boolean;
```

- [ ] **Step 2: Make `fetchPerformanceHistory` report disabled** — in `sidecar/src/snaptrade.ts`. Change its return type to include the flag. Today it returns `BrokeragePerformanceData | undefined`; make it return `{ data?: BrokeragePerformanceData; disabled: boolean }`.

In `fetchRangeReport` (~399), capture whether the failure was the disabled signal. Simplest: have it return `{ raw: unknown | null; disabled: boolean }`:

```ts
async function fetchRangeReport(
  snaptrade: Snaptrade, userId: string, userSecret: string,
  range: RangeKey, end: Date,
): Promise<{ raw: unknown | null; disabled: boolean }> {
  const start = rangeStartDate(range, end);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const res = await snaptrade.transactionsAndReporting.getReportingCustomRange({
      userId, userSecret, startDate: fmt(start), endDate: fmt(end),
      detailed: range === 'ALL',
    });
    return { raw: res.data ?? {}, disabled: false };
  } catch (err) {
    const disabled = isFeatureDisabled(err);
    process.stdout.write(
      `snaptrade performance ${range} failed: ${describeSnapError(err)}` +
      (disabled ? ' [feature disabled]' : '') + '\n',
    );
    return { raw: null, disabled };
  }
}
```

Then in `fetchPerformanceHistory` (~455), adapt the `Promise.all` to the new shape, and compute `disabled` = every range returned `disabled: true`:

```ts
async function fetchPerformanceHistory(
  snaptrade: Snaptrade, userId: string, userSecret: string,
): Promise<{ data?: BrokeragePerformanceData; disabled: boolean }> {
  const end = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const fetched = await Promise.all(
    RANGE_KEYS.map(async (r) =>
      [r, await fetchRangeReport(snaptrade, userId, userSecret, r, end)] as const),
  );

  const disabled = fetched.every(([, res]) => res.disabled);

  // ALL anchors the equity series; if it failed, nothing to draw.
  const allEntry = fetched.find(([r]) => r === 'ALL');
  const allData = allEntry ? (allEntry[1].raw as
    {
      totalEquityTimeframe?: unknown;
      contributionTimeframeCumulative?: unknown;
      rateOfReturn?: number | null;
      dividendIncome?: number | null;
      contributions?: { total?: number | null } | number | null;
    } | null) : null;
  if (!allData) return { data: undefined, disabled };

  const byRange: Record<string, BrokerageRangeStats> = {};
  for (const [r, res] of fetched) {
    if (res.raw) byRange[r] = extractRangeStats(res.raw);
  }

  const totalEquity = mapPoints(allData.totalEquityTimeframe);
  const allRange = byRange.ALL ?? extractRangeStats(allData);
  const startDate = fmt(rangeStartDate('ALL', end));
  const endDate = fmt(end);
  if (totalEquity.length === 0) {
    process.stdout.write(
      `snaptrade performance: empty totalEquityTimeframe (${startDate}..${endDate})\n`,
    );
  }

  return {
    data: {
      totalEquity,
      contributionsCumulative: mapPoints(allData.contributionTimeframeCumulative),
      rateOfReturn: allRange.rateOfReturn,
      dividendIncome: allRange.dividendIncome,
      contributions: allRange.contributions,
      currency: totalEquity[0]?.currency,
      rangeStart: startDate,
      rangeEnd: endDate,
      byRange,
    },
    disabled,
  };
}
```

> Keep `extractRangeStats` / `mapPoints` / `rangeStartDate` / `RANGE_KEYS` exactly as they are. Only the wrapping changed.

- [ ] **Step 3: Add `opts` to `runSnapTradeSync` and wire the outcome** — change the signature (~282) and the two call sites inside it (the activities fetch ~323 and the performance fetch ~346–352):

```ts
export async function runSnapTradeSync(
  creds: Record<string, string>,
  vault: Vault,
  opts: { skipPerformance?: boolean; skipActivities?: boolean } = {},
  onProgress?: (message: string) => void,
): Promise<ScrapeOutcome> {
```

In the per-account loop, gate the activities call on `opts.skipActivities`:

```ts
      const [holdings, inceptionDate] = await Promise.all([
        fetchHoldings(snaptrade, userId, userSecret, accountId),
        opts.skipActivities
          ? Promise.resolve(undefined)
          : fetchEarliestActivityDate(snaptrade, userId, userSecret, accountId),
      ]);
```

Replace the performance block (~345–352) with:

```ts
    let brokeragePerformance: BrokeragePerformanceData | undefined;
    let performanceDisabled = false;
    if (!opts.skipPerformance) {
      onProgress?.('Fetching historical performance from SnapTrade…');
      const perf = await fetchPerformanceHistory(snaptrade, userId, userSecret);
      brokeragePerformance = perf.data;
      performanceDisabled = perf.disabled;
    }
    return { success: true, accounts, brokeragePerformance, performanceDisabled };
```

- [ ] **Step 4: Typecheck + full sidecar suite**

Run: `cd sidecar && npm run typecheck && npm test`
Expected: typecheck clean; all sidecar tests PASS (no behavioural test added here — covered live).

- [ ] **Step 5: Commit**

```bash
git add src/scrapers.ts src/snaptrade.ts
git commit -m "sidecar: snaptrade — report performanceDisabled + skipPerformance/skipActivities opts"
```

---

### Task A4: Runner reads/persists the marker and decides skip-vs-probe

**Files:**
- Modify: `sidecar/src/runner.ts` (the `isSnapTrade` dispatch ~192–197, and the persist block ~287–290)

No unit test (runner orchestration is tested manually per convention). Implement, typecheck, full suite, commit. Logic verified live at the end.

- [ ] **Step 1: Add the re-probe constant** — near the top of `sidecar/src/runner.ts` (with other module constants like `BANK_SESSION_DENYLIST`):

```ts
// Once SnapTrade reports its performance feature disabled (code 1141), stop
// calling the dead endpoint — but re-probe this often so a re-enabled plan
// recovers on its own.
const PERF_REPROBE_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 2: Decide skip flags before dispatch + pass them in** — replace the `isSnapTrade` branch (~192–197):

```ts
      if (isSnapTrade(args.companyId)) {
        const disabledAt = this.repo.getPerformanceDisabledAt(args.connectionId);
        const nowMs = Date.now();
        const skip = disabledAt != null
          && nowMs - new Date(disabledAt).getTime() < PERF_REPROBE_MS;
        log.info('dispatch', { runner: 'snaptrade', skipPerformance: skip });
        outcome = await runSnapTradeSync(
          args.credentials,
          this.vault,
          { skipPerformance: skip, skipActivities: skip },
          (message) => {
            status.message = message;
            log.info('snaptrade.progress', { message });
          },
        );
      } else if (isPensionCompany(args.companyId)) {
```

> `Date.now()` is acceptable here — `runner.ts` is orchestration, not a pure unit under test (it already uses `new Date()` for run timing). The skip-window math has no dedicated unit test; it's exercised live.

- [ ] **Step 3: Persist the marker after a successful run** — extend the existing performance-persist block (~287–290):

```ts
      if (isSnapTrade(args.companyId)) {
        if (outcome.performanceDisabled) {
          this.repo.setPerformanceDisabled(args.connectionId, new Date().toISOString());
          log.info('brokerage.performance.disabled');
        } else if (outcome.brokeragePerformance) {
          this.repo.setPerformanceDisabled(args.connectionId, null);
        }
      }
      if (outcome.brokeragePerformance) {
        this.repo.saveBrokeragePerformance(args.connectionId, outcome.brokeragePerformance);
        log.info('brokerage.performance.saved');
      }
```

> Order matters: clear the marker (on a real success) before saving. A skipped fetch leaves both `performanceDisabled` falsy and `brokeragePerformance` undefined, so the marker is untouched — correct.

- [ ] **Step 4: Typecheck + full sidecar suite**

Run: `cd sidecar && npm run typecheck && npm test`
Expected: clean + green.

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts
git commit -m "sidecar: runner — skip/re-probe dead snaptrade performance calls, persist disabled marker"
```

---

### Task A5: `GET /brokerage` surfaces `performanceDisabled`

**Files:**
- Modify: `sidecar/src/server.ts` (the `/brokerage` handler ~493–506)

No unit test (route handler, manual convention). Implement, typecheck, commit.

- [ ] **Step 1: Implement** — in the `GET /brokerage` handler, add the map to the returned object:

```ts
app.get('/brokerage', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const ilsRates = await getIlsRates();
  const performanceDisabled: Record<string, string> = {};
  for (const c of repo.listConnections()) {
    const at = repo.getPerformanceDisabledAt(c.id);
    if (at) performanceDisabled[c.id] = at;
  }
  return {
    holdings: repo.listHoldings(),
    snapshots: repo.listValueSnapshots(),
    holdingSnapshots: repo.listHoldingSnapshots(),
    performance: repo.listBrokeragePerformance(),
    performanceDisabled,
    ilsRates,
  };
});
```

- [ ] **Step 2: Typecheck**

Run: `cd sidecar && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "sidecar: /brokerage surfaces performanceDisabled per connection"
```

---

## PART B — Client

### Task B1: `stitchSeries` helper + `PerformanceEntry.fetchedAt`

**Files:**
- Modify: `web/src/insights/equitySeries.ts` (add `fetchedAt?` to `PerformanceEntry` ~24; add exported `stitchSeries`)
- Test: `web/src/insights/equitySeries.test.ts` (exists)

- [ ] **Step 1: Write the failing test** — append to `web/src/insights/equitySeries.test.ts`:

```ts
import { stitchSeries } from './equitySeries';

describe('stitchSeries', () => {
  const P = (date: string, value: number) => ({ date, value });

  it('uses broker points up to its last date, then snapshot points after', () => {
    const broker = [P('2024-01-01', 100), P('2024-06-01', 120)];
    const snap = [P('2024-05-01', 999), P('2024-07-01', 130), P('2024-08-01', 140)];
    expect(stitchSeries(broker, snap)).toEqual([
      P('2024-01-01', 100),
      P('2024-06-01', 120),
      P('2024-07-01', 130),
      P('2024-08-01', 140),
    ]);
  });

  it('returns the snapshot series unchanged when broker is empty', () => {
    const snap = [P('2024-07-01', 130)];
    expect(stitchSeries([], snap)).toEqual(snap);
  });

  it('returns the broker series unchanged when there is nothing newer', () => {
    const broker = [P('2024-01-01', 100), P('2024-06-01', 120)];
    const snap = [P('2024-03-01', 110)];
    expect(stitchSeries(broker, snap)).toEqual(broker);
  });

  it('returns broker as-is when snapshot is empty', () => {
    const broker = [P('2024-01-01', 100)];
    expect(stitchSeries(broker, [])).toEqual(broker);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- equitySeries.test.ts`
Expected: FAIL — `stitchSeries` not exported.

- [ ] **Step 3: Implement** — in `web/src/insights/equitySeries.ts`. First widen the type (the `PerformanceEntry` interface):

```ts
export interface PerformanceEntry {
  connectionId: string;
  /** When the engine last fetched this — already on the wire from
   *  repo.listBrokeragePerformance(); now read client-side. */
  fetchedAt?: string;
  data: {
    totalEquity: { date: string; value: number; currency?: string }[];
    currency?: string;
    rateOfReturn?: number | null;
    dividendIncome?: number | null;
    byRange?: Record<string, BrokerageRangeStats>;
  };
}
```

Then add the exported helper (near `sliceRange`):

```ts
/** Stitches a broker-reported equity series with Hon's own snapshot-derived
 *  series: broker points up to (and including) the broker's last date, then
 *  snapshot points strictly after it. Keeps the deep broker history while the
 *  live tail comes from Hon's per-sync snapshots — so a revoked/frozen broker
 *  performance feed no longer freezes the chart. Either side empty → the other
 *  side as-is. Both empty → []. */
export function stitchSeries(
  broker: SeriesPoint[],
  snapshot: SeriesPoint[],
): SeriesPoint[] {
  if (!broker.length) return snapshot;
  const lastBrokerDate = broker[broker.length - 1]!.date;
  const tail = snapshot.filter((p) => p.date > lastBrokerDate);
  return tail.length ? [...broker, ...tail] : broker;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- equitySeries.test.ts`
Expected: PASS (new `stitchSeries` tests + the existing suite).

- [ ] **Step 5: Typecheck + commit**

```bash
cd web && npm run typecheck
git add src/insights/equitySeries.ts src/insights/equitySeries.test.ts
git commit -m "web: equitySeries — stitchSeries helper + PerformanceEntry.fetchedAt"
```

---

### Task B2: `buildEquitySeries` stitches broker + snapshot tiers

**Files:**
- Modify: `web/src/insights/equitySeries.ts` (`buildEquitySeries` body, ~78–199)
- Test: `web/src/insights/equitySeries.test.ts`

Currently `buildEquitySeries` returns Tier-1 (broker) outright when any performance points exist, never reaching Tier-2/3. Change it to compute BOTH the broker series and the snapshot series, then return `stitchSeries(broker, snapshot)`.

- [ ] **Step 1: Write the failing test** — append to `web/src/insights/equitySeries.test.ts`. This locks the new stitch behaviour end-to-end (broker history + a newer local snapshot beyond the broker's last point):

```ts
describe('buildEquitySeries stitches broker history with newer snapshots', () => {
  const convert = (v: number) => v;
  const accounts = [{ id: 'a1', connectionId: 'c1', inceptionDate: null }];

  it('extends the broker curve with account snapshots past its last point', () => {
    const out = buildEquitySeries({
      performance: [{
        connectionId: 'c1',
        data: { totalEquity: [
          { date: '2024-01-01', value: 100 },
          { date: '2024-06-01', value: 120 },
        ], currency: 'USD' },
      }],
      snapshots: [
        { accountId: 'a1', date: '2024-06-01', value: 120, currency: 'USD' },
        { accountId: 'a1', date: '2024-07-01', value: 150, currency: 'USD' },
      ],
      holdingSnapshots: [],
      accounts,
      acctFilter: 'all',
      convert,
    });
    // broker points through 2024-06-01, then the 2024-07-01 snapshot tail.
    expect(out).toEqual([
      { date: '2024-01-01', value: 100 },
      { date: '2024-06-01', value: 120 },
      { date: '2024-07-01', value: 150 },
    ]);
  });
});
```

> The existing "performance wins" / Tier-2 / Tier-3 tests in this file must keep passing — when there are no snapshots beyond the broker's last date, `stitchSeries` returns the broker series unchanged, so those assertions hold. If a pre-existing test happens to include a snapshot dated AFTER its broker series (unlikely), update it to reflect the new—correct—stitched output and note it in the report.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- equitySeries.test.ts`
Expected: FAIL — current code returns broker-only `[100, 120]`, missing the `150` tail.

- [ ] **Step 3: Implement** — refactor `buildEquitySeries`. Keep all the scoping/inception logic. The change: don't `return` from Tier 1; instead build `brokerSeries`, then build `snapshotSeries` (Tier 2 if holding snaps exist, else Tier 3), then return the stitch.

Replace the three `return`-bearing tiers with computed locals. Concretely:

- Tier 1: replace `if (havePerformance) { return … }` with:
  ```ts
  const brokerSeries: SeriesPoint[] = havePerformance
    ? [...fromPerf.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, value]) => ({ date, value }))
    : [];
  ```
- Tier 2 + Tier 3: compute into a single `snapshotSeries` local instead of returning. Wrap the existing Tier-2 block so it assigns `snapshotSeries` when `out.length`, else falls to the Tier-3 block:
  ```ts
  let snapshotSeries: SeriesPoint[] = [];
  if (scopedHoldSnaps.length) {
    // ... existing Tier-2 forward-fill, producing `out` ...
    snapshotSeries = out;
  }
  if (!snapshotSeries.length) {
    // ... existing Tier-3 account-snapshot block, producing the byDate array ...
    snapshotSeries = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, value]) => ({ date, value }));
  }
  return stitchSeries(brokerSeries, snapshotSeries);
  ```

> Mechanical refactor — preserve every existing computation (the `fromPerf` map, `havePerformance`, the Tier-2 `bySym`/forward-fill, the Tier-3 `byDate` accumulation, all inception clipping). Only the control flow changes from early-returns to building two locals and stitching. Keep the bracket structure clean; the file stays one function.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- equitySeries.test.ts`
Expected: PASS — new stitch test + all pre-existing tier tests.

- [ ] **Step 5: Full web suite + typecheck + commit**

```bash
cd web && npm test && npm run typecheck
git add src/insights/equitySeries.ts src/insights/equitySeries.test.ts
git commit -m "web: equitySeries — stitch broker history with live snapshot tail instead of broker-wins"
```

---

### Task B3: Hide ROR/Dividend tiles for disabled connections

**Files:**
- Modify: `web/src/insights/InsightsView.tsx` (`BrokerageResp` interface; `BrokerageSubTab` fetch + the per-range derivation block)
- Test: `web/src/insights/InsightsView.test.tsx`

- [ ] **Step 1: Write the failing test** — add to `web/src/insights/InsightsView.test.tsx`, reusing the existing brokerage harness. Provide a `/brokerage` stub whose `performanceDisabled` marks the connection, with a `byRange` that WOULD otherwise render tiles, and assert the tiles are absent while the live tiles remain:

```ts
it('hides Rate-of-return + Dividend tiles when the connection performance is disabled', async () => {
  // /brokerage stub: performance entry for connectionId 'c1' with
  //   byRange: { '1Y': { rateOfReturn: 0.085, dividendIncome: 42, contributions: 0 } }
  //   plus performanceDisabled: { c1: '2026-05-30T10:00:00.000Z' }
  // account: { id:'acc1', connectionId:'c1', ... in scope ... }
  await screen.findByTestId('brokerage-stats');
  expect(screen.queryByText(/Rate of return/)).toBeNull();
  expect(screen.queryByText(/Dividends ·/)).toBeNull();
  // live, position-derived tiles still present:
  expect(screen.getByText('Portfolio value')).toBeInTheDocument();
});

it('still shows the tiles when performanceDisabled is empty', async () => {
  // same stub but performanceDisabled: {}
  await screen.findByTestId('brokerage-stats');
  expect(screen.getByText('Rate of return · 1Y')).toBeInTheDocument();
  expect(screen.getByText('Dividends · 1Y')).toBeInTheDocument();
});
```

> Reuse the exact `/brokerage` + `/accounts` stub shape the existing brokerage tests use; just add `performanceDisabled` to the brokerage response and make the account's `connectionId` line up with the performance entry. Default range pill is `1Y`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- InsightsView.test.tsx`
Expected: the first new test FAILS (tiles still render — disabled flag not consulted yet).

- [ ] **Step 3: Implement** — two edits in `web/src/insights/InsightsView.tsx`:

(a) Add the field to `BrokerageResp` (near `performance: PerformanceEntry[]`):

```ts
  performanceDisabled?: Record<string, string>;
```

The default-on-fetch-failure object in `BrokerageSubTab`'s `refresh` `catch` should include it for type-completeness:

```ts
      setData({
        holdings: [], snapshots: [], holdingSnapshots: [],
        performance: [], performanceDisabled: {}, ilsRates: null,
      });
```

(b) In the per-range derivation loop (the block computing `rateSum`/`rateCount`/`dividend`/`haveDividend` over `data.performance`), skip connections whose marker is set:

```ts
  const perfDisabled = data.performanceDisabled ?? {};
  for (const p of data.performance) {
    if (!scopedConnIds.has(p.connectionId)) continue;
    if (perfDisabled[p.connectionId]) continue; // frozen → its byRange is stale
    const w = p.data.byRange?.[range] ?? {
      rateOfReturn: p.data.rateOfReturn ?? null,
      dividendIncome: p.data.dividendIncome ?? null,
      contributions: null,
    };
    // ... unchanged accumulation ...
  }
```

When all in-scope connections are disabled, `rateCount` stays 0 → `rateOfReturn` null → its tile's `{rateOfReturn != null && …}` guard hides it; `haveDividend` stays false → its tile hides. No tile-JSX change needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- InsightsView.test.tsx`
Expected: PASS (both new tests + existing brokerage tests — the existing per-range-tile test uses `performanceDisabled` absent/empty, so its tiles still show).

- [ ] **Step 5: Full web suite + typecheck + commit**

```bash
cd web && npm test && npm run typecheck
git add src/insights/InsightsView.tsx src/insights/InsightsView.test.tsx
git commit -m "web: insights — hide ROR/dividend tiles for connections with disabled performance feed"
```

---

## PART C — Verify + wrap

### Task C1: Live visual verification (MANDATORY — PROJECT-RULES §2)

> A UI change is NOT done until chrome-devtools has loaded the live app and a screenshot confirms it. The user's IBKR connection is genuinely disabled, so this is real-data verifiable.

- [ ] **Step 1:** Restart the worktree engine so A1–A5 are live (the long-running `:4000` engine predates them). Run the worktree's engine from `<worktree>/sidecar` and a vite from `<worktree>/web` on a free port (e.g. `--port 5174 --strictPort`), per HANDOFF's worktree-vs-dev-server note. Don't disturb the user's `:5173`.
- [ ] **Step 2:** chrome-devtools: open `http://localhost:<port>/#token=<dev-token>` (token from `~/Library/Application Support/Hon/dev-token`). Trigger a SnapTrade sync (so the engine records the disabled marker), then Insights → Brokerage.
- [ ] **Step 3:** Screenshot + confirm:
  - the equity chart line extends to the most recent sync date (stitched — not frozen at the old broker cutoff),
  - the **Rate of return** and **Dividends** tiles are **gone** for the IBKR view,
  - Portfolio value / Gain·range / Unrealized P&L / Return on cost / Holdings still render,
  - flipping range pills still works; the chart + Gain tile update.
- [ ] **Step 4:** Confirm in `sidecar.log` that a second sync logs `dispatch … skipPerformance=true` and fires **no** `/performance/custom` calls (check the SnapTrade dashboard request logs, or the absence of `snaptrade performance … failed` lines). Read each screenshot back.

### Task C2: Full suites + HANDOFF + merge offer

- [ ] **Step 1:** Green baseline:
  ```bash
  cd <worktree>/sidecar && npm test && npm run typecheck
  cd <worktree>/web && npm test && npm run typecheck
  ```
- [ ] **Step 2:** Update `HANDOFF.md`: move the "graceful degrade" item from the SnapTrade-issues note to shipped; record that the engine now skips dead `/performance` + `/activities` calls (24h re-probe), the chart stitches, and the ROR/dividend tiles hide when disabled. Commit.
- [ ] **Step 3:** Show the user `git log --oneline main..HEAD` + `git diff main...HEAD --stat`; ask whether to merge `--no-ff`, PR, or leave on branch. **Do not push. Do not merge without explicit instruction.**

---

## Self-review notes

- **Spec coverage:** detection signal → A1; persistence (meta, no migration) → A2; report-disabled + skip opts → A3; runner skip/probe/persist → A4; serve flag → A5; client `fetchedAt` + stitch helper → B1; stitch wired into `buildEquitySeries` → B2; hide tiles → B3; visual verify + wrap → C1/C2. Non-goals (VT count, paid tier, inception) untouched. Activities skip is folded into A3/A4 via `skipActivities`.
- **Type consistency:** `isFeatureDisabled` (A1) used in A3. `getPerformanceDisabledAt`/`setPerformanceDisabled` (A2) used in A4/A5. `fetchPerformanceHistory` returns `{ data?, disabled }` (A3) consumed in A3's `runSnapTradeSync`. `ScrapeOutcome.performanceDisabled` (A3) read in A4. `/brokerage` `performanceDisabled: Record<string,string>` (A5) typed as `BrokerageResp.performanceDisabled?` (B3). `stitchSeries(broker, snapshot)` (B1) called in B2. `PerformanceEntry.fetchedAt?` (B1) — defined though only used opportunistically (the disabled flag, not fetchedAt, drives tile-hiding; `fetchedAt` is exposed for future use and type-correctness since it's on the wire).
- **No placeholders:** every code step shows real code. Test-harness reuse in B3 (existing `installFetchMock` brokerage stubs) is flagged to copy, not invent.
- **fetchedAt note:** the spec mentioned a 7-day `fetchedAt` heuristic in an earlier draft; the approved design uses the explicit engine `performanceDisabled` flag for tile-hiding, so `fetchedAt` is exposed (B1) but not the trigger. No threshold constant is needed client-side.
