# Brokerage chart polish — design

**Date:** 2026-05-27
**Scope:** Insights tab → Brokerage sub-tab → "Value over time" card
**Approach:** Polished port of the legacy SPA's brokerage chart UX, per
the brainstorming session on 2026-05-27.

---

## Goal

The React Brokerage panel ships the value chart as a polyline with no
per-account filter and no inception-date control. The legacy SPA at
`sidecar/public/app.html` has all three. The polish closes the gap:

1. **Per-account filter pills** above the chart, always rendered (even
   with one brokerage account), with `All accounts` as the default.
2. **Inception-date input** that lets the user pin "this is when my
   investment actually started" so the chart's `ALL` range stops
   painting SnapTrade's synthetic backfill from years before the
   account existed. Visible only when a specific account is focused;
   the `All accounts` view shows a read-only badge with the earliest
   inception date.
3. **Smooth cubic-bezier curve** in `ValueChart` (currently a
   `M…L…L…` polyline), using the legacy Catmull-Rom-like algorithm
   with `tension: 0.18`.

The engine side is already in place: `PATCH /accounts/:id/inception`
with `{ inceptionDate: 'YYYY-MM-DD' | null }`, `accounts.inceptionDate`
column, and `/brokerage` returning per-account snapshots. No schema
changes.

## Non-goals

- No editable "global" inception for the `All accounts` view —
  Approach 1 from the brainstorm (avoids silently overwriting per-
  account customisation).
- No tooltip rework. The chart currently has no hover tooltip; the
  legacy SPA has one but porting it is out of scope for this polish.
- No new endpoints. Everything uses existing routes.

## Components

All three new pieces live in `web/src/insights/` so they're co-located
with `InsightsView.tsx`. Each is declared at module level (not nested
inside `BrokerageSubTab`) to avoid `rerender-no-inline-components` per
Vercel React best practices.

### `BrokerageSubTab` (existing — modified)

- New state: `acctFilter: 'all' | string` (default `'all'`).
- Fetches `/accounts` in parallel with `/brokerage` inside the existing
  `useEffect` (no waterfall).
- New `useMemo` over `[data, accounts, acctFilter]` that builds
  `dailyTotals → fullSeries`. When `acctFilter !== 'all'`, the memo
  filters `data.snapshots` to that account AND drops snapshots before
  `account.inceptionDate` if set.
- Renders `<AccountPills>` + `<InceptionInput>` above `<ValueChart>`.

### `AccountPills` (new, module-level)

Pure presentational. Props:
```ts
interface AccountPillsProps {
  accounts: Account[];   // pre-filtered by the parent
  value: 'all' | string;
  onChange: (next: 'all' | string) => void;
}
```
Renders an `<All accounts>` pill plus one pill per account in the
prop. Always shown, even with one account. Parent (`BrokerageSubTab`)
computes the relevant subset by intersecting `/accounts` with the set
of `accountId`s present in `data.snapshots` (which only contains
brokerage snapshots — that's the engine's invariant). This keeps
`AccountPills` purely presentational and the "what counts as a
brokerage account" definition in one place. Markup mirrors the
existing `.seg` group used for the range pills so the visual language
matches.

### `InceptionInput` (new, module-level)

Visible only when `acctFilter !== 'all'`. Props:
```ts
interface InceptionInputProps {
  account: BrokerageAccount;
  onSaved: () => void | Promise<void>;   // triggers refresh()
}
```
- Renders an `<input type="date">` bound to `account.inceptionDate ?? ''`
  plus a clear (`×`) button (rendered only when a date is set).
- On change: `await api('/accounts/' + id + '/inception', 'PATCH',
  { inceptionDate: value || null })`, then `onSaved()`.
- Hint text below: *"Synthetic backfill before this date is hidden."*
  Mirrors legacy wording exactly.
- When `acctFilter === 'all'`, the parent renders a sibling badge
  *"Since YYYY-MM-DD (earliest)"* instead — read-only, derived from
  `min(accounts.inceptionDate ?? firstSnapshotDate per account)`. No
  edit affordance, so per-account customisation can't be silently
  overwritten.

### `ValueChart` (existing — modified)

Single change: replace the `M…L…L…` polyline build with
`smoothPath(pts)` from the new `web/src/insights/smooth.ts`. The dots
(`<circle>` per data point) stay anchored to the same `(x, y)` —
they're the curve's destinations, so axes and (future) tooltips still
line up. Dots are hidden when `series.length > 24` so a dense ALL-range
view doesn't get speckled.

