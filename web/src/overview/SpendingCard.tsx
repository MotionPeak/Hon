import { useState } from 'react';
import { money, moneyShort } from '../format';
import type { PieCat } from './spend';
import { buildSlices } from './pieGeometry';

/** CSS custom properties live on the slice style for the hover-lift transform
 *  (`--mx` / `--my`); the standard CSSProperties type rejects `--*` keys. */
type CSSVars = React.CSSProperties & Record<`--${string}`, string | number>;

const SIZE = 240;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_OUTER = 104;
const R_INNER = 68;
const PUSH_PX = 9;

interface SpendingCardProps {
  cats: PieCat[];
  total: number;
  /** % spend vs last cycle, for the "↓ N% vs last month" pill; null hides it. */
  changePct: number | null;
}

/**
 * "This month" card: total ILS spend, a month-over-month trend pill, and a
 * donut of where the money went with a per-category legend. Hovering a slice
 * or legend row swaps the donut centre from the total to that category. Mirrors
 * the legacy SPA's `spendingCard` + `spendPie`.
 */
export function SpendingCard({ cats, total, changePct }: SpendingCardProps) {
  const [hovered, setHovered] = useState<PieCat | null>(null);

  let badge: React.ReactNode = null;
  if (changePct != null) {
    const down = changePct < 0;
    badge = (
      <span className={`delta ${down ? 'good' : 'bad'}`}>
        {down ? '↓ ' : '↑ '}{Math.abs(changePct).toFixed(0)}% vs last month
      </span>
    );
  }

  return (
    <section className="card spending-card" data-testid="spending-card">
      <div className="card-head"><h3>This month</h3></div>
      <div className="spend-top">
        <div className="spend-num">{money(total, 'ILS')}</div>
        {badge}
      </div>
      {total <= 0 ? (
        <div className="empty">No spending recorded this month.</div>
      ) : (
        <SpendPie cats={cats} total={total} hovered={hovered} setHovered={setHovered} />
      )}
    </section>
  );
}

function SpendPie({
  cats, total, hovered, setHovered,
}: {
  cats: PieCat[];
  total: number;
  hovered: PieCat | null;
  setHovered: (c: PieCat | null) => void;
}) {
  const slices = buildSlices(cats, CX, CY, R_OUTER, R_INNER, PUSH_PX);
  const centreAmt = hovered ? moneyShort(hovered.amount, 'ILS') : moneyShort(total, 'ILS');
  const centreLbl = hovered ? hovered.category : 'spent';
  const hov = hovered ? ' hov' : '';

  return (
    <>
      <div className="pie-wrap">
        <svg className="pie pie-svg" viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <g className="pie-slices">
            {slices.map((s, i) => {
              const cat = cats[i];
              const style: CSSVars = {
                '--mx': `${s.mx}px`,
                '--my': `${s.my}px`,
                animationDelay: `${Math.min(i, 14) * 70}ms`,
              };
              return (
                <path
                  key={s.category}
                  className="pie-slice"
                  d={s.d}
                  fill={cat.color}
                  style={style}
                  onMouseEnter={() => setHovered(cat)}
                  onMouseLeave={() => setHovered(null)}
                />
              );
            })}
          </g>
          <text
            className={`pie-c-amt${hov}`}
            x={CX} y={CY - 4}
            textAnchor="middle" dominantBaseline="middle"
          >{centreAmt}</text>
          <text
            className={`pie-c-lbl${hov}`}
            x={CX} y={CY + 18}
            textAnchor="middle" dominantBaseline="middle"
          >{centreLbl}</text>
        </svg>
      </div>
      <div className="legend">
        {cats.map((c) => {
          let trend: React.ReactNode = null;
          if (c.changePct != null && Math.abs(c.changePct) >= 1) {
            const down = c.changePct < 0;
            trend = (
              <span className={`lg-tr ${down ? 'good' : 'bad'}`}>
                {down ? '↓' : '↑'}{Math.abs(c.changePct).toFixed(0)}%
              </span>
            );
          }
          return (
            <div
              key={c.category}
              className="lg-row"
              onMouseEnter={() => setHovered(c)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className="lg-dot" style={{ background: c.color }} />
              <span className="lg-name">{c.category}</span>
              {trend}
              <span className="lg-amt">{money(c.amount, 'ILS')}</span>
              <span className="lg-pct">{Math.round((c.amount / total) * 100)}%</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
