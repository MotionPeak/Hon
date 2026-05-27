# Brokerage chart full-port — design

**Date:** 2026-05-27 (evening, after partial port shipped + user feedback)
**Scope:** React Insights → Brokerage sub-tab → "Value over time" card
**Approach:** Full port of `sidecar/public/app.html`'s `lineChart()` plus
the surrounding layout. Earlier polish commit (`214e11c`) shipped
structural pieces but skipped the rich chart + got the layout order
wrong. This re-port matches legacy 1:1 visually and interactively.

---

## Goal

When you put the React Brokerage tab and the legacy SPA side-by-side
on the same data, they should look the same and behave the same — same
hover tooltip with crosshair, same green/red tone color based on the
period delta, same grid + glow + draw-in animation, same axis under
the chart, same pills + inception placement.

## What's wrong with what shipped (`214e11c`)

| # | Legacy | Shipped | Severity |
|---|---|---|---|
| 1 | Order: tiles → chart card → pills row → inception row → holdings | Pills + inception ABOVE chart | High |
| 2 | Hover crosshair + animated dot + rich tooltip (value + date + Since-start ±X ±Y%) | Static SVG with native browser `<title>` only | High |
| 3 | Date axis (start/end) directly under chart | Has `.brk-chart-axis` but visually buried inside the card | Medium |
| 4 | Tone color: green when range up, red when down (`--chart-up/down`) | Static amber `--accent` | Medium |
| 5 | Soft glow under stroke (wider blurred copy via `feGaussianBlur`) | None | Medium |
| 6 | Faint 4-line horizontal grid | None | Medium |
| 7 | 3-stop area gradient (0.55 → 0.18 → 0) | 2-stop (0.28 → 0) — too faint | Medium |
| 8 | Animated draw-in via `pathLength="1000"` + stroke-dash keyframe | None | Low |
| 9 | Larger viewBox 1000×240, stroke 2.6 | 600×180, stroke 2 | Medium |
| 10 | Touch support (`touchmove`/`touchend`) | None | Low |
| 11 | Inception label: "Investment start (since when 'ALL' counts):" | "Investment start" only | Low |
| 12 | "All accounts" only shown when 2+ pills (legacy hides single-pill row) | Always shown; an "All accounts" badge appears under it | Style choice — keep mine |

## What stays from the partial port

- `smoothPath()` in `web/src/insights/smooth.ts` — math is correct,
  matches legacy tension 0.18, tests pass. Reused as-is.
- `BrokerageSubTab` fetches `/accounts` in parallel with `/brokerage`,
  intersects with snapshot account IDs. That data flow stays.
- `AccountPills` + `InceptionInput` + `InceptionBadge` components
  exist; we just move them and lift wording.

## New component: `LineChart`

A self-contained `web/src/insights/LineChart.tsx` replaces
`ValueChart`. Props:

```ts
interface LineChartProps {
  series: { date: string; value: number }[];
  currency: string;
  /** Tone is decided by the parent from period delta. */
  tone: 'good' | 'bad';
  /** Show start + end date axis under the chart. Default true. */
  showAxis?: boolean;
}
```

Internals:

- SVG `viewBox="0 0 1000 240"`, `preserveAspectRatio="none"`. Height
  driven by CSS (default 220px via `.lc-wrap`).
- `<defs>`: per-instance `<filter>` with `feGaussianBlur` (glow),
  `<linearGradient>` with 3 stops (0.55 → 0.18 → 0).
- 4 horizontal grid lines via `<line>` with
  `vector-effect="non-scaling-stroke"`.
- 3 stacked `<path>` for line: glow (wide, blurred), area (gradient
  fill), line (sharp stroke 2.6 with `pathLength="1000"` for
  draw-in animation).
- Per-point invisible markers? **No** — same as legacy, which
  computes hover position from mouse X. We reproduce that.

### Hover crosshair + dot + tooltip

React state in `LineChart`:

```ts
const [hover, setHover] = useState<null | {
  i: number;       // index into series
  xPct: number;    // 0..100 — for crosshair + dot positioning
  yPct: number;    // 0..100
}>(null);
```

