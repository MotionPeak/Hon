import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { money } from '../format';
import { currentCycleKey } from '../cycle';
import type { Category } from '../settings/CategoriesPanel';
import { essentialReserve, type VariableInput } from './projectedVariable';
import type { BudgetLine } from './BudgetCard';

interface BudgetEditorModalProps {
  /** Current essential lines (category → budget/spent) to seed the inputs. */
  essentials: BudgetLine[];
  /** All categories — the essential group becomes the editable rows. */
  categories: Category[];
  variable: VariableInput;
  predictedFixed: number | null;
  currency: string;
  monthStartDay: number;
  onClose: () => void;
  /** Called after a successful save so the Overview refetches /budget. */
  onSaved: () => void;
}

const SYMBOLS: Record<string, string> = { ILS: '₪', USD: '$', EUR: '€', GBP: '£' };
const DEFAULT_COLOR = '#8C8FA8';
const DEFAULT_EMOJI = '🏷️';

interface EditRow {
  category: string;
  emoji: string;
  color: string;
  spent: number;
  /** Current budget as a string ('' = no limit). */
  value: string;
  initial: string;
}

/**
 * Set per-category essential limits, a manual income override, and this
 * cycle's savings reserve — the React port of the legacy SPA's `budgetModal`.
 * Persists via PUT /budgets (one call per changed category), PUT
 * /budget/income-override, and PUT /budget/savings, then calls `onSaved` so
 * the Overview refetches. The savings reserve is capped live at whatever the
 * income leaves once fixed, essentials, piggies and variable spend are out.
 */
