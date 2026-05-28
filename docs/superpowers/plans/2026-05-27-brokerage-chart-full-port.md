# Brokerage Chart Full Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the thin React `ValueChart` with a full port of the legacy SPA's `lineChart()` — grid, glow, 3-stop gradient, tone color, draw-in animation, and an interactive hover crosshair + dot + tooltip — and reorder the pills + inception controls BELOW the chart to match legacy layout.

**Architecture:** A new self-contained `web/src/insights/LineChart.tsx` owns the SVG + the React-state hover overlay (crosshair / dot / tooltip), reusing the existing pure `smoothPath()`. `BrokerageSubTab` computes the period tone, renders `<LineChart>`, and re-orders so the layout reads tiles → chart → pills → inception → holdings. The legacy `.lc-*` CSS and `--chart-*` design tokens port verbatim into `web/src/styles.css`.

**Tech Stack:** React 19 (strict TS), Vite, Vitest + Testing Library (`fireEvent` for mouse/touch), SVG.

**Reference:**
- Legacy `lineChart()` — `sidecar/public/app.html:6551-6679`
- Legacy `chartHover`/`chartLeave` — `sidecar/public/app.html:6685-6740`
- Legacy `.lc-*` CSS — `sidecar/public/app.html:912-1012`
- Legacy `--chart-*` tokens — `sidecar/public/app.html:18-20` (dark), `32-34` (light)
- Spec — `docs/superpowers/specs/2026-05-27-brokerage-chart-full-port-design.md`

**Acceptance gate:** Side-by-side chrome-devtools screenshots vs. the legacy SPA at `http://127.0.0.1:4000`. NOT "tests pass". (Last attempt shipped green tests but a wrong-looking chart.)

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `web/src/insights/LineChart.tsx` | create | Full SVG chart + hover overlay (crosshair/dot/tooltip), tone color, draw-in |
| `web/src/insights/LineChart.test.tsx` | create | Unit tests for render + hover behaviour |
| `web/src/insights/InsightsView.tsx` | modify | Delete inline `ValueChart`; render `<LineChart>`; compute tone; reorder pills+inception below chart; legacy inception wording |
| `web/src/insights/InsightsView.test.tsx` | modify | Update assertions for new DOM order, tone, wording |
| `web/src/styles.css` | modify | Add `--chart-*` tokens + `.lc-*` rules; drop obsolete `.brokerage-chart` |

`web/src/insights/smooth.ts` is reused unchanged.

---

## Task 1: LineChart — static render (SVG, grid, 3 paths, tone, axis)

**Files:**
- Create: `web/src/insights/LineChart.tsx`
- Create: `web/src/insights/LineChart.test.tsx`

- [ ] **Step 1: Write the failing tests**

`web/src/insights/LineChart.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LineChart } from './LineChart';

const SERIES = [
  { date: '2026-01-01', value: 100 },
  { date: '2026-02-01', value: 120 },
  { date: '2026-03-01', value: 90 },
  { date: '2026-04-01', value: 150 },
];

describe('LineChart — static render', () => {
  it('renders an svg tagged for the brokerage chart', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    expect(screen.getByTestId('brokerage-chart')).toBeInTheDocument();
  });

  it('renders 4 horizontal grid lines', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    const svg = screen.getByTestId('brokerage-chart');
    expect(svg.querySelectorAll('line.lc-grid')).toHaveLength(4);
  });

  it('renders glow + area + line paths', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    const svg = screen.getByTestId('brokerage-chart');
    expect(svg.querySelector('path.lc-glow')).not.toBeNull();
    expect(svg.querySelector('path.lc-area')).not.toBeNull();
    expect(svg.querySelector('path.lc-line')).not.toBeNull();
  });

  it('the line path is a smooth (cubic) path', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    const d = screen.getByTestId('brokerage-chart')
      .querySelector('path.lc-line')!.getAttribute('d')!;
    expect(d).toContain(' C ');
  });

  it('applies the tone class on the wrapper', () => {
    const { rerender, container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    expect(container.querySelector('.lc-wrap.lc-good')).not.toBeNull();
    rerender(<LineChart series={SERIES} currency="USD" tone="bad" />);
    expect(container.querySelector('.lc-wrap.lc-bad')).not.toBeNull();
  });

  it('renders a start + end date axis by default', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    const axis = screen.getByTestId('brokerage-chart-axis');
    // Two spans: first + last date.
    expect(axis.children).toHaveLength(2);
  });

  it('omits the axis when showAxis is false', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" showAxis={false} />);
    expect(screen.queryByTestId('brokerage-chart-axis')).toBeNull();
  });

  it('renders a single moveto for a one-point series without crashing', () => {
    render(<LineChart series={[{ date: '2026-01-01', value: 100 }]} currency="USD" tone="good" />);
    expect(screen.getByTestId('brokerage-chart')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run --reporter=dot src/insights/LineChart.test.tsx`
Expected: FAIL — `LineChart` module not found.

