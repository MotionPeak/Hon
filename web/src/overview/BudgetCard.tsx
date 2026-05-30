import { money } from '../format';
import { currentCycleKey, cycleLabel } from '../cycle';
import type { Category } from '../settings/CategoriesPanel';
import { projectVariable, type VariableInput, type ProjectedVariable } from './projectedVariable';

export interface BudgetLine {
  category: string;
  budget: number | null;
  spent: number;
}

const DEFAULT_COLOR = '#8C8FA8';
const DEFAULT_EMOJI = '🏷️';

interface BudgetCardProps {
  variable: VariableInput;
  essentials: BudgetLine[];
  categories: Category[];
  /** Merchant-rollup `expectedFixedThisCycle`; null when projection is off. */
  predictedFixed: number | null;
  /** This cycle's total ILS spend — the donut total, so the two reconcile. */
  totalSpent: number;
  currency: string;
  monthStartDay: number;
}

/**
 * The "Budget · <month>" card: the variable / discretionary allowance up top,
 * the essentials breakdown below, and the cycle's total spend at the foot.
 * Mirrors the legacy SPA's `budgetSection` (essentials folded into the same
 * card rather than living in a separate one).
 */
export function BudgetCard({
  variable, essentials, categories, predictedFixed, totalSpent, currency, monthStartDay,
}: BudgetCardProps) {
  const essentialBudgetTotal = essentials.reduce((s, l) => s + (l.budget ?? 0), 0);
  const v = projectVariable(variable, essentialBudgetTotal, predictedFixed);
  const monthLabel = cycleLabel(currentCycleKey(monthStartDay));

  const styleByName = new Map<string, Category>();
  for (const c of categories) styleByName.set(c.name, c);

  // Over-budget first, then biggest spenders — the same sort legacy uses.
  const sortedEssentials = essentials.slice().sort((a, b) => {
    const ra = a.budget ? a.spent / a.budget : -1;
    const rb = b.budget ? b.spent / b.budget : -1;
    return rb - ra || b.spent - a.spent;
  });

  return (
    <section className="card budget-card" data-testid="budget-card">
      <div className="card-head"><h3>Budget · {monthLabel}</h3></div>
      <VariableAllowance v={v} currency={currency} />
      {sortedEssentials.length > 0 && (
        <>
          <div className="bgt-group">Essentials</div>
          {sortedEssentials.map((l) => (
            <EssentialLine
              key={l.category}
              line={l}
              currency={currency}
              style={styleByName.get(l.category)}
            />
          ))}
        </>
      )}
      <div className="bgt-tot">
        <span>Spent this month</span>
        <span>{money(totalSpent, currency)}</span>
      </div>
    </section>
  );
}

function VariableAllowance({ v, currency }: { v: ProjectedVariable; currency: string }) {
  const pool = v.disposable > 0 ? v.disposable : 0;
  const pct = pool > 0 ? Math.max(0, Math.min(100, (v.allowed / pool) * 100)) : 0;

  let cls = '';
  let fillColor = 'var(--green)';
  let cap: string;
  if (!v.income && !v.committed && !v.spent) {
    cap = 'No income or spending recorded this month yet.';
    fillColor = 'var(--hairline-2)';
  } else if (v.disposable <= 0) {
    cls = 'none';
    fillColor = 'var(--red)';
    cap = "You're spending more than you're bringing in — there's no room "
      + 'for variable spending this month.';
  } else if (v.allowed <= 0) {
    cls = 'none';
    fillColor = 'var(--red)';
    cap = "This month's discretionary room is used up — anything more eats "
      + 'into money meant for fixed bills and essentials.';
  } else {
    cls = pct <= 20 ? 'low' : 'ok';
    fillColor = pct <= 20 ? 'var(--amber)' : 'var(--green)';
    cap = 'Free to spend on shopping, entertainment, travel and the like.';
  }

  const Row = ({ k, val, tone }: { k: string; val: string; tone?: 'out' }) => (
    <div className="bgt-var-row">
      <span className="k">{k}</span>
      <span className={`v${tone ? ' ' + tone : ''}`}>{val}</span>
    </div>
  );

  return (
    <>
      <div className="bgt-group">Variable spending · allowed right now</div>
      <div className={`bgt-var ${cls}`}>
        <div className="bgt-var-top">
          <span className="bgt-var-amt">{money(v.allowed > 0 ? v.allowed : 0, currency)}</span>
          <span className="bgt-var-unit">left to spend</span>
        </div>
        <div className="bgt-var-cap">{cap}</div>
        <div className="bgt-var-track">
          <div className="bgt-var-fill" style={{ width: `${pct}%`, background: fillColor }} />
        </div>
        <div className="bgt-var-rows">
          <Row k={v.projected ? 'Expected income' : 'Money in'} val={money(v.income, currency)} />
          <Row
            k={v.projected ? 'Expected fixed + essentials' : 'Fixed + essential spend'}
            val={`− ${money(v.committed, currency)}`}
            tone="out"
          />
          {v.savings > 0 && (
            <Row k="Savings (this month)" val={`− ${money(v.savings, currency)}`} tone="out" />
          )}
          {v.piggy > 0 && (
            <Row k="Piggy banks" val={`− ${money(v.piggy, currency)}`} tone="out" />
          )}
          <Row k="Variable spent" val={`− ${money(v.spent, currency)}`} tone="out" />
        </div>
        {v.projected && (
          <div className="bgt-var-note">
            Projected — fixed bills reserved every cycle and income averaged over
            recent months. Turn off in Settings.
          </div>
        )}
      </div>
    </>
  );
}

function EssentialLine({
  line, currency, style,
}: {
  line: BudgetLine;
  currency: string;
  style: Category | undefined;
}) {
  const emoji = style?.emoji || DEFAULT_EMOJI;
  const color = style?.color || DEFAULT_COLOR;
  const budget = line.budget ?? 0;
  const ratio = budget ? line.spent / budget : null;
  const pct = ratio == null ? 100 : Math.min(100, ratio * 100);
  const over = ratio != null && ratio > 1;
  const barColor = ratio == null
    ? color
    : over ? 'var(--red)' : ratio > 0.85 ? 'var(--amber)' : 'var(--green)';

  let foot: React.ReactNode = null;
  if (ratio != null) {
    const left = budget - line.spent;
    const footCls = over ? 'over' : ratio > 0.85 ? 'warn' : 'ok';
    const txt = over ? `${money(-left, currency)} over` : `${money(left, currency)} left`;
    foot = (
      <div className="bgt-foot">
        <span className="bgt-pct">{Math.round(ratio * 100)}% used</span>
        <span className={`bgt-left ${footCls}`}>{txt}</span>
      </div>
    );
  }

  return (
    <div className="bgt-line">
      <div className="bgt-head">
        <span className="bgt-emoji">{emoji}</span>
        <span className="bgt-cat">{line.category}</span>
        {budget ? (
          <span className="bgt-amt">
            {money(line.spent, currency)}{' '}
            <span className="bgt-cap">/ {money(budget, currency)}</span>
          </span>
        ) : (
          <span className="bgt-nolimit">{money(line.spent, currency)} · no limit set</span>
        )}
      </div>
      <div className="bgt-track">
        <div
          className={`bgt-fill${over ? ' over' : ''}`}
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>
      {foot}
    </div>
  );
}