`onMouseMove` (and `onTouchMove`) on the `.lc-wrap` div:
- read `getBoundingClientRect()`
- compute `xPct = (clientX - rect.left) / rect.width * 100`
- find nearest series index by `xPct → i`
- set `hover = { i, xPct, yPct: yAt(series[i].value)/240*100 }`

`onMouseLeave` / `onTouchEnd` → `setHover(null)`.

Rendered overlay (inside `.lc-wrap`, layered on top of the SVG):

- `<div className="lc-cross" style={{ left: xPct + '%' }} />` — 1px
  vertical line from top to bottom of the chart.
- `<div className="lc-dot lc-{tone}" style={{ left: xPct + '%', top: yPct + '%' }}>`
  with `<span className="lc-dot-pulse" />` (pulsing ring).
- `<div className="lc-tip lc-{tone}" style={{ left: xPct + '%', top: yPct + '%' }}>`:
  - `<div className="lc-tip-val">{money(value, currency)}</div>`
  - `<div className="lc-tip-date">{fmtDate(date)}</div>`
  - `<div className="lc-tip-extras">` — auto "Since start" extra
    (computed in `LineChart` from `series[0].value`):
    `+₪X · +Y%` (green) or `−₪X · −Y%` (red).

Tooltip flips left/right to stay in bounds (small `useLayoutEffect`
that measures the tip and adjusts a `translateX(-100%)` when `xPct > 75`
or so).

### Tone color

Computed by `BrokerageSubTab` from the visible range:

```ts
const periodChange = (series.at(-1)?.value ?? 0) - (series[0]?.value ?? 0);
const tone: 'good' | 'bad' = periodChange >= 0 ? 'good' : 'bad';
```

Passed down to `<LineChart tone={tone} />`. The chart's stroke + glow
+ tooltip border + dot color all bind to `var(--chart-up)` /
`var(--chart-down)` via the `.lc-good` / `.lc-bad` modifier classes.

### Animated draw-in

`<path className="lc-line" pathLength={1000} style={{
  strokeDasharray: 1000,
  strokeDashoffset: drawIn ? 0 : 1000,
}} />` with a `useEffect` that flips `drawIn` to true after mount
(next frame). CSS transition handles the rest.

Respect `prefers-reduced-motion: reduce` — skip the animation.

## Layout reorder

`BrokerageSubTab` JSX changes to mirror legacy
`return tiles + trendCard + acctFilterRow + inceptionRow + holdingsPanel`:

```tsx
<div className="brokerage-pane">
  <div className="brk-stats">...</div>      {/* tiles */}
  <section className="ins-card brk-chart-card">
    <header className="brk-chart-head">
      Value over time + trend pill + range pills + cur toggle
    </header>
    <LineChart series={series} currency={cur} tone={tone} />
  </section>
  <AccountPills .../>                       {/* BELOW chart */}
  {acctFilter === 'all'
    ? <InceptionBadge earliest={earliestInception} />
    : <InceptionInput account={focusedAccount} onSaved={refresh} />}
  <section>Holdings</section>
</div>
```

