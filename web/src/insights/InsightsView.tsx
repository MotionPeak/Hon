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

type InsightsSubTab = 'spending' | 'brokerage';

export function InsightsView() {
  const [settings] = useSettings();
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<InsightsSubTab>('spending');

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

  const activeMonth = selectedMonth && months.some((m) => m.month === selectedMonth)
    ? selectedMonth
    : months[months.length - 1]?.month ?? null;

  return (
    <div className="insights-view">
      <h1>Insights</h1>
      <div className="ins-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'spending'}
          className={`ins-tab${subTab === 'spending' ? ' on' : ''}`}
          onClick={() => setSubTab('spending')}
        >Spending</button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'brokerage'}
          className={`ins-tab${subTab === 'brokerage' ? ' on' : ''}`}
          onClick={() => setSubTab('brokerage')}
        >Brokerage</button>
      </div>
      {subTab === 'spending' && !hasData && (
        <p className="blank">
          No analytics yet — sync an account to see your spending trends.
        </p>
      )}
      {subTab === 'spending' && hasData && (
      <section className="ins-card">
        <header className="ins-card-head">
          <div className="ins-sub">Last 12 months · tap a month for its breakdown</div>
        </header>
        <MonthBars
          months={months}
          selected={activeMonth}
          onSelect={setSelectedMonth}
        />
      </section>
      )}
      {subTab === 'spending' && hasData && activeMonth && (
        <MonthDetail
          monthKey={activeMonth}
          transactions={transactions}
          categories={categories}
          monthStartDay={settings.monthStartDay}
        />
      )}
      {subTab === 'brokerage' && <BrokerageSubTab />}
    </div>
  );
}

interface Holding {
  accountId: string;
  symbol: string;
  description: string | null;
  units: number;
  price: number | null;
  currency: string;
  costBasis: number | null;
  openPnl: number | null;
  value: number | null;
  updatedAt: string;
}
interface ValueSnapshot {
  accountId: string; date: string; value: number; currency: string;
}
interface BrokerageResp {
  holdings: Holding[];
  snapshots: ValueSnapshot[];
  holdingSnapshots: unknown[];
  performance: unknown[];
  ilsRates: Record<string, number> | null;
}

function BrokerageSubTab() {
  const [data, setData] = useState<BrokerageResp | null>(null);
  useEffect(() => {
    api<BrokerageResp>('/brokerage')
      .then(setData)
      .catch(() => setData({
        holdings: [], snapshots: [], holdingSnapshots: [],
        performance: [], ilsRates: null,
      }));
  }, []);
  if (data === null) return <p>Loading…</p>;
  if (data.holdings.length === 0 && data.snapshots.length === 0) {
    return (
      <p className="blank">
        📊 No brokerage data yet — link an investment account and Hon
        will start tracking value over time here.
      </p>
    );
  }

  // Aggregate snapshots by date — sum across accounts, convert non-ILS
  // to ILS via the rates ride-along. Sorted ascending by date.
  const dailyTotals = new Map<string, number>();
  for (const s of data.snapshots) {
    const rate = s.currency === 'ILS' ? 1 : data.ilsRates?.[s.currency] ?? 1;
    dailyTotals.set(s.date, (dailyTotals.get(s.date) ?? 0) + s.value * rate);
  }
  const series = Array.from(dailyTotals.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const currentValue = series.at(-1)?.value ?? 0;

  return (
    <div className="brokerage-pane">
      {series.length > 0 && (
        <section className="ins-card">
          <header className="ins-card-head">
            <div className="ins-sub">Value over time · ILS</div>
            <div className="ins-totals">
              <b>{money(currentValue, 'ILS')}</b>
            </div>
          </header>
          <ValueChart series={series} />
        </section>
      )}
      {data.holdings.length > 0 && (
        <section className="ins-card">
          <header className="ins-card-head">
            <div className="ins-sub">Holdings · {data.holdings.length}</div>
          </header>
          <ul className="brokerage-holdings" data-testid="brokerage-holdings">
            {data.holdings
              .slice()
              .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
              .map((h) => (
                <li key={`${h.accountId}-${h.symbol}`} className="bh-row">
                  <div className="bh-main">
                    <div className="bh-symbol">{h.symbol}</div>
                    {h.description && (
                      <div className="bh-desc">{h.description}</div>
                    )}
                  </div>
                  <div className="bh-meta">
                    {h.units.toLocaleString()} units
                    {h.price != null && (
                      <> · {money(h.price, h.currency)}</>
                    )}
                  </div>
                  <div className="bh-value">
                    {money(h.value ?? 0, h.currency)}
                  </div>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface SeriesPoint { date: string; value: number }

function ValueChart({ series }: { series: SeriesPoint[] }) {
  const W = 600;
  const H = 180;
  const PAD = { l: 8, r: 8, t: 8, b: 18 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const min = Math.min(...series.map((p) => p.value));
  const max = Math.max(...series.map((p) => p.value));
  const range = Math.max(1, max - min);
  const n = series.length;
  const x = (i: number): number =>
    n === 1 ? PAD.l + innerW / 2 : PAD.l + (i / (n - 1)) * innerW;
  const y = (v: number): number =>
    PAD.t + innerH - ((v - min) / range) * innerH;
  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  const area = `${path} L ${x(n - 1)} ${PAD.t + innerH} L ${x(0)} ${PAD.t + innerH} Z`;
  return (
    <svg
      data-testid="brokerage-chart"
      className="brokerage-chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="bk-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity=".28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#bk-area)" />
      <path
        d={path}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {series.map((p, i) => (
        <circle
          key={p.date}
          cx={x(i)}
          cy={y(p.value)}
          r={3}
          fill="var(--accent)"
        >
          <title>{p.date} · {money(p.value, 'ILS')}</title>
        </circle>
      ))}
    </svg>
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