## Data flow

```
useEffect (mount):
  parallel:
    /brokerage  →  data
    /accounts   →  accounts
  setData, setAccounts

useMemo on [data, accounts, acctFilter]:
  scoped snapshots = acctFilter === 'all'
    ? data.snapshots
    : data.snapshots
        .filter(s => s.accountId === acctFilter)
        .filter(s => !cutoff || s.date >= cutoff)
  dailyTotals = sum by date (converted to cur)
  fullSeries  = [...sorted]
  return { fullSeries, … }

InceptionInput onChange/clear:
  PATCH /accounts/:id/inception { inceptionDate: value || null }
  refresh() → re-fetches /brokerage + /accounts
```

`refresh()` is a `useCallback` that re-runs the parallel fetch and
updates both pieces of state. Component re-renders; the memo re-runs;
the chart redraws against the new cutoff.

## Smoothing math (`web/src/insights/smooth.ts`)

Pure function, deterministic, no React dependency:

```ts
export interface Pt { x: number; y: number; }

export function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  const T = 0.18;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) * T;
    const c1y = p1.y + (p2.y - p0.y) * T;
    const c2x = p2.x - (p3.x - p1.x) * T;
    const c2y = p2.y - (p3.y - p1.y) * T;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}
```

`T = 0.18` matches the legacy SPA's tension; lower values are tighter,
higher values overshoot. Outputs the same path SVG renders directly.

## Testing

### `web/src/insights/smooth.test.ts` (new)

- Empty array → `''`.
- Single point → `M x y` only (no `C` segments).
- Two points → exactly one `C` segment connecting them.
- Hand-checked C-control values for a known 4-point series at
  `T=0.18`.
- Monotonically increasing series → resulting path stays within
  `[min - ε, max + ε]` where `ε < 5%` of range (proves no extreme
  overshoot from the smoothing).

### `web/src/insights/InsightsView.test.tsx` (extended)

- "renders an `All accounts` pill plus one pill per brokerage account
  with snapshots".
- "selecting an account filters the chart's series and stat boxes".
- "inception input is hidden under `All accounts`; the earliest
  read-only badge renders instead".
- "selecting an account reveals the inception input pre-filled with
  the account's `inceptionDate`".
- "editing the inception PATCHes `/accounts/:id/inception` with the
  new date and refetches `/brokerage` + `/accounts`".
- "clearing the inception PATCHes with `{ inceptionDate: null }`".

No existing test should break. Baseline: 337 passing → ~343 after this
work.

## React best-practice checks

- **Components at module level**, never inline (prevents
  `rerender-no-inline-components` regressions when a parent re-renders).
- **Derivations in `useMemo`** keyed on the inputs they actually
  consume, not the whole `data` blob.
- **No `useEffect` for derived state** — derived series + stats are
  pure `useMemo` outputs from props/state.
- **Pure math lives outside React** so tests don't need DOM or
  Testing Library setup just to verify the curve.
- **No `useDeferredValue` needed** — snapshot counts are bounded
  (months × accounts) and pill switching is sub-frame.

## Verification (per `PROJECT-RULES.md §2`)

Before claiming done:

1. `cd web && npm test` → all green (~343 tests).
2. `cd web && npm run typecheck` → clean.
3. `cd sidecar && npm test` + typecheck → unchanged baselines.
4. Merge worktree branch into `main`.
5. Reload http://localhost:5173 via `chrome-devtools` MCP.
6. Navigate to Insights → Brokerage.
7. Screenshot showing the pills row, the smooth bezier curve, and
   (after selecting the IBKR pill) the inception input.
8. Side-by-side compare with the legacy SPA at `http://127.0.0.1:4000`
   for visual parity on pills + inception input.

Tests passing alone is NOT enough — last session burned a "done" claim
on tests-pass without devtools verification. Screenshot before
shipping.

## File touch list

- `web/src/insights/InsightsView.tsx` — modified (BrokerageSubTab +
  ValueChart).
- `web/src/insights/smooth.ts` — new.
- `web/src/insights/smooth.test.ts` — new.
- `web/src/insights/InsightsView.test.tsx` — extended.
- `web/src/styles.css` — new rules for `.brk-acct-row`,
  `.brk-acct-pill`, `.brk-inception-row`, `.brk-inception-input`,
  `.brk-inception-hint`, `.brk-inception-badge`.

No engine, no DB migrations, no other tabs touched.