(The "earliest" badge stays as a Hon-side touch — legacy doesn't have
it but it's a nice read-only affordance under All.)

## CSS additions / changes

Most of the legacy `.lc-*` styles port to `web/src/styles.css`:

```css
.lc-wrap { position: relative; width: 100%; }
.lc-svg { display: block; width: 100%; height: 100%; }
.lc-svg .lc-line { /* draw-in transition */ }
.lc-good .lc-line { stroke: var(--chart-up); }
.lc-bad  .lc-line { stroke: var(--chart-down); }
.lc-cross { position: absolute; top: 0; bottom: 0; width: 1px;
  background: var(--chart-grid); pointer-events: none; }
.lc-dot { position: absolute; width: 12px; height: 12px;
  border-radius: 50%; transform: translate(-50%, -50%);
  pointer-events: none; }
.lc-good .lc-dot { background: var(--chart-up); }
.lc-bad  .lc-dot { background: var(--chart-down); }
.lc-dot-pulse { /* pulsing ring */ }
.lc-tip { position: absolute; transform: translate(-50%, calc(-100% - 14px));
  pointer-events: none;
  background: var(--card-hi); border: 1px solid var(--hairline);
  border-radius: 8px; padding: 6px 10px; min-width: 140px;
  white-space: nowrap; ... }
.lc-axis { display: flex; justify-content: space-between;
  font-size: 11px; color: var(--muted); margin-top: 4px; }
@keyframes lc-draw { from { stroke-dashoffset: 1000; }
                     to   { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .lc-line { animation: none !important; }
}
```

CSS vars `--chart-up`, `--chart-down`, `--chart-grid`, `--chart-up-glow`,
`--chart-down-glow` are already defined in legacy CSS — verify they
exist in `web/src/styles.css`; if not, port them. (Legacy line ~916
area.)

## Inception input wording

Match legacy: "Investment start (since when 'ALL' counts):"
Plus the dual hint legacy uses:
- When date set: "Synthetic backfill before this date is hidden."
- When unset: "Until set, the chart shows whatever the price source
  returns (Yahoo: up to 10 years)."

## Testing

`web/src/insights/LineChart.test.tsx` (new):

1. Renders an `<svg>` with grid lines (4 `<line>` under `<g>`).
2. Renders 3 stacked `<path>` (glow, area, line).
3. With `tone="good"` adds `lc-good` class; `tone="bad"` adds `lc-bad`.
4. Hover at a known x-position shows the crosshair `<div>` at the
   expected left%.
5. Hover renders a tooltip with the matching value + date + Since-start
   row.
6. `onMouseLeave` clears the hover (tooltip + crosshair go away).
7. `prefers-reduced-motion: reduce` (mocked via matchMedia) skips the
   draw-in animation.
8. Touch event (`touchmove`/`touchend`) shows + clears the tooltip.

`InsightsView.test.tsx` updates:

- Pills assertions stay (now find them BELOW the chart in DOM order).
- Inception input label assertion updates to match legacy wording.
- New test: tone class toggles based on series direction.
- Tests that asserted "chart renders" use `getByRole('img')` or
  `[data-testid="brokerage-chart"]` — the testid stays on the
  inner SVG.

## Verification (the only acceptance gate)

`PROJECT-RULES.md §2`. After merge into main:

1. `chrome-devtools__navigate_page` to React → Insights → Brokerage.
2. `chrome-devtools__navigate_page` (page 2) to
   `http://127.0.0.1:4000/#token=...` → Insights → Brokerage.
3. Screenshot both. Side by side, on the same data, with the same
   range selected:
   - Pills row + inception below the chart on both — same order.
   - Chart stroke same color (both green or both red).
   - Grid lines visible on both.
   - Glow under stroke on both.
   - Hover the React chart — crosshair + dot + tooltip appear.
   - Hover the legacy chart — same.
   - Resize viewport — both reflow the same way.
4. If anything visibly different, iterate. Do not claim done from
   "tests pass" alone — that's what burned the last attempt.

## File touch list

| File | Action |
|---|---|
| `web/src/insights/LineChart.tsx` | create — full SVG + hover logic |
| `web/src/insights/LineChart.test.tsx` | create |
| `web/src/insights/InsightsView.tsx` | modify — drop the inline `ValueChart`, replace with `<LineChart>`, reorder pills + inception, compute tone |
| `web/src/insights/InsightsView.test.tsx` | modify — update assertions for new order + tone + wording |
| `web/src/styles.css` | modify — add `.lc-*` rules, ensure `--chart-up/down/grid` vars exist; drop obsolete `.brokerage-chart` rules that ValueChart used |
| `docs/superpowers/specs/...` | this doc |
| `docs/superpowers/plans/...` | TDD plan from writing-plans |

The existing `ValueChart` function in `InsightsView.tsx` is deleted
(replaced by `LineChart`). `smoothPath` keeps its current home.

## Non-goals

- No engine changes.
- No DB changes.
- No fundamentally new chart features beyond what legacy has.
- Tone color thresholds (e.g., "flat" range) — match legacy: any
  non-negative period delta is "good".
