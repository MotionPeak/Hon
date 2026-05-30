# Brokerage Insights — graceful degradation when SnapTrade revokes endpoints

**Date:** 2026-05-30
**Branch:** `session/brokerage-degrade-2026-05-30`

## Problem

SnapTrade downgraded the user's "Personal" plan and revoked two endpoints
(confirmed live in the SnapTrade dashboard request logs, 2026-05-30):

- `GET /api/v1/performance/custom` → **403**, body
  `{ "detail": "Feature is not enabled for this customer or this connection", "code": "1141" }`.
  This powers `fetchPerformanceHistory` in `sidecar/src/snaptrade.ts` — the
  broker-reported `totalEquity` timeline AND the per-range stats (`byRange`:
  rate of return, dividends, contributions).
- `GET /api/v1/activities` → **410 Gone**. Powers
  `fetchEarliestActivityDate` (auto inception-date detection).

`/accounts` and `/accounts/:id/positions` still return 200, so holdings +
balances keep syncing fine.

**Symptoms today:**

1. **Frozen chart presented as live.** `saveBrokeragePerformance` only
   overwrites stored performance when a fetch *succeeds*, so the last-good
   `brokerage_performance` row (with its old `fetched_at`) persists forever.
   In `web/src/insights/equitySeries.ts`, `buildEquitySeries` Tier 1
   (broker `totalEquity`) **wins outright whenever any performance points
   exist** — so the frozen curve shadows the fresh Tier-2 (holding
   snapshots) and Tier-3 (account snapshots) that Hon keeps building on
   every sync. The chart line silently stops moving.
2. **Window-relative stats are now wrong, not just old.** The
   "Rate of return · {range}" and "Dividends · {range}" tiles in
   `InsightsView`'s `BrokerageSubTab` read `byRange[range]` from the frozen
   performance entry. A "ROR · 1Y" computed weeks ago no longer describes the
   trailing 1Y window — it's misleading.
3. **Ongoing waste.** Every sync fires 5× `/performance/custom` (403) +
   1× `/activities` (410) — burning SnapTrade rate limit and spamming the log,
   with no mechanism to stop because nothing remembers the feature is off.

## Goal

Make Hon honest and resilient when SnapTrade revokes these endpoints, without
losing the legitimately-collected historical curve:

- **Chart:** keep the broker's historical curve up to its last real point,
  then continue live from Hon's own snapshots (stitch).
- **Tiles:** hide ROR/Dividend when broker performance is known-disabled.
- **Engine:** detect the disabled state from the `1141` code (ground truth,
  not a time heuristic), persist it per-connection, stop calling the dead
  endpoints (re-probe ≤ once/day so it auto-recovers), and surface the flag.

## Non-goals / explicitly out of scope

