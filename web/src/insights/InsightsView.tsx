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
          months={months}
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
  months: MonthBucket[];
  transactions: Transaction[];
  categories: Category[];
  monthStartDay: number;
}

function MonthDetail(
  { monthKey, months, transactions, categories, monthStartDay }: MonthDetailProps,
) {
  const idx = months.findIndex((m) => m.month === monthKey);
  const prev = idx > 0 ? months[idx - 1] : null;
  // Trailing-average over completed months (every month but the current).
  const completed = months.slice(0, -1).filter((m) => m.spending > 0);
  const avgSpending = completed.length > 0
    ? completed.reduce((s, m) => s + m.spending, 0) / completed.length
    : null;
  // Per-category history across the 12-month window so we can show
  // vs-last and vs-avg delta chips on each row.
  const cycleIdx = new Map<string, number>();
  months.forEach((m, i) => cycleIdx.set(m.month, i));
  const byCatCycle = new Map<string, number[]>();
  for (const t of transactions) {
    if (t.currency !== 'ILS' || t.refundForId) continue;
    if (t.amount >= 0) continue;
    const ci = cycleIdx.get(cycleKey(t.date, monthStartDay));
    if (ci === undefined) continue;
    const cat = t.category || 'Other';
    let arr = byCatCycle.get(cat);
    if (!arr) { arr = new Array(months.length).fill(0); byCatCycle.set(cat, arr); }
    arr[ci] += -t.amount;
  }
  const avgByCat = new Map<string, number>();
  const compIdx = months.slice(0, -1)
    .map((m, i) => (m.spending > 0 ? i : -1))
    .filter((i) => i >= 0);
  for (const [cat, arr] of byCatCycle) {
    if (compIdx.length === 0) continue;
    const sum = compIdx.reduce((s, i) => s + (arr[i] || 0), 0);
    avgByCat.set(cat, sum / compIdx.length);
  }
  const inMonth = transactions.filter((t) =>
    !t.refundForId
    && t.currency === 'ILS'
    && cycleKey(t.date, monthStartDay) === monthKey,
  );
  const byCat = new Map<string, number>();
  let totalSpending = 0;
  let totalIncome = 0;
  let biggest: { amount: number; description: string; date: string; cat: string } | null = null;
  for (const t of inMonth) {
    if (t.amount < 0) {
      const cat = t.category || 'Other';
      byCat.set(cat, (byCat.get(cat) ?? 0) + -t.amount);
      totalSpending += -t.amount;
      const spent = -t.amount;
      if (!biggest || spent > biggest.amount) {
        biggest = { amount: spent, description: t.description, date: t.date, cat };
      }
    } else {
      totalIncome += t.amount;
    }
  }
  const net = totalIncome - totalSpending;
  const positive = net >= 0;

  const categoryByName = new Map<string, Category>();
  for (const c of categories) categoryByName.set(c.name, c);
  const rows = Array.from(byCat.entries())
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <section className="ins-card" data-testid="month-detail">
      <header className="ins-card-head md-head">
        <h2 className="md-month">{cycleLabel(monthKey)}</h2>
        <TrendPill base={prev?.spending ?? null} current={totalSpending} label={
          prev ? `vs ${cycleLabel(prev.month).split(' ')[0]}` : ''} />
        <TrendPill base={avgSpending} current={totalSpending} label="vs avg" />
      </header>
      <div className="md-tiles">
        <StatTile value={money(totalSpending, 'ILS')} label="Spent" tone="bad" />
        <StatTile value={money(totalIncome, 'ILS')} label="Income" tone="good" />
        <StatTile
          value={money(Math.abs(net), 'ILS')}
          label={positive ? 'Saved' : 'Overspent'}
          tone={positive ? 'good' : 'bad'}
        />
        <StatTile
          value={String(inMonth.length)}
          label={inMonth.length === 1 ? 'Transaction' : 'Transactions'}
          tone=""
        />
      </div>
      <div className="md-label">Where it went</div>
      {rows.length === 0 ? (
        <p className="blank">No spending in this month.</p>
      ) : (
        <ul className="ins-cat-list">
          {rows.map(([catName, amt]) => {
            const cat = categoryByName.get(catName);
            const pct = (amt / max) * 100;
            const histArr = byCatCycle.get(catName);
            const prevAmt = histArr && idx > 0 ? histArr[idx - 1] ?? null : null;
            const avgAmt = avgByCat.get(catName) ?? null;
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
                  <div className="ins-cat-d">
                    <DeltaChip current={amt} base={prevAmt} label="vs last" />
                    <DeltaChip current={amt} base={avgAmt}  label="vs avg" />
                  </div>
                </div>
                <div className="ins-cat-amt">{money(amt, 'ILS')}</div>
              </li>
            );
          })}
        </ul>
      )}
      {biggest && (
        <div className="md-big" data-testid="biggest-expense">
          <span
            className="md-big-ico"
            style={{
              background: (categoryByName.get(biggest.cat)?.color ?? '#999EB8') + '22',
            }}
          >
            {categoryByName.get(biggest.cat)?.emoji ?? '▫️'}
          </span>
          <div className="md-big-main">
            <div className="md-big-cap">Biggest expense</div>
            <div className="md-big-desc">{biggest.description || biggest.cat}</div>
          </div>
          <div>
            <div className="md-big-amt">{money(biggest.amount, 'ILS')}</div>
            <div className="md-big-date">
              {new Date(biggest.date).toLocaleDateString(undefined, {
                day: 'numeric', month: 'short',
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DeltaChip({
  current, base, label,
}: {
  current: number; base: number | null; label: string;
}) {
  if (base == null) return null;
  const diff = Math.round(current - base);
  const cls = diff > 0 ? 'bad' : diff < 0 ? 'good' : 'flat';
  const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '±';
  return (
    <span className={`md-d ${cls}`}>
      {arrow}{money(Math.abs(diff), 'ILS')} {label}
    </span>
  );
}

function TrendPill({
  base, current, label,
}: {
  base: number | null; current: number; label: string;
}) {
  if (base == null || base <= 0 || !label) return null;
  const pct = ((current - base) / base) * 100;
  const down = pct < 0;
  return (
    <span className={`md-trend ${down ? 'good' : 'bad'}`}>
      {down ? '↓ ' : '↑ '}{Math.abs(pct).toFixed(0)}% {label}
    </span>
  );
}

function StatTile({
  value, label, tone,
}: {
  value: string; label: string; tone: 'good' | 'bad' | '';
}) {
  return (
    <div className="md-tile" data-testid="md-tile">
      <div className={`md-tile-val${tone ? ' ' + tone : ''}`}>{value}</div>
      <div className="md-tile-cap">{label}</div>
    </div>
  );
}