- [ ] **Step 3: Implement the static parts of LineChart**

`web/src/insights/LineChart.tsx`:

```tsx
import { useId } from 'react';
import { money } from '../format';
import { smoothPath } from './smooth';

export interface SeriesPoint {
  date: string;
  value: number;
}

interface LineChartProps {
  series: SeriesPoint[];
  currency: string;
  tone: 'good' | 'bad';
  showAxis?: boolean;
}

// viewBox units; preserveAspectRatio="none" stretches to the CSS box.
const W = 1000;
const H = 240;
const PAD = 14;

/** Short axis date like the legacy fmtDate: "Jan 1". */
function fmtAxisDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Full port of the legacy SPA's lineChart() (sidecar/public/app.html).
 * Smooth equity curve with grid, glow, gradient fill, tone color and an
 * interactive hover crosshair + dot + tooltip. Hover wiring lands in a
 * follow-up step; this render covers the static SVG.
 */
export function LineChart({ series, currency, tone, showAxis = true }: LineChartProps) {
  const uid = useId().replace(/:/g, '');
  const max = series.reduce((m, p) => Math.max(m, p.value), -Infinity);
  const min = series.reduce((m, p) => Math.min(m, p.value), Infinity);
  const flat = max === min;
  const range = flat ? 1 : max - min;
  const n = series.length;
  const xAt = (i: number): number => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const yAt = (v: number): number =>
    flat ? H / 2 : H - PAD - ((v - min) / range) * (H - PAD * 2);

  const line = smoothPath(series.map((p, i) => ({ x: xAt(i), y: yAt(p.value) })));
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;

  // 4 faint horizontal grid bands.
  const grid = [1, 2, 3, 4].map((i) => (H / 5) * i);

  return (
    <div className={`lc-wrap lc-${tone}`}>
      <svg
        data-testid="brokerage-chart"
        className="lc-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
      >
        <defs>
          <filter id={`${uid}f`} x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="3.5" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.7" />
            </feComponentTransfer>
          </filter>
          <linearGradient id={`${uid}g`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
            <stop offset="55%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g>
          {grid.map((y) => (
            <line
              key={y}
              className="lc-grid"
              x1="0"
              x2={W}
              y1={y}
              y2={y}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        <path
          className="lc-glow"
          d={line}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#${uid}f)`}
          vectorEffect="non-scaling-stroke"
        />
        <path className="lc-area" d={area} fill={`url(#${uid}g)`} />
        <path
          className="lc-line"
          d={line}
          fill="none"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1000}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {showAxis && (
        <div className="lc-axis" data-testid="brokerage-chart-axis">
          <span>{fmtAxisDate(series[0]?.date ?? '')}</span>
          <span>{fmtAxisDate(series.at(-1)?.date ?? '')}</span>
        </div>
      )}
    </div>
  );
}
```

Note: `lc-glow`, `lc-line`, `lc-grid` strokes and the `currentColor` fill resolve from the `.lc-good` / `.lc-bad` color set in CSS (Task 3) — the wrapper sets `color`, children inherit it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run --reporter=dot src/insights/LineChart.test.tsx`
Expected: 8 passed.

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run typecheck`
Expected: clean. (`money` import is unused until Task 2 — if the strict build flags it, prefix with a Task-2 placeholder usage OR add the import in Task 2 instead. To avoid the unused-import error now, DON'T import `money` yet — add it in Task 2.)

Apply that note: remove the `import { money }` line from Step 3 if typecheck flags it as unused; it returns in Task 2.

- [ ] **Step 6: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon/.claude/worktrees/brokerage-chart-full-2026-05-27
git add web/src/insights/LineChart.tsx web/src/insights/LineChart.test.tsx
git commit -m "web: LineChart static render — grid, glow, gradient, tone, axis

Ports the visual half of the legacy SPA's lineChart(): 1000x240
viewBox, 4-band grid, blurred glow stroke, 3-stop area gradient,
2.6 line stroke with pathLength for draw-in, tone color via
.lc-good/.lc-bad wrapper. Hover overlay lands next."
```

---

## Task 2: LineChart — hover crosshair + dot + tooltip + touch

**Files:**
- Modify: `web/src/insights/LineChart.tsx`
- Modify: `web/src/insights/LineChart.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/insights/LineChart.test.tsx`:

```tsx
import { fireEvent } from '@testing-library/react';

describe('LineChart — hover', () => {
  // jsdom gives every element a 0x0 box; stub a real width so the
  // hover math (clientX → xPct → nearest index) has something to chew on.
  function stubBox(el: Element, width = 400, left = 0) {
    el.getBoundingClientRect = () => ({
      width, height: 200, left, top: 0, right: left + width, bottom: 200,
      x: left, y: 0, toJSON: () => ({}),
    });
  }

  it('shows crosshair + dot + tooltip on mouse move and hides on leave', () => {
    const { container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    // Move near the far right → last point (value 150).
    fireEvent.mouseMove(wrap, { clientX: 398 });
    expect(container.querySelector('.lc-cross.on')).not.toBeNull();
    expect(container.querySelector('.lc-dot.on')).not.toBeNull();
    const tip = container.querySelector('.lc-tip.on')!;
    expect(tip).not.toBeNull();
    expect(tip.querySelector('.lc-tip-val')!.textContent).toMatch(/150/);
    // Leave clears.
    fireEvent.mouseLeave(wrap);
    expect(container.querySelector('.lc-cross.on')).toBeNull();
    expect(container.querySelector('.lc-tip.on')).toBeNull();
  });

  it('tooltip shows the matching date and a "Since start" extra', () => {
    const { container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    fireEvent.mouseMove(wrap, { clientX: 398 });
    const tip = container.querySelector('.lc-tip')!;
    expect(tip.querySelector('.lc-tip-date')!.textContent).toMatch(/Apr/);
    // Since start: 150 vs first 100 → +50 / +50%.
    const extras = tip.querySelector('.lc-tip-extras')!;
    expect(extras.textContent).toMatch(/Since start/i);
    expect(extras.textContent).toMatch(/50/);
  });

  it('flips the tooltip to .right near the right edge and .left near the left', () => {
    const { container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    fireEvent.mouseMove(wrap, { clientX: 398 }); // ~99% → right
    expect(container.querySelector('.lc-tip.right')).not.toBeNull();
    fireEvent.mouseMove(wrap, { clientX: 2 });   // ~0% → left
    expect(container.querySelector('.lc-tip.left')).not.toBeNull();
  });

  it('responds to touchmove and clears on touchend', () => {
    const { container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    fireEvent.touchMove(wrap, { touches: [{ clientX: 398 }] });
    expect(container.querySelector('.lc-tip.on')).not.toBeNull();
    fireEvent.touchEnd(wrap);
    expect(container.querySelector('.lc-tip.on')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run --reporter=dot src/insights/LineChart.test.tsx`
Expected: the 4 new hover tests fail (no `.lc-cross`/`.lc-dot`/`.lc-tip` yet).

- [ ] **Step 3: Add hover state + overlay to LineChart**

In `web/src/insights/LineChart.tsx`:

1. Add the import back at the top (now used):

```tsx
import { useId, useState } from 'react';
import { money } from '../format';
import { smoothPath } from './smooth';
```

2. Inside `LineChart`, after the `xAt`/`yAt` definitions, add hover state + precomputed point percentages + the per-point "Since start" extra:

```tsx
  const [hover, setHover] = useState<number | null>(null);

  // Percentage positions for the overlay (crosshair/dot/tooltip live in
  // CSS % space, not SVG units).
  const pts = series.map((p, i) => ({
    xp: n > 1 ? (i / (n - 1)) * 100 : 50,
    yp: (yAt(p.value) / H) * 100,
  }));
  const firstValue = series[0]?.value ?? 0;

  const onMove = (clientX: number, currentTarget: HTMLElement): void => {
    const rect = currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const xPct = ((clientX - rect.left) / rect.width) * 100;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i]!.xp - xPct);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    setHover(bestI);
  };
```

3. Compute the active hover values just before `return`:

```tsx
  const hv = hover != null ? series[hover] : null;
  const hp = hover != null ? pts[hover] : null;
  let sinceStart: { text: string; tone: 'good' | 'bad' } | null = null;
  if (hv && n > 1 && firstValue) {
    const change = hv.value - firstValue;
    const pct = (change / Math.abs(firstValue)) * 100;
    const sign = change >= 0 ? '+' : '−';
    sinceStart = {
      text: `${sign}${money(Math.abs(change), currency)} · ${change >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
      tone: change >= 0 ? 'good' : 'bad',
    };
  }
  const tipSide = hp && hp.xp > 80 ? 'right' : hp && hp.xp < 20 ? 'left' : '';
```

4. Wire the handlers on `.lc-wrap` and add the overlay markup. Replace the opening `<div className={...}>` and the closing of the component with:

```tsx
  return (
    <div
      className={`lc-wrap lc-${tone}`}
      onMouseMove={(e) => onMove(e.clientX, e.currentTarget)}
      onMouseLeave={() => setHover(null)}
      onTouchMove={(e) => {
        const t = e.touches[0];
        if (t) onMove(t.clientX, e.currentTarget);
      }}
      onTouchEnd={() => setHover(null)}
    >
      <svg /* …unchanged… */>
        {/* …unchanged defs/grid/paths… */}
      </svg>

      <div
        className={`lc-cross${hp ? ' on' : ''}`}
        style={hp ? { left: `${hp.xp}%` } : undefined}
      />
      <div
        className={`lc-dot lc-${tone}${hp ? ' on' : ''}`}
        style={hp ? { left: `${hp.xp}%`, top: `${hp.yp}%` } : undefined}
      >
        <span className="lc-dot-pulse" />
      </div>
      <div
        className={`lc-tip lc-${tone}${hp ? ' on' : ''}${tipSide ? ' ' + tipSide : ''}`}
        style={hp ? { left: `${hp.xp}%` } : undefined}
      >
        <div className="lc-tip-val">{hv ? money(hv.value, currency) : ''}</div>
        <div className="lc-tip-date">{hv ? fmtAxisDate(hv.date) : ''}</div>
        <div className="lc-tip-extras">
          {sinceStart && (
            <div className="lc-tip-row">
              <span className="lc-tip-k">Since start</span>
              <span className={`lc-tip-v ${sinceStart.tone}`}>{sinceStart.text}</span>
            </div>
          )}
        </div>
      </div>

      {showAxis && (
        <div className="lc-axis" data-testid="brokerage-chart-axis">
          <span>{fmtAxisDate(series[0]?.date ?? '')}</span>
          <span>{fmtAxisDate(series.at(-1)?.date ?? '')}</span>
        </div>
      )}
    </div>
  );