- **The VT 22-vs-23 count.** Confirmed a SnapTrade-side feed/settlement lag on
  a recent buy (SnapTrade's own `/positions` returns 22). Self-heals on
  SnapTrade's next IBKR poll. Nothing to fix in Hon. (Noted in HANDOFF.)
- **A paid SnapTrade tier / dropping SnapTrade for IBKR Flex.** Separate
  product decision.
- **Activities/inception beyond skipping the dead call.** Auto inception-date
  detection stays broken (endpoint gone); the user's manual "investment start"
  date already covers it. We only stop hammering the 410.

---

## Design

### Detection signal — code 1141 (engine, ground truth)

`snapErrorBody(err)` in `sidecar/src/snaptrade.ts` already parses the SDK
error into `{ detail?, code? }`. Add a predicate mirroring the existing
`isOneUserLimit`:

```ts
/** True when SnapTrade reports the reporting/performance feature is not
 *  enabled for this plan/connection (403, code 1141). */
function isFeatureDisabled(err: unknown): boolean {
  const body = snapErrorBody(err);
  return body?.code === '1141'
    || /feature is not enabled/i.test(body?.detail ?? '');
}
```

`fetchRangeReport` currently catches all errors and returns `null` (logging
the message), so the disabled signal is lost. It will instead distinguish the
disabled case so `fetchPerformanceHistory` can act on it.

### Persisting the disabled state (engine, no migration)

Use the existing `meta` key/value table (`repo.getMeta` / `repo.setMeta`). Two
thin repo helpers keep the key format in one place:

```ts
// repo.ts
private perfDisabledKey(connectionId: string) {
  return `snaptrade:perf-disabled:${connectionId}`;
}
/** ISO timestamp when performance was last seen disabled, or null. */
getPerformanceDisabledAt(connectionId: string): string | null {
  return this.getMeta(this.perfDisabledKey(connectionId)) ?? null;
}
setPerformanceDisabled(connectionId: string, when: string | null): void {
  if (when === null) this.deleteMeta(this.perfDisabledKey(connectionId));
  else this.setMeta(this.perfDisabledKey(connectionId), when);
}
```

(`deleteMeta` is a one-line addition if it doesn't exist:
`DELETE FROM meta WHERE key = ?`.)

### Skip-with-probe — runner owns persistence, snaptrade.ts stays the SDK layer

Keep meta I/O out of `snaptrade.ts` (it has no repo today and shouldn't grow
one). The **runner** owns the read/decide/persist; `snaptrade.ts` just reports
what it saw. Concretely:

**`ScrapeOutcome` (scrapers.ts)** gains an optional channel parallel to the
existing `brokeragePerformance?`:
```ts
performanceDisabled?: boolean;   // true if every perf range returned 1141
```

**`runSnapTradeSync` signature** gains an options arg:
```ts
runSnapTradeSync(creds, vault, opts?: { skipPerformance?: boolean }, onProgress?)
```
- When `opts.skipPerformance` is true, it does NOT call
  `fetchPerformanceHistory` at all (no dead `/performance/custom` calls), and
  leaves `brokeragePerformance` undefined.
- Otherwise it calls `fetchPerformanceHistory`, which now returns
  `{ data?: BrokeragePerformanceData; disabled: boolean }` — `disabled` true
  when every range threw `isFeatureDisabled`. `runSnapTradeSync` maps that to
  `outcome.performanceDisabled` and `outcome.brokeragePerformance`.

**The runner** (`runner.ts`, the `isSnapTrade` branch) does the rest:
1. **Before:** `const disabledAt = repo.getPerformanceDisabledAt(connId)`.
   `skipPerformance = disabledAt != null && (now − disabledAt) < PERF_REPROBE_MS`
   (`PERF_REPROBE_MS = 24h`). Stale/unset → don't skip (probe).
2. **After:** if `outcome.performanceDisabled` →
   `repo.setPerformanceDisabled(connId, nowIso)`. Else if
   `outcome.brokeragePerformance` (a real success) →
   `repo.setPerformanceDisabled(connId, null)` (clear) before the existing
   `saveBrokeragePerformance`. A skipped fetch leaves the marker as-is.

`now` is injected (the runner already constructs run-scoped state; pass an ISO
string / Date into the helper rather than calling `Date.now()` inline) so the
skip-window logic is unit-testable.

**The `/activities` 410** is secondary (smaller waste, and inception
auto-detect is a non-goal). Apply the *same* skip-with-probe shape using a
sibling marker `snaptrade:activities-disabled:<connId>`:
`fetchEarliestActivityDate` reports a `disabled` signal on 410; the runner
gates the per-account activities call behind a `skipActivities` flag and
persists the marker the same way. Include for symmetry; if it complicates the
per-account loop, it may be split to its own task.

### Serving the flag (engine)

`GET /brokerage` returns `repo.listBrokeragePerformance()` (already carries
`fetchedAt` per entry). Add a sibling map so the client knows which
connections are disabled:

```ts
// server.ts GET /brokerage response gains:
performanceDisabled: Object.fromEntries(
  repo.listConnections()
    .map((c) => [c.id, repo.getPerformanceDisabledAt(c.id)])
    .filter(([, v]) => v != null),
), // { [connectionId]: ISO-string }
```

### Client — widen the type + read fetchedAt/flag

`web/src/insights/equitySeries.ts`:

```ts
export interface PerformanceEntry {
  connectionId: string;
  fetchedAt?: string;           // NEW — already on the wire, now typed
  data: { /* unchanged */ };
}
```

`web/src/insights/InsightsView.tsx` `BrokerageResp` gains
`performanceDisabled?: Record<string, string>` and `BrokerageSubTab` reads it.

### Client — stitch the chart (always-on, the core fix)

Replace Tier-1-wins-outright in `buildEquitySeries` with a **merge**:

- Build the broker-performance series as today (Tier 1), capturing its **last
  date** `lastPerfDate`.
- Build the snapshot-derived series (the existing Tier-2 holding-snapshot
  logic, else Tier-3 account snapshots).
- **Stitch:** broker points for `date <= lastPerfDate`, then snapshot points
  for `date > lastPerfDate`. When there's no broker performance, fall straight
  through to the snapshot tiers (today's behaviour). When there are no
  snapshots past `lastPerfDate`, the result equals today's broker-only series.

This is unconditional — it makes the chart both deep and live regardless of
*why* the broker feed stopped (disabled, transient, or just a day behind), so
it doesn't depend on the disabled flag at all. The flag only drives tile
hiding.

Extract the stitch as an exported pure helper
`stitchSeries(broker: SeriesPoint[], snapshot: SeriesPoint[]): SeriesPoint[]`
in `equitySeries.ts` so it's unit-testable in isolation (broker points where
`date <= lastBrokerDate`, then snapshot points where `date > lastBrokerDate`;
broker-empty → snapshot as-is; snapshot-empty → broker as-is). `buildEquitySeries`
computes the broker (Tier-1) series and the snapshot (Tier-2-else-Tier-3)
series, then returns `stitchSeries(brokerSeries, snapshotSeries)`. Inception
clipping is unchanged — it already applies per tier before stitching.

**Behaviour-preservation note:** today, when broker performance exists,
Tier-2/3 are never reached. After this change they ARE computed (to supply the
post-cutoff tail). The snapshot tiers must therefore stay correct on their own;
the existing Tier-2/3 tests already lock that, and the no-broker path returns
the snapshot series unchanged (regression-covered).

### Client — hide ROR/Dividend tiles when disabled

In `BrokerageSubTab`'s per-range derivation, a connection's `byRange` is
considered usable only when `performanceDisabled[connectionId]` is absent.
When the in-scope connections are all disabled, `rateOfReturn` resolves to
null and `haveDividend` stays false → the existing conditional tiles
(`{rateOfReturn != null && …}`, `{haveDividend && …}`) already hide
themselves. So the change is: **skip disabled connections when accumulating
`rateSum`/`dividend`.** The Portfolio value / Gain·range / Unrealized P&L /
Return-on-cost / Holdings tiles are computed from live positions and the
stitched series — they stay.

(The "Gain · {range}" tile derives from the stitched equity series'
first-vs-last, so it remains correct and live.)

---

## Files

**Engine**
- `sidecar/src/scrapers.ts` — `ScrapeOutcome.performanceDisabled?: boolean`.
- `sidecar/src/snaptrade.ts` — `isFeatureDisabled` predicate;
  `fetchPerformanceHistory` returns `{ data?, disabled }`;
  `runSnapTradeSync` gains `opts.skipPerformance` (and `skipActivities`),
  maps the disabled signal onto the outcome. No repo/meta access here.
- `sidecar/src/runner.ts` — the `isSnapTrade` branch reads
  `getPerformanceDisabledAt`, decides skip vs probe (`PERF_REPROBE_MS`),
  passes the skip flags in, and persists the marker (set on disabled / clear
  on success) using an injected `now`.
- `sidecar/src/repo.ts` — `getPerformanceDisabledAt` / `setPerformanceDisabled`
  (+ activities sibling), `deleteMeta` if missing.
- `sidecar/src/server.ts` — `GET /brokerage` includes `performanceDisabled`
  (`{ [connectionId]: ISO }`).

**Client**
- `web/src/insights/equitySeries.ts` — `PerformanceEntry.fetchedAt`; stitch
  logic (Tier-1 merge with snapshot tiers); optional `stitchSeries` helper.
- `web/src/insights/InsightsView.tsx` — `BrokerageResp.performanceDisabled`;
  skip disabled connections in the ROR/dividend accumulation.

## Tests

**Engine (sidecar)**
- `isFeatureDisabled`: true for `{code:'1141'}` and for the detail-string
  match; false otherwise.
- `fetchPerformanceHistory` (with a mocked SnapTrade client): all-ranges-1141
  → sets the disabled marker, returns undefined; a successful range → clears
  the marker. Skip-when-fresh: a disabled marker < 24h old → no SDK calls;
  > 24h → probes.
- repo `getPerformanceDisabledAt`/`setPerformanceDisabled` round-trip +
  clear-on-null.

**Client (web)**
- `buildEquitySeries` / `stitchSeries`: broker series + later snapshots →
  stitched (broker ≤ lastPerfDate, snapshots after); no snapshots-after →
  broker-only; no broker → snapshot tiers (regression for existing behaviour);
  inception clip still applied.
- `InsightsView` brokerage tab: with `performanceDisabled` set for the IBKR
  connection, the ROR + Dividend tiles are absent while Portfolio/Gain/
  Unrealized/Return-on-cost/Holdings remain; the chart still renders a line
  that extends to the latest snapshot date (stitched).

## Visual verification (PROJECT-RULES §2 — mandatory)

Against the real engine + the user's live data (where the IBKR connection is
genuinely disabled): confirm in chrome-devtools that
- the equity chart line extends to the most recent sync (not frozen at the old
  broker cutoff),
- the Rate-of-return and Dividends tiles are gone for the IBKR view,
- Portfolio/Gain·range/Unrealized/Return-on-cost/Holdings still render,
- a healthy connection (if any) is unaffected.
Screenshot before any "done" claim.

## Workflow

Worktree `session/brokerage-degrade-2026-05-30`, TDD per task, atomic commits,
both suites + typechecks green, visual verification for the UI half, no push
without explicit go-ahead.
