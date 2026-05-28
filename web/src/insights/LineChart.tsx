import { useId, useState } from 'react';
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
 * interactive hover crosshair + dot + tooltip.
 */
export function LineChart({ series, currency, tone, showAxis = true }: LineChartProps) {
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

  // A stored hover index can outlive the series it indexed into: when the
  // parent swaps in a shorter series (account/range switch), `hover` may now
  // point past the new array. Treat any out-of-range index as "no hover"
  // during render rather than relying on the consumers' falsy guards — keeps
  // the overlay state self-consistent without a setState-in-render.
  const activeIndex = hover != null && hover < series.length ? hover : null;
  const hv = activeIndex != null ? series[activeIndex] : null;
  const hp = activeIndex != null ? pts[activeIndex] : null;
  let sinceStart: { text: string; tone: 'good' | 'bad' } | null = null;
  if (hv && n > 1 && firstValue) {
    const change = hv.value - firstValue;
    const pct = (change / Math.abs(firstValue)) * 100;
    // U+2212 for the minus so both the money and percent share one glyph;
    // pct.toFixed() on a negative would otherwise emit an ASCII '-'.
    const sign = change >= 0 ? '+' : '−';
    sinceStart = {
      text: `${sign}${money(Math.abs(change), currency)} · ${sign}${Math.abs(pct).toFixed(2)}%`,
      tone: change >= 0 ? 'good' : 'bad',
    };
  }
  const tipSide = hp && hp.xp > 80 ? 'right' : hp && hp.xp < 20 ? 'left' : '';

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
}
