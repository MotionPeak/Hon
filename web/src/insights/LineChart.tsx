import { useId } from 'react';
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
// `currency` is part of the stable prop contract but only consumed once the
// hover tooltip lands in Task 2; alias it so TS strict doesn't flag it unused.
export function LineChart({ series, currency: _currency, tone, showAxis = true }: LineChartProps) {
  const uid = useId().replace(/:/g, '');
  const n = series.length;
  // Guard the empty series: reduce() over [] yields ±Infinity, which would
  // poison range/yAt and emit a malformed area path (no opening moveto).
  const max = n ? series.reduce((m, p) => Math.max(m, p.value), -Infinity) : 0;
  const min = n ? series.reduce((m, p) => Math.min(m, p.value), Infinity) : 0;
  const flat = max === min;
  const range = flat ? 1 : max - min;
  const xAt = (i: number): number => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const yAt = (v: number): number =>
    flat ? H / 2 : H - PAD - ((v - min) / range) * (H - PAD * 2);

  const line = smoothPath(series.map((p, i) => ({ x: xAt(i), y: yAt(p.value) })));
  // Only close the fill region when there's a line to anchor it to; an empty
  // series leaves both paths blank rather than a stray " L … Z" fragment.
  const area = line ? `${line} L ${W} ${H} L 0 ${H} Z` : '';

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
