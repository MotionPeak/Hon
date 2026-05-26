import { useCallback, useEffect, useMemo, useState } from 'react';
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
      {subTab === 'spending' && <AiAnalysisCard />}
      {subTab === 'brokerage' && <BrokerageSubTab />}
    </div>
  );
}

interface InsightsStatus {
  state: 'idle' | 'generating' | 'ready' | 'error';
  text: string;
  generatedAt: string | null;
  message: string;
}

type InsightKind = 'win' | 'watch' | 'trend' | 'tip';
const AI_ICON: Record<InsightKind, string> = {
  win: '🎉', watch: '⚠️', trend: '📈', tip: '💡',
};
const AI_TAG_MAP: Record<string, InsightKind> = {
  WIN: 'win', WATCH: 'watch', TREND: 'trend', TIP: 'tip',
};

function inferInsightKind(s: string): InsightKind {
  const t = s.toLowerCase();
  if (/over budget|overspent|overspend|exceeded|spike|jumped|climbed|increase|higher|rose|watch out/.test(t)) return 'watch';
  if (/under budget|saved|still left|on track|good job|well done|nicely|great|dropped|reduced|lower than|less than/.test(t)) return 'win';
  if (/\btry |\bconsider|\bcould |\bsuggest|\brecommend|set a budget|cut back|aim to/.test(t)) return 'tip';
  return 'trend';
}

function parseInsights(text: string): { kind: InsightKind; text: string }[] {
  return String(text).split(/\n+/).map((raw) => {
    const s = raw.trim().replace(/^[-•*\d.)\s]+/, '').trim();
    if (!s) return null;
    const m = s.match(/^([A-Za-z]{3,6})\s*[:.—-]\s+(.+)$/);
    if (m && AI_TAG_MAP[m[1]!.toUpperCase()]) {
      return { kind: AI_TAG_MAP[m[1]!.toUpperCase()]!, text: m[2]!.trim() };
    }
    return { kind: inferInsightKind(s), text: s };
  }).filter((x): x is { kind: InsightKind; text: string } => x !== null);
}

