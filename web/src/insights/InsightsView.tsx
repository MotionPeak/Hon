import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { cycleKey, cycleLabel } from '../cycle';
import { money } from '../format';
import { useSettings } from '../settings/useSettings';
import type { Category } from '../settings/CategoriesPanel';
import type { Transaction } from '../activity/types';
import { cycleAnalytics, type MonthBucket } from './analytics';

function monthLetter(key: string): string {
  // "2026-05" → "M" (English month letter — matches the legacy app).
  const [yStr, mStr] = key.split('-');
  const date = new Date(Number(yStr), Number(mStr) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'short' })[0] ?? '?';
}

export function InsightsView() {
  const [settings] = useSettings();
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ transactions: Transaction[] }>('/transactions'),
      api<{ categories: Category[] }>('/categories'),
    ]).then(([t, c]) => {
      setTransactions(t.transactions);
      setCategories(c.categories);
    }).catch(() => {
      setTransactions([]);
    });
  }, []);

  const months = useMemo(
    () => transactions ? cycleAnalytics(transactions, settings.monthStartDay) : [],
    [transactions, settings.monthStartDay],
  );
  const hasData = months.some((m) => m.spending > 0 || m.income > 0);

  if (transactions === null) return <p>Loading…</p>;

  if (!hasData) {
    return (
      <div className="insights-view">
        <h1>Insights</h1>
        <p className="blank">
          No analytics yet — sync an account to see your spending trends.
        </p>
      </div>
    );
  }

  const activeMonth = selectedMonth && months.some((m) => m.month === selectedMonth)
    ? selectedMonth
    : months[months.length - 1]?.month ?? null;

  return (
    <div className="insights-view">
      <h1>Insights</h1>
      <section className="ins-card">
        <header className="ins-card-head">
          <div className="label">Spending</div>
          <div className="ins-sub">Last 12 months · tap a month for its breakdown</div>
        </header>
        <MonthBars
          months={months}
          selected={activeMonth}
          onSelect={setSelectedMonth}
        />
      </section>
      {activeMonth && (
        <MonthDetail
          monthKey={activeMonth}
          transactions={transactions}
          categories={categories}
          monthStartDay={settings.monthStartDay}
        />
      )}
    </div>
  );
}

interface MonthBarsProps {
  months: MonthBucket[];
  selected: string | null;
  onSelect: (key: string) => void;
}

function MonthBars({ months, selected, onSelect }: MonthBarsProps) {
  const max = Math.max(1, ...months.map((m) => m.spending));
  return (
    <div className="mini-bars">
      {months.map((m) => {
        const h = Math.max(3, Math.round((m.spending / max) * 100));
        const isSel = m.month === selected;
        const label = m.spending > 0
          ? `${cycleLabel(m.month)} · ${money(m.spending, 'ILS')} spending`
          : `${cycleLabel(m.month)} · no spending`;
        return (
          <button
            key={m.month}
            type="button"
            data-month={m.month}
            className={`mb-col${isSel ? ' sel' : ''}`}
            aria-label={label}
            aria-pressed={isSel}
            onClick={() => onSelect(m.month)}
          >
            <span className="mb-fill" style={{ height: `${h}%` }} />
            <span className="mb-x">{monthLetter(m.month)}</span>
          </button>
        );
      })}
    </div>
  );
}

interface MonthDetailProps {
  monthKey: string;
  transactions: Transaction[];
  categories: Category[];
  monthStartDay: number;
}

function MonthDetail(
  { monthKey, transactions, categories, monthStartDay }: MonthDetailProps,
) {
  const inMonth = transactions.filter((t) =>
    !t.refundForId
    && t.currency === 'ILS'
    && cycleKey(t.date, monthStartDay) === monthKey,
  );
  // Per-category spending breakdown (ignore income for the spending pane).
  const byCat = new Map<string, number>();
  let totalSpending = 0;
  let totalIncome = 0;
  for (const t of inMonth) {
    if (t.amount < 0) {
      const cat = t.category || 'Other';
      byCat.set(cat, (byCat.get(cat) ?? 0) + -t.amount);
      totalSpending += -t.amount;
    } else {
      totalIncome += t.amount;
    }
  }
  const categoryByName = new Map<string, Category>();
  for (const c of categories) categoryByName.set(c.name, c);
  const rows = Array.from(byCat.entries())
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <section className="ins-card" data-testid="month-detail">
      <header className="ins-card-head">
        <h2>{cycleLabel(monthKey)}</h2>
        <div className="ins-totals">
          <span className="ins-spent">Spent <b>{money(totalSpending, 'ILS')}</b></span>
          {totalIncome > 0 && (
            <span className="ins-income">In <b>{money(totalIncome, 'ILS')}</b></span>
          )}
        </div>
      </header>
      {rows.length === 0 ? (
        <p className="blank">No spending in this month.</p>
      ) : (
        <ul className="ins-cat-list">
          {rows.map(([catName, amt]) => {
            const cat = categoryByName.get(catName);
            const pct = (amt / max) * 100;
            return (
              <li key={catName} className="ins-cat-row">
                <span
                  className="ins-cat-emoji"
                  style={{ background: cat ? cat.color + '22' : 'var(--card-hi)' }}
                >
                  {cat?.emoji ?? '▫️'}
                </span>
                <div className="ins-cat-main">
                  <div className="ins-cat-name">{catName}</div>
                  <div className="ins-cat-bar">
                    <span
                      className="ins-cat-bar-fill"
                      style={{
                        width: `${pct}%`,
                        background: cat?.color ?? 'var(--accent)',
                      }}
                    />
                  </div>
                </div>
                <div className="ins-cat-amt">{money(amt, 'ILS')}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