```

(Keep the `<svg>…</svg>` body exactly as Task 1 wrote it — only the wrapper handlers + the overlay divs + axis are added/moved inside the new return.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run --reporter=dot src/insights/LineChart.test.tsx`
Expected: all (8 static + 4 hover) pass.

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/insights/LineChart.tsx web/src/insights/LineChart.test.tsx
git commit -m "web: LineChart hover — crosshair, dot, tooltip, touch

React-state hover: nearest-point lookup from cursor X, crosshair +
pulsing dot tracking the curve, tooltip with value + date + an auto
'Since start' delta row. Flips right/left near the edges. Mouse +
touch. Mirrors legacy chartHover/chartLeave."
```

---

## Task 3: Port `.lc-*` CSS + `--chart-*` tokens; drop obsolete `.brokerage-chart`

**Files:**
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add the `--chart-*` tokens**

The React `styles.css` has no chart color tokens. Find the `:root` (dark) block (around line 8, where `--bg`, `--card-hi` etc. live) and add to it:

```css
  --chart-up: #4fe39a; --chart-up-glow: rgba(79,227,154,0.45);
  --chart-down: #ff7a6a; --chart-down-glow: rgba(255,122,106,0.42);
  --chart-grid: rgba(250,243,229,0.06);
```

If there is a light-theme block (`[data-theme="light"]` or similar — search `--bg:` to find a second declaration), add the legacy light values there too:

```css
  --chart-up: #16a85c; --chart-up-glow: rgba(22,168,92,0.34);
  --chart-down: #d8473a; --chart-down-glow: rgba(216,71,58,0.34);
  --chart-grid: rgba(42,31,20,0.07);
```

If there is no light block, skip the light values (the app may be dark-only in React — confirm with `grep -n 'data-theme\|prefers-color-scheme\|--bg:' web/src/styles.css`).

- [ ] **Step 2: Replace the obsolete `.brokerage-chart` block with the `.lc-*` rules**

Find the existing block (around line 1056):

```css
.brokerage-chart {
  width: 100%; height: 200px; display: block;
  margin: 4px 0 6px;
}
.brk-chart-axis {
  display: flex; justify-content: space-between;
  font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--faint);
  margin-top: 4px;
}
```

Replace BOTH rules with the ported `.lc-*` set (the wrapper sets `color` so children's `currentColor` / `var(--chart-*)` resolve per tone):

```css
/* --- Line chart (SVG) — ported from legacy SPA lineChart() ------------- */
.lc-wrap { position: relative; width: 100%; height: 220px; cursor: crosshair;
  overflow: visible; margin: 4px 0 0; }