export function BudgetEditorModal({
  essentials, categories, variable, predictedFixed, currency, monthStartDay, onClose, onSaved,
}: BudgetEditorModalProps) {
  const symbol = SYMBOLS[currency] || '';
  const computedIncome = Math.round(variable.income || 0);
  const fixed = predictedFixed != null ? predictedFixed : (variable.fixedSpent || 0);
  const piggy = Math.max(0, variable.piggyFunded || 0);
  const variableSpent = variable.spent || 0;

  const budgetByCat = new Map<string, number | null>();
  const spentByCat = new Map<string, number>();
  for (const l of essentials) {
    if (l.budget != null) budgetByCat.set(l.category, l.budget);
    spentByCat.set(l.category, l.spent || 0);
  }

  const [rows, setRows] = useState<EditRow[]>(() =>
    categories
      .filter((c) => c.catGroup === 'essential')
      .map((c) => {
        const cur = budgetByCat.get(c.name);
        const value = cur != null ? String(cur) : '';
        return {
          category: c.name,
          emoji: c.emoji || DEFAULT_EMOJI,
          color: c.color || DEFAULT_COLOR,
          spent: spentByCat.get(c.name) ?? 0,
          value,
          initial: value,
        };
      }),
  );
  const [income, setIncome] = useState('');
  const [incomeInitial, setIncomeInitial] = useState('');
  const [savings, setSavings] = useState('');
  const [savingsInitial, setSavingsInitial] = useState('');
  const [transferred, setTransferred] = useState(false);
  const [transferredInitial, setTransferredInitial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const month = currentCycleKey(monthStartDay);

  // Seed the income override + this-cycle savings from the engine on open.
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ value: number | null }>('/budget/income-override').catch(() => ({ value: null })),
      api<{ savings: Record<string, { amount: number; transferred: boolean }> }>('/budget/savings')
        .catch(() => ({ savings: {} as Record<string, { amount: number; transferred: boolean }> })),
    ]).then(([ov, sv]) => {
      if (!live) return;
      const ovStr = ov.value != null ? String(ov.value) : '';
      setIncome(ovStr); setIncomeInitial(ovStr);
      const entry = sv.savings?.[month];
      const svStr = entry && entry.amount > 0 ? String(entry.amount) : '';
      setSavings(svStr); setSavingsInitial(svStr);
      setTransferred(!!entry?.transferred); setTransferredInitial(!!entry?.transferred);
    });
    return () => { live = false; };
  }, [month]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const num = (s: string): number => (s.trim() === '' ? 0 : Number(s) || 0);
  const incomeNum = income.trim() === '' ? (variable.income || 0) : num(income);
  // Reserve from GROUP totals (Σ budget vs Σ spent) via the shared helper, so
  // this live preview matches what BudgetCard renders after Save — the old
  // per-row max() summed differently and the number jumped on save.
  const totalBudgeted = rows.reduce((s, r) => s + Math.max(0, num(r.value)), 0);
  const essentialSpentTotal = rows.reduce((s, r) => s + r.spent, 0);
  const reserve = essentialReserve(totalBudgeted, essentialSpentTotal);
  const capBeforeSavings = Math.max(0, incomeNum - fixed - reserve - piggy - variableSpent);
  const savingsApplied = Math.min(num(savings), capBeforeSavings);
  const committed = fixed + reserve;
  const disposable = incomeNum - committed - piggy - savingsApplied;
  const allowed = disposable - variableSpent;

  function setRowValue(category: string, value: string): void {
    setRows((rs) => rs.map((r) => (r.category === category ? { ...r, value } : r)));
  }

  async function save(): Promise<void> {
    setSaving(true);
    setErr(null);
    try {
      // The writes target distinct endpoints/categories with no ordering
      // dependency — fire them concurrently instead of N+1 sequential
      // round-trips. (A single batch endpoint would also make this atomic.)
      const writes: Promise<unknown>[] = [];
      // One PUT per essential whose limit changed (0/blank deletes the limit).
      for (const r of rows) {
        if (r.value.trim() === r.initial.trim()) continue;
        writes.push(api('/budgets', 'PUT', { category: r.category, monthlyAmount: num(r.value) }));
      }
      if (income.trim() !== incomeInitial.trim()) {
        writes.push(api('/budget/income-override', 'PUT', {
          value: income.trim() === '' ? null : num(income),
        }));
      }
      if (savings.trim() !== savingsInitial.trim() || transferred !== transferredInitial) {
        writes.push(api('/budget/savings', 'PUT', { month, amount: num(savings), transferred }));
      }
      await Promise.all(writes);
      onSaved();
      onClose();
    } catch {
      setErr('Could not save — check the engine is running and try again.');
      setSaving(false);
    }
  }

  return createPortal(
    <div className="overlay" onClick={() => { if (!saving) onClose(); }}>
      <div
        role="dialog"
        aria-label="Monthly budgets"
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Monthly budgets</h2>
        <p>
          Give each essential category a monthly limit. Fixed bills aren't budgeted,
          and variable spending is worked out from whatever's left. Leave blank for
          no limit.
        </p>

        <div className="bgt-group">This month</div>
        <div className="bm-row">
          <span className="bm-ico" style={{ background: '#4CD18022', color: '#4CD180' }}>💰</span>
          <div className="bm-info">
            <div className="bm-name">Expected income</div>
            <div className="bm-spent">
              Override the auto-averaged figure. Leave blank to use the average.
            </div>
          </div>
          <div className="bm-input">
            <span className="bm-cur">{symbol}</span>
            <input
              type="number" min="0" step="100"
              placeholder={String(computedIncome)}
              value={income}
              onChange={(e) => setIncome(e.target.value)}
            />
          </div>
        </div>

        <div className="bm-row">
          <span className="bm-ico" style={{ background: '#5C9EF522', color: '#5C9EF5' }}>🏦</span>
          <div className="bm-info">
            <div className="bm-name">Set aside for savings</div>
            <div className="bm-spent">
              A one-off reserve for this month — not a piggy bank.
              {' '}Room right now: <b>{money(capBeforeSavings, currency)}</b>.
            </div>
            <label className="bm-toggle">
              <input
                type="checkbox"
                checked={transferred}
                onChange={(e) => setTransferred(e.target.checked)}
              />
              <span>
                Transfer out of checking — when off, the reserve is just earmarked
                and stays in the account.
              </span>
            </label>
          </div>
          <button
            type="button" className="bm-max-btn"
            title="Set this month's reserve to every shekel left over"
            onClick={() => setSavings(String(Math.round(capBeforeSavings)))}
          >Max</button>
          <div className="bm-input">
            <span className="bm-cur">{symbol}</span>
            <input
              type="number" min="0" step="100" placeholder="0"
              value={savings}
              onChange={(e) => setSavings(e.target.value)}
            />
          </div>
        </div>

        <div className="bm-summary">
          <span>Total budgeted</span>
          <span>{money(totalBudgeted, currency)}</span>
        </div>

        <div className="bgt-group">Essentials</div>
        {rows.map((r) => {
          const sp = r.spent;
          const limit = num(r.value);
          const overNow = limit > 0 && sp > limit;
          return (
            <div className="bm-row" key={r.category}>
              <span className="bm-ico" style={{ background: `${r.color}22`, color: r.color }}>
                {r.emoji}
              </span>
              <div className="bm-info">
                <div className="bm-name">{r.category}</div>
                <div className={`bm-spent${overNow ? ' over' : ''}`}>
                  Spent {money(sp, currency)} this month
                </div>
              </div>
              <div className="bm-input">
                <span className="bm-cur">{symbol}</span>
                <input
                  type="number" min="0" step="50" placeholder="0"
                  value={r.value}
                  onChange={(e) => setRowValue(r.category, e.target.value)}
                />
              </div>
            </div>
          );
        })}

        <div className="bgt-group">Variable spending · allowed right now</div>
        <div className="bm-var">
          <div className="bm-var-amt">{money(allowed > 0 ? allowed : 0, currency)}</div>
          <div className="bm-var-note">
            {allowed > 0
              ? `Worked out automatically — ${money(incomeNum, currency)} in, `
                + `${money(committed, currency)} covers fixed bills and essentials, and `
                + `${money(variableSpent, currency)} is already spent.`
              : "There's no room for variable spending this month — income is fully "
                + 'taken up by fixed bills, essentials, and what\'s been spent already.'}
          </div>
        </div>

        {err && <div className="modal-err">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save budgets'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