function AiAnalysisCard() {
  const [status, setStatus] = useState<InsightsStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api<InsightsStatus>('/insights');
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  // Poll while the model is mid-generation.
  useEffect(() => {
    if (status?.state !== 'generating') return;
    const handle = setInterval(() => { void fetchStatus(); }, 1500);
    return () => clearInterval(handle);
  }, [status?.state, fetchStatus]);

  const generate = async (): Promise<void> => {
    try {
      await api('/insights', 'POST');
      // Optimistically flip to generating so the shimmer renders
      // immediately; the first poll will pick up the real state.
      setStatus((s) => ({
        state: 'generating', text: s?.text ?? '',
        generatedAt: s?.generatedAt ?? null,
        message: 'Generating insights…',
      }));
      await fetchStatus();
    } catch { /* keep prior state */ }
  };

  const generating = status?.state === 'generating';
  const ready = status?.state === 'ready' && status.text;
  const errored = status?.state === 'error';
  const cards = ready ? parseInsights(status.text) : [];

  return (
    <section className="ins-card ai-card-wrap" data-testid="ai-analysis">
      <header className="ins-card-head ai-head">
        <div className="label">AI analysis</div>
        <span className="spacer" />
        <button
          type="button"
          className="btn-primary"
          disabled={!!generating}
          onClick={() => void generate()}
        >{ready ? 'Regenerate' : 'Generate'}</button>
      </header>
      {generating && (
        <div className="ai-skel" data-testid="ai-skeleton">
          <div className="ai-skel-row" />
          <div className="ai-skel-row" />
          <div className="ai-skel-row" />
          <div className="ai-skel-row" />
        </div>
      )}
      {ready && cards.length > 0 && (
        <div className="ai-list">
          {cards.map((c, i) => (
            <div
              key={i}
              className={`ai-card ${c.kind}`}
              style={{ animationDelay: `${i * 70}ms` }}
            >
              <span className="ai-ico">{AI_ICON[c.kind]}</span>
              <span className="ai-text">{c.text}</span>
            </div>
          ))}
        </div>
      )}
      {ready && cards.length === 0 && (
        <div className="ai-empty">{status.text}</div>
      )}
      {errored && <div className="ai-empty">{status.message}</div>}
      {!generating && !ready && !errored && (
        <div className="ai-empty">
          No analysis yet — tap Generate for an AI read on this month's
          spending, budgets and trends.
        </div>
      )}
    </section>
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

type Range = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';
const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'ALL'];

function convertAmount(
  amount: number, from: string, to: string, rates: Record<string, number> | null,
): number {
  if (from === to) return amount;
  const toIls = from === 'ILS' ? 1 : rates?.[from] ?? 1;
  const fromIls = to === 'ILS' ? 1 : rates?.[to] ?? 1;
  return (amount * toIls) / fromIls;
}

function rangeStart(range: Range, latest: string): string {
  const d = new Date(latest);
  if (range === 'ALL') return '0000-01-01';
  if (range === 'YTD') return `${d.getFullYear()}-01-01`;
  if (range === '1M') d.setMonth(d.getMonth() - 1);
  if (range === '3M') d.setMonth(d.getMonth() - 3);
  if (range === '1Y') d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function pickDisplayCurrency(holdings: { currency: string }[]): string {
  const counts = new Map<string, number>();
  for (const h of holdings) counts.set(h.currency, (counts.get(h.currency) ?? 0) + 1);
  let best = 'USD';
  let bestN = 0;
  for (const [cur, n] of counts) {
    if (n > bestN) { best = cur; bestN = n; }
  }
  return best;
}

function BrokerageSubTab() {
  const [data, setData] = useState<BrokerageResp | null>(null);
  const [range, setRange] = useState<Range>('1Y');
  const [displayCur, setDisplayCur] = useState<string | null>(null);
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
  const rates = data.ilsRates;
  const cur = displayCur ?? pickDisplayCurrency(data.holdings);

  // Full series (sum across accounts), in the display currency.
  const dailyTotals = new Map<string, number>();
  for (const s of data.snapshots) {
    const v = convertAmount(s.value, s.currency, cur, rates);
    dailyTotals.set(s.date, (dailyTotals.get(s.date) ?? 0) + v);
  }
  const fullSeries: SeriesPoint[] = Array.from(dailyTotals.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const latestDate = fullSeries.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const cutoff = rangeStart(range, latestDate);
  const series = fullSeries.filter((p) => p.date >= cutoff);

  const currentValue = series.at(-1)?.value ?? 0;
  const startValue = series[0]?.value ?? currentValue;
  const change = currentValue - startValue;
  const changePct = startValue > 0 ? (change / startValue) * 100 : 0;

  // Holdings totals — convert each holding into the display currency.
  let portfolioValue = 0;
  let unrealized = 0;
  let costBasis = 0;
  for (const h of data.holdings) {
    portfolioValue += convertAmount(h.value ?? 0, h.currency, cur, rates);
    unrealized   += convertAmount(h.openPnl ?? 0, h.currency, cur, rates);
    costBasis    += convertAmount(h.costBasis ?? 0, h.currency, cur, rates);
  }
  const returnOnCost = costBasis > 0 ? (unrealized / costBasis) * 100 : 0;

  // Gain · 1Y: portfolio value now vs the snapshot ~365d back (or earliest).
  const oneYearAgo = rangeStart('1Y', latestDate);
  const oneYearPoint = fullSeries.find((p) => p.date >= oneYearAgo) ?? fullSeries[0];
  const gain1y = oneYearPoint ? portfolioValue - oneYearPoint.value : 0;
  const gain1yPct = oneYearPoint && oneYearPoint.value > 0
    ? (gain1y / oneYearPoint.value) * 100
    : 0;

  // Currencies the user can toggle between — ILS + every distinct holding cur.
  const currencies = Array.from(new Set([
    'ILS', ...data.holdings.map((h) => h.currency),
  ]));

  return (
    <div className="brokerage-pane">
      <div className="brk-stats" data-testid="brokerage-stats">
        <StatBox
          label="Portfolio value"
          value={money(portfolioValue, cur)}
          tone=""
        />
        <StatBox
          label="Gain · 1Y"
          value={`${gain1y >= 0 ? '+' : '−'}${money(Math.abs(gain1y), cur)}`}
          sub={`${gain1yPct >= 0 ? '+' : '−'}${Math.abs(gain1yPct).toFixed(2)}%`}
          tone={gain1y >= 0 ? 'good' : 'bad'}
        />
        <StatBox
          label="Unrealized P&L"
          value={`${unrealized >= 0 ? '+' : '−'}${money(Math.abs(unrealized), cur)}`}
          tone={unrealized >= 0 ? 'good' : 'bad'}
        />
        <StatBox
          label="Return on cost"
          value={`${returnOnCost >= 0 ? '+' : '−'}${Math.abs(returnOnCost).toFixed(2)}%`}
          tone={returnOnCost >= 0 ? 'good' : 'bad'}
        />
        <StatBox
          label="Holdings"
          value={String(data.holdings.length)}
          tone=""
        />
      </div>

      {fullSeries.length > 0 && (
        <section className="ins-card brk-chart-card">
          <header className="ins-card-head brk-chart-head">
            <div className="ins-sub">Value over time</div>
            <span className={`brk-change ${change >= 0 ? 'good' : 'bad'}`}>
              {change >= 0 ? '↑' : '↓'} {Math.abs(changePct).toFixed(2)}% ·{' '}
              {change >= 0 ? '+' : '−'}{money(Math.abs(change), cur)}
            </span>
            <span className="spacer" />
            <div className="seg brk-range" role="group" aria-label="Range">
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={r === range ? 'on' : ''}
                  onClick={() => setRange(r)}
                >{r}</button>
              ))}
            </div>
            {currencies.length > 1 && (
              <div className="seg brk-cur" role="group" aria-label="Currency">
                {currencies.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={c === cur ? 'on' : ''}
                    onClick={() => setDisplayCur(c)}
                  >{c}</button>
                ))}
              </div>
            )}
          </header>
          <ValueChart series={series} currency={cur} />
          <div className="brk-chart-axis">
            <span>{series[0]?.date ?? ''}</span>
            <span>{series.at(-1)?.date ?? ''}</span>
          </div>
        </section>
      )}

      {data.holdings.length > 0 && (
        <section className="ins-card">
          <header className="ins-card-head">
            <div className="ins-sub">
              Holdings · {data.holdings.length}
              {' '}position{data.holdings.length === 1 ? '' : 's'}
            </div>
            <span className="spacer" />
            <div className="ins-totals">
              <span className="brk-total-cap">Portfolio total</span>
              <b>{money(portfolioValue, cur)}</b>
            </div>
          </header>
          <ul className="brokerage-holdings" data-testid="brokerage-holdings">
            {data.holdings
              .slice()
              .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
              .map((h, i) => {
                const valCur = convertAmount(h.value ?? 0, h.currency, cur, rates);
                const weight = portfolioValue > 0 ? (valCur / portfolioValue) * 100 : 0;
                const pnlCur = convertAmount(h.openPnl ?? 0, h.currency, cur, rates);
                const costCur = convertAmount(h.costBasis ?? 0, h.currency, cur, rates);
                const pnlPct = costCur > 0 ? (pnlCur / costCur) * 100 : 0;
                const palette = ['#5C9EF5', '#5CC773', '#A880ED', '#F59942', '#E96B6B'];
                const dot = palette[i % palette.length];
                return (
                  <li key={`${h.accountId}-${h.symbol}`} className="bh-row brk-row">
                    <span className="bh-dot" style={{ background: dot }} />
                    <div className="bh-main">
                      <div className="bh-symbol">{h.symbol}</div>
                      {h.description && (
                        <div className="bh-desc">{h.description}</div>
                      )}
                    </div>
                    <div className="bh-weight">
                      <span
                        className="bh-weight-fill"
                        style={{
                          width: `${Math.max(2, weight)}%`,
                          background: dot,
                        }}
                      />
                    </div>
                    <div className="bh-value">
                      {money(valCur, cur)}
                      <div className="bh-weight-pct">{weight.toFixed(1)}%</div>
                    </div>
                    {h.openPnl != null && (
                      <span className={`brk-pnl ${pnlCur >= 0 ? 'good' : 'bad'}`}>
                        {pnlCur >= 0 ? '▲' : '▼'} {Math.abs(pnlPct).toFixed(2)}%
                        {' '}
                        {pnlCur >= 0 ? '+' : '−'}{money(Math.abs(pnlCur), cur)}
                      </span>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      )}
    </div>
  );
}

function StatBox({
  label, value, sub, tone,
}: {
  label: string; value: string; sub?: string; tone: 'good' | 'bad' | '';
}) {
  return (
    <div className="brk-stat" data-testid="brokerage-stat">
      <div className={`brk-stat-val${tone ? ' ' + tone : ''}`}>{value}</div>
      {sub && <div className={`brk-stat-sub${tone ? ' ' + tone : ''}`}>{sub}</div>}
      <div className="brk-stat-cap">{label}</div>
    </div>
  );
}

interface SeriesPoint { date: string; value: number }

function ValueChart({
  series, currency = 'ILS',
}: {
  series: SeriesPoint[]; currency?: string;
}) {
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
          <title>{p.date} · {money(p.value, currency)}</title>
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