.lc-wrap.lc-good { color: var(--chart-up); }
.lc-wrap.lc-bad  { color: var(--chart-down); }
.lc-svg { display: block; width: 100%; height: 100%; overflow: visible;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 4%, #000 96%, transparent);
          mask-image: linear-gradient(to right, transparent, #000 4%, #000 96%, transparent); }
.lc-grid { stroke: var(--chart-grid); stroke-width: 1; }
.lc-glow { stroke: currentColor; opacity: 0; animation: lc-glow .35s .1s ease forwards; }
.lc-wrap.lc-good .lc-glow { stroke: var(--chart-up-glow); }
.lc-wrap.lc-bad  .lc-glow { stroke: var(--chart-down-glow); }
.lc-line { stroke: currentColor; stroke-dasharray: 1000; stroke-dashoffset: 1000;
  animation: lc-draw .55s cubic-bezier(.65,0,.25,1) .02s forwards; }
.lc-area { opacity: 0; transform: translateY(8%); transform-origin: bottom;
  animation: lc-fade .4s cubic-bezier(.4,0,.2,1) .1s forwards; }
@keyframes lc-draw { to { stroke-dashoffset: 0; } }
@keyframes lc-fade { to { opacity: 1; transform: translateY(0); } }
@keyframes lc-glow { to { opacity: .9; } }

.lc-cross { position: absolute; top: 0; bottom: 0; width: 1px;
  background: linear-gradient(to bottom, transparent, var(--hairline-2) 12%,
    var(--hairline-2) 88%, transparent);
  opacity: 0; pointer-events: none; transform: translateX(-0.5px);
  transition: opacity .15s ease, left .08s cubic-bezier(.2,.8,.2,1); }
.lc-cross.on { opacity: 1; }

.lc-dot { position: absolute; width: 14px; height: 14px; border-radius: 50%;
  border: 2.5px solid var(--card); opacity: 0; pointer-events: none;
  transform: translate(-50%, -50%);
  transition: opacity .18s ease,
              left .08s cubic-bezier(.2,.8,.2,1),
              top .08s cubic-bezier(.2,.8,.2,1); }
.lc-dot.lc-good { background: var(--chart-up); box-shadow: 0 0 0 4px var(--chart-up-glow); }
.lc-dot.lc-bad  { background: var(--chart-down); box-shadow: 0 0 0 4px var(--chart-down-glow); }
.lc-dot.on { opacity: 1; }
.lc-dot.on .lc-dot-pulse { animation: lc-pulse 1.8s ease-out infinite; }
.lc-dot-pulse { position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid currentColor; opacity: 0; pointer-events: none; }
.lc-dot.lc-good .lc-dot-pulse { color: var(--chart-up); }
.lc-dot.lc-bad  .lc-dot-pulse { color: var(--chart-down); }
@keyframes lc-pulse {
  0% { transform: scale(0.7); opacity: 0.65; }
  100% { transform: scale(2.6); opacity: 0; }
}

.lc-tip { position: absolute; top: 0; padding: 8px 12px 9px;
  background: var(--bg-elev); border: 1px solid var(--hairline-2);
  border-radius: 10px;
  transform: translate(-50%, -118%) scale(0.88);
  transform-origin: 50% calc(100% + 18px);
  box-shadow: 0 14px 28px rgba(0,0,0,0.38);
  opacity: 0; pointer-events: none; white-space: nowrap;
  transition: opacity .18s ease,
              transform .22s cubic-bezier(.2,1.1,.25,1),
              left .09s cubic-bezier(.2,.8,.2,1); }
.lc-tip::before { content: ""; position: absolute; left: 0; top: 7px;
  bottom: 7px; width: 3px; border-radius: 0 3px 3px 0; }
.lc-tip.lc-good::before { background: var(--chart-up); }
.lc-tip.lc-bad::before { background: var(--chart-down); }
.lc-tip.on { opacity: 1; transform: translate(-50%, -118%) scale(1); }
.lc-tip.right { transform: translate(-100%, -118%) scale(0.88);
  transform-origin: 100% calc(100% + 18px); }
.lc-tip.on.right { transform: translate(-100%, -118%) scale(1); }
.lc-tip.left { transform: translate(0, -118%) scale(0.88);
  transform-origin: 0 calc(100% + 18px); }
.lc-tip.on.left { transform: translate(0, -118%) scale(1); }
.lc-tip-val { font: 800 14.5px/1 ui-rounded, "SF Pro Rounded", system-ui;
  color: var(--text); font-variant-numeric: tabular-nums; padding-left: 8px; }
.lc-tip-date { font-size: 10.5px; color: var(--faint); margin-top: 4px;
  padding-left: 8px; }
.lc-tip-extras { margin-top: 7px; padding: 6px 0 0 8px;
  border-top: 1px solid var(--hairline); display: flex; flex-direction: column;
  gap: 4px; min-width: 130px; }
.lc-tip-extras:empty { display: none; }
.lc-tip-row { display: flex; justify-content: space-between; gap: 16px;
  font-size: 11px; }
.lc-tip-k { color: var(--faint); text-transform: uppercase; letter-spacing: .4px;
  font-weight: 600; }
.lc-tip-v { color: var(--text); font-weight: 700; font-variant-numeric: tabular-nums; }
.lc-tip-v.good { color: var(--chart-up); }
.lc-tip-v.bad { color: var(--chart-down); }
.lc-axis { display: flex; justify-content: space-between; margin-top: 10px;
  font-size: 10.5px; color: var(--faint); text-transform: uppercase;
  letter-spacing: .4px; }
@media (prefers-reduced-motion: reduce) {
  .lc-line, .lc-area, .lc-glow { animation: none; opacity: 1;
    stroke-dashoffset: 0; transform: none; }
  .lc-dot.on .lc-dot-pulse { animation: none; }
}
```

- [ ] **Step 3: Verify the tests still pass (CSS isn't exercised by unit tests, but the file must still build)**

Run: `cd web && npx vitest run --reporter=dot src/insights/LineChart.test.tsx`
Expected: still all green (CSS classnames already match what the component renders).

- [ ] **Step 4: Commit**

```bash
git add web/src/styles.css
git commit -m "web: port .lc-* chart CSS + --chart-* tokens from legacy SPA

Adds the green/red chart color tokens (dark + light), the line/area/
glow draw-in keyframes, the crosshair, the pulsing hover dot, and the
tooltip styling — all lifted verbatim from sidecar/public/app.html so
the React chart matches the legacy one. Replaces the old flat
.brokerage-chart rule."
```

---

## Task 4: Wire LineChart into BrokerageSubTab + reorder + tone + wording

**Files:**
- Modify: `web/src/insights/InsightsView.tsx`
- Modify: `web/src/insights/InsightsView.test.tsx`

- [ ] **Step 1: Write/Update the failing tests**

In `web/src/insights/InsightsView.test.tsx`, within the existing
`describe('InsightsView — brokerage account pills', …)` block (added by
the earlier polish commit), add:

```tsx
it('renders pills + inception BELOW the chart card in DOM order', async () => {
  installFetchMock(baseMocks);
  const user = userEvent.setup();
  await openBrokerage(user);
  const pane = document.querySelector('.brokerage-pane')!;
  const chartCard = pane.querySelector('.brk-chart-card')!;
  const pillRow = pane.querySelector('.brk-acct-row')!;
  expect(chartCard).not.toBeNull();
  expect(pillRow).not.toBeNull();
  // compareDocumentPosition: FOLLOWING (4) means pillRow comes after chartCard.
  expect(chartCard.compareDocumentPosition(pillRow) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy();
});

it('applies a tone class on the chart wrapper based on the period direction', async () => {
  installFetchMock(baseMocks);
  const user = userEvent.setup();
  await openBrokerage(user);
  // IBKR-only series rises 1500 → 2000 over the window → good (green).
  const group = await screen.findByRole('group', { name: /accounts/i });
  await user.click(within(group).getByRole('button', { name: /IBKR USD/ }));
  expect(document.querySelector('.lc-wrap.lc-good')).not.toBeNull();
});

it('uses the legacy inception wording when an account is focused', async () => {
  installFetchMock(baseMocks);
  const user = userEvent.setup();
  await openBrokerage(user);
  const group = await screen.findByRole('group', { name: /accounts/i });
  await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
  expect(screen.getByText(/since when "ALL" counts/i)).toBeInTheDocument();
});
```

(If `openBrokerage` / `baseMocks` are not in scope at that point, reuse
the exact helpers already defined in the describe block from the prior
commit — do not redefine them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: the 3 new tests fail (pills still above; no `.lc-wrap`; old wording).

- [ ] **Step 3: Replace ValueChart usage with LineChart + compute tone**

In `web/src/insights/InsightsView.tsx`:

1. Add the import near the other `./` imports:

```tsx
import { LineChart } from './LineChart';
```

2. Delete the entire inline `function ValueChart(...) { ... }` definition
(the old SVG component). Also delete the now-unused `SeriesPoint`
interface IF it is only used by ValueChart — but `BrokerageSubTab` uses
`SeriesPoint` for `fullSeries`/`series`, so KEEP the interface (or import
the one exported from `LineChart`). Simplest: keep the local
`interface SeriesPoint { date: string; value: number }` in InsightsView
as-is; `LineChart` has its own structurally-identical type.

3. Compute tone in `BrokerageSubTab`, right after `series` is derived
(after the `const series = fullSeries.filter(...)` line):

```tsx
const periodChange = (series.at(-1)?.value ?? 0) - (series[0]?.value ?? 0);
const chartTone: 'good' | 'bad' = periodChange >= 0 ? 'good' : 'bad';
```

4. In the JSX, find the chart card. Replace:

```tsx
<ValueChart series={series} currency={cur} />
<div className="brk-chart-axis">
  <span>{series[0]?.date ?? ''}</span>
  <span>{series.at(-1)?.date ?? ''}</span>
</div>
```

with:

```tsx
<LineChart series={series} currency={cur} tone={chartTone} />
```

(`LineChart` renders its own axis, so the old `.brk-chart-axis` div is
removed.)

- [ ] **Step 4: Reorder pills + inception below the chart card**

Still in `BrokerageSubTab`'s JSX: today the order is
`AccountPills` + inception block, THEN `<section className="ins-card brk-chart-card">`.
Move the `{brkAccounts.length > 0 && <AccountPills … />}` block and the
`{acctFilter === 'all' ? <InceptionBadge … /> : … <InceptionInput … />}`
block so they sit immediately AFTER the closing `</section>` of the
chart card and BEFORE the holdings `<section>`. Final order inside
`<div className="brokerage-pane">`:

```tsx
<div className="brk-stats" …>…</div>
<section className="ins-card brk-chart-card">… header … <LineChart …/></section>
{brkAccounts.length > 0 && <AccountPills accounts={brkAccounts} value={acctFilter} onChange={setAcctFilter} />}
{acctFilter === 'all'
  ? <InceptionBadge earliest={earliestInception} />
  : focusedAccount && <InceptionInput account={focusedAccount} onSaved={refresh} />}
{/* holdings section */}
```

- [ ] **Step 5: Update inception wording in `InceptionInput`**

In the `InceptionInput` component, change the visible label text from
`Investment start` to the legacy phrasing, and add the dual hint. Find:

```tsx
<label className="brk-inception-label">
  <span>Investment start</span>
  <input
    type="date"
    className="brk-inception-input"
    value={value}
    onChange={…}
  />
</label>
{value && (<button … aria-label="Clear inception date" …>×</button>)}
{value && (<span className="brk-inception-hint">Synthetic backfill before this date is hidden.</span>)}
```

Replace with:

```tsx
<label className="brk-inception-label">
  <span>Investment start (since when "ALL" counts):</span>
  <input
    type="date"
    className="brk-inception-input"
    aria-label="Investment start"
    value={value}
    onChange={…}  /* keep the existing handler body unchanged */
  />
</label>
{value && (
  <button
    type="button"
    className="brk-inception-clear"
    aria-label="Clear inception date"
    onClick={…}  /* keep existing */
  >×</button>
)}
<span className="brk-inception-hint">
  {value
    ? 'Synthetic backfill before this date is hidden.'
    : 'Until set, the chart shows whatever the price source returns (Yahoo: up to 10 years).'}
</span>
```

Note: the `aria-label="Investment start"` keeps the existing test
selector `getByLabelText(/investment start/i)` working even though the
visible `<span>` text changed. The new test (`since when "ALL" counts`)
asserts the visible span.

- [ ] **Step 5b: Migrate the `<circle>`-counting assertions**

The older brokerage tests (and the partial-port ones) assert on
per-point `<circle>` elements — e.g. `chart.querySelectorAll('circle')`
expecting a count equal to the number of snapshots. `LineChart` has NO
per-point circles (legacy didn't either; only the single hover dot,
which lives outside the SVG as a `<div>`). Those assertions WILL fail.

Find them: `cd web && grep -n "querySelectorAll('circle')\|circle')" src/insights/InsightsView.test.tsx`

For each, replace the circle-count assertion with an equivalent that
doesn't depend on per-point markers. Two safe substitutes:

- "chart renders" → assert `screen.getByTestId('brokerage-chart')` is
  present (already the pattern elsewhere).
- "range pill narrows the series" / "inception cutoff drops points" →
  the series length is no longer observable via circles. Assert on the
  axis end-date instead, which still reflects the visible window:
  `screen.getByTestId('brokerage-chart-axis')` and check its first/last
  span text. For the inception-cutoff test, assert the start-axis date
  is on/after the inception date (e.g. `expect(axis.firstChild!.textContent)`
  matches the post-cutoff month). If a precise count is needed, expose it
  via a `data-points={series.length}` attribute on the `.lc-wrap` in
  `LineChart` and assert that instead — add the attribute if you take
  this route, and note it here.

Pick the axis-date approach where possible (no production code change);
use `data-points` only if a test genuinely needs the exact count.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: all green, including the 3 new ones and the migrated
circle-count tests.

If `getByLabelText(/investment start/i)` now matches two nodes (the
`<span>` text AND the input's `aria-label`), the earlier test using it
may break. Fix by making the existing test query the input via
`getByLabelText('Investment start')` exact OR by role
`getByRole('textbox')` won't work for `type=date` — prefer keeping the
input's `aria-label="Investment start"` and changing the visible span
to NOT contain the standalone phrase "Investment start" … but legacy
wording IS "Investment start (since when…)". To avoid the clash:
**assert the visible label via `getByText(/since when "ALL" counts/i)`
(already done) and keep input lookups on the exact `aria-label`.** If a
prior test does `getByLabelText(/investment start/i)` and now gets two
matches, switch that prior test to `getByLabelText('Investment start')`
(exact string, matches only the aria-label, not the longer span).

- [ ] **Step 7: Typecheck**

Run: `cd web && npm run typecheck`
Expected: clean. (Watch for an unused `SeriesPoint` or leftover
`ValueChart` reference — remove any dangling import/usage.)

- [ ] **Step 8: Commit**

```bash
git add web/src/insights/InsightsView.tsx web/src/insights/InsightsView.test.tsx
git commit -m "web: wire LineChart into Brokerage; reorder + legacy wording

Brokerage pane now reads tiles -> chart -> pills -> inception ->
holdings, matching the legacy SPA. Chart tone (green/red) is derived
from the visible range's net change. Inception input uses the legacy
copy: 'Investment start (since when \"ALL\" counts):' plus the
until-set hint. The thin inline ValueChart is gone."
```

---

## Task 5: Full suite + typecheck (both packages)

**Files:** none (verification task).

- [ ] **Step 1: Web suite**

Run: `cd web && npm test -- --run --reporter=dot`
Expected: all green. Baseline before this work was ~352; this adds 12
LineChart tests + 3 InsightsView tests and removes any ValueChart-only
assertions, so expect ~365 ± a few.

- [ ] **Step 2: Web typecheck**

Run: `cd web && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Sidecar suite + typecheck (unchanged, sanity only)**

Run: `cd ../sidecar && npm test -- --run --reporter=dot && npm run typecheck`
Expected: 55 passing, clean. (No sidecar files touched.)

- [ ] **Step 4: Commit (only if anything was tidied)**

If steps 1-3 surfaced a small fix, commit it:

```bash
git add -A && git commit -m "web: tidy after LineChart port (test/typecheck fixes)"
```

Otherwise skip.

---

## Task 6: Side-by-side verification vs. legacy SPA (the acceptance gate)

**Files:** `HANDOFF.md` (doc update at the end).

- [ ] **Step 1: Merge to main**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon
git log --oneline main..session/brokerage-chart-full-2026-05-27
git diff main...session/brokerage-chart-full-2026-05-27 --stat
```

Show the user; after explicit go-ahead:

```bash
git merge --no-ff session/brokerage-chart-full-2026-05-27 \
  -m "Merge branch 'session/brokerage-chart-full-2026-05-27' — brokerage chart full port"
```

- [ ] **Step 2: Confirm vite is serving from main**

```bash
ps aux | grep -i 'node.*vite' | grep -v grep
# Cross-check the cwd:
lsof -p "$(pgrep -f 'node.*vite' | head -1)" | grep cwd
```

If vite's cwd is NOT `/Users/shaharsolomons/Documents/Code/Hon/web`, a
parallel session owns it. Either ask the user to restart vite from main,
or `pkill -f 'node.*vite'` then `cd web && npm run dev` from main.
(This bit the last attempt — verify BEFORE screenshotting.)

- [ ] **Step 3: Load React Brokerage (chrome-devtools MCP)**

- `navigate_page` page 1 → `http://localhost:5173/#token=<token>` reload ignoreCache.
- Click Insights tab → Brokerage sub-tab.
- `evaluate_script` to confirm: `.lc-wrap` present, `.lc-line` `d` contains ` C `, `.lc-grid` count is 4, `.brk-acct-row` is AFTER `.brk-chart-card` in DOM.

- [ ] **Step 4: Hover-test the React chart**

`evaluate_script` dispatching a `mousemove` over `.lc-wrap` at a known
offset, then read back `.lc-tip.on` text. Confirm the tooltip shows a
value + date + Since-start row. Screenshot mid-hover to
`/tmp/hon-brk-react-hover.png` and Read it.

- [ ] **Step 5: Load legacy SPA + same view**

- `navigate_page` page 2 → `http://127.0.0.1:4000/#token=<token>` (engine
  must be up; if down, `cd Hon && npm run dev` or start the engine).
- Navigate to its Insights → Brokerage.
- Screenshot to `/tmp/hon-brk-legacy.png`. Read it.

- [ ] **Step 6: Compare**

Put the two screenshots side by side. Confirm, on the same data + range:
- Pills + inception BELOW the chart on both.
- Same stroke color (both green or both red).
- Grid visible on both; glow under the line on both; gradient fill depth similar.
- Hover tooltip shape/feel matches.
- Axis dates under both.

If any visible mismatch, fix in the worktree and re-merge (or commit
straight to main only with user go-ahead) and re-verify. Do NOT mark
done until the screenshots agree.

- [ ] **Step 7: Update HANDOFF.md**

Add a bullet under the evening polish section noting the full port
superseded the partial `214e11c` chart, with the new commit range, and
that it was side-by-side verified against the legacy SPA.

```bash
git add HANDOFF.md
git commit -m "docs: HANDOFF — brokerage chart full port verified vs legacy"
```

- [ ] **Step 8: Report to the user**

Summarize: commit range, what changed, the two screenshot paths, and
the side-by-side result. Wait for the user to push (no-auto-push rule).

---

## Risks & notes

- **jsdom hover math:** `getBoundingClientRect()` returns a zero box in
  jsdom; the hover tests stub it. The component guards `rect.width === 0`
  so a real-but-unstubbed environment never divides by zero.
- **`currentColor` inheritance:** the SVG line/glow use `stroke:
  currentColor` (or the glow token) and the wrapper sets `color` per
  tone. If a stroke renders black in the browser, the wrapper's `color`
  isn't cascading into the SVG — check the `.lc-wrap.lc-good { color }`
  rule landed.
- **Light theme:** only port the light `--chart-*` values if the React
  app actually has a light theme block. If it's dark-only, the dark
  tokens suffice.
- **`useId` colons:** React's `useId()` returns ids with `:` which are
  invalid in SVG `id`/`url(#…)` on some engines — the component strips
  them (`.replace(/:/g, '')`). Keep that.
- **Animation in tests:** the draw-in + pulse are CSS-only; jsdom
  doesn't run them, so no test flake. Don't assert on animation.
- **Don't reintroduce dots-per-point:** legacy has no per-point circles
  (only the single hover dot). The partial port's `<circle>` markers are
  gone with `ValueChart` — do not add them back.
```
