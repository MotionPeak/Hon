import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { DelayedLoader } from '../ui/DelayedLoader';
import { cycleKey, cycleLabel } from '../cycle';
import { money } from '../format';
import { useSettings } from '../settings/useSettings';
import type { Category } from '../settings/CategoriesPanel';
import type { Transaction } from '../activity/types';
import type { Account } from '../accounts/types';
import { cycleAnalytics, type MonthBucket } from './analytics';
import { isExcludedFromCycle } from '../activity/excluded';
import { LineChart } from './LineChart';
import {
  buildEquitySeries,
  sliceRange,
  type PerformanceEntry,
  type HoldingSnapshot,
} from './equitySeries';

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

  // Card-bill lump sums (and any manually-excluded txn) must NOT count as
  // spending in Insights — they're already itemised under the card account,
  // so counting the bank-side total too double-counts. Same rule the
  // Activity tab + legacy SPA apply.
  const isExcluded = useMemo(() => {
    const opts = {
      hideCardTotals: settings.hideCardTotals,
      cardProviders: settings.cardProviders,
    };
    return (t: Transaction): boolean => isExcludedFromCycle(t, opts);
  }, [settings.hideCardTotals, settings.cardProviders]);

  const months = useMemo(
    () => transactions ? cycleAnalytics(transactions, settings.monthStartDay, isExcluded) : [],
    [transactions, settings.monthStartDay, isExcluded],
  );
  const hasData = months.some((m) => m.spending > 0 || m.income > 0);

  if (transactions === null) return <DelayedLoader />;

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
          isExcluded={isExcluded}
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
  holdingSnapshots: HoldingSnapshot[];
  performance: PerformanceEntry[];
  ilsRates: Record<string, number> | null;
}

type Range = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';
const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'ALL'];

interface HoldingStats {
  value: number | null;
  cost: number | null;
  gain: number | null;
  gainPct: number | null;
}

/** Per-holding value / cost / gain in the holding's native currency.
 *  Faithful port of the legacy SPA's holdingStats() — the key subtlety is
 *  that SnapTrade reports `costBasis` and `openPnl` PER UNIT, so the
 *  position totals are `units × …`. `value` is the position total when the
 *  broker supplies it (Israeli funds); otherwise `units × price` (IBKR's
 *  VBR/VT leave value null). Gain prefers value − cost and falls back to
 *  the reported openPnl only when value or cost is unknown. Treating these
 *  as totals (the earlier React bug) made Portfolio value read ₪0 and the
 *  P&L wildly wrong. */
function holdingStats(h: {
  value: number | null; units: number; price: number | null;
  costBasis: number | null; openPnl: number | null;
}): HoldingStats {
  const value = h.value != null
    ? h.value
    : (h.price != null ? h.units * h.price : null);
  const cost = h.costBasis != null ? h.units * h.costBasis : null;
  const gain = value != null && cost != null
    ? value - cost
    : (h.openPnl != null ? h.openPnl : null);
  const gainPct = gain != null && cost ? (gain / Math.abs(cost)) * 100 : null;
  return { value, cost, gain, gainPct };
}

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

interface AccountPillsProps {
  accounts: Account[];
  value: 'all' | string;
  onChange: (next: 'all' | string) => void;
}

/** Segmented "All accounts" + per-account filter row above the chart.
 *  Pure presentational — the parent decides which accounts are eligible
 *  (brokerage-with-snapshots) and owns the selection state. */
function AccountPills({ accounts, value, onChange }: AccountPillsProps) {
  return (
    <div className="brk-acct-row" role="group" aria-label="Accounts">
      <button
        type="button"
        className={`brk-acct-pill${value === 'all' ? ' on' : ''}`}
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
      >All accounts</button>
      {accounts.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`brk-acct-pill${value === a.id ? ' on' : ''}`}
          aria-pressed={value === a.id}
          onClick={() => onChange(a.id)}
        >{a.label || `Account ${a.accountNumber}`}</button>
      ))}
    </div>
  );
}

interface InceptionInputProps {
  account: Account;
  onSaved: () => void | Promise<void>;
}

/** Per-account "investment start" editor. Lets the user pin the date
 *  from which their snapshot history is real — synthetic backfill
 *  before that date is hidden from the chart. PATCHes the engine on
 *  every commit and asks the parent to refetch so the chart redraws. */
function InceptionInput({ account, onSaved }: InceptionInputProps) {
  const [value, setValue] = useState<string>(account.inceptionDate ?? '');
  // Keep in sync when the focused account changes from the parent.
  useEffect(() => {
    setValue(account.inceptionDate ?? '');
  }, [account.id, account.inceptionDate]);
  const save = async (next: string): Promise<void> => {
    await api(
      `/accounts/${encodeURIComponent(account.id)}/inception`,
      'PATCH',
      { inceptionDate: next || null },
    );
    await onSaved();
  };
  return (
    <div className="brk-inception-row">
      <label className="brk-inception-label">
        <span>Investment start (since when "ALL" counts):</span>
        <input
          type="date"
          className="brk-inception-input"
          aria-label="Investment start"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            void save(e.target.value);
          }}
        />
      </label>
      {value && (
        <button
          type="button"
          className="brk-inception-clear"
          aria-label="Clear inception date"
          onClick={() => { setValue(''); void save(''); }}
        >×</button>
      )}
      <span className="brk-inception-hint">
        {value
          ? 'Synthetic backfill before this date is hidden.'
          : 'Until set, the chart shows whatever the price source returns (Yahoo: up to 10 years).'}
      </span>
    </div>
  );
}

interface InceptionBadgeProps {
  earliest: string | null;
}

/** Read-only "Since YYYY-MM-DD (earliest)" badge for the All-accounts
 *  view. No edit affordance — per-account inception is the source of
 *  truth and we don't want a mass-edit here that silently overwrites
 *  per-account customisation. */
function InceptionBadge({ earliest }: InceptionBadgeProps) {
  if (!earliest) return null;
  return (
    <div className="brk-inception-badge">
      Since {earliest} (earliest)
    </div>
  );
}

function BrokerageSubTab() {
  const [data, setData] = useState<BrokerageResp | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [acctFilter, setAcctFilter] = useState<'all' | string>('all');
  const [range, setRange] = useState<Range>('1Y');
  const [displayCur, setDisplayCur] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, a] = await Promise.all([
        api<BrokerageResp>('/brokerage'),
        api<{ accounts: Account[] }>('/accounts').catch(
          () => ({ accounts: [] as Account[] }),
        ),
      ]);
      setData(b);
      setAccounts(a.accounts);
    } catch {
      setData({
        holdings: [], snapshots: [], holdingSnapshots: [],
        performance: [], ilsRates: null,
      });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (data === null) return <DelayedLoader />;
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

  // Brokerage accounts in scope of the pills: any account with at
  // least one snapshot in /brokerage. The engine only writes snapshots
  // for brokerage accounts, so the intersection is the right filter
  // without a separate company.type check.
  const brkAcctIds = new Set(data.snapshots.map((s) => s.accountId));
  const brkAccounts = accounts.filter((a) => brkAcctIds.has(a.id));

  // For the All-accounts view we show a read-only earliest-inception
  // badge instead of an editable input. The "earliest" is
  // min(account.inceptionDate ?? firstSnapshotDate for that account) —
  // accounts without an inception use the first date the engine has
  // ever seen for them as the implicit starting point.
  const firstSnapByAcct = new Map<string, string>();
  for (const s of data.snapshots) {
    const cur = firstSnapByAcct.get(s.accountId);
    if (!cur || s.date < cur) firstSnapByAcct.set(s.accountId, s.date);
  }
  const earliestCandidates = brkAccounts
    .map((a) => a.inceptionDate ?? firstSnapByAcct.get(a.id) ?? null)
    .filter((d): d is string => d !== null);
  const earliestInception: string | null = earliestCandidates.length === 0
    ? null
    : earliestCandidates.reduce((m, d) => d < m ? d : m, earliestCandidates[0]!);

  // Focused account (when a specific pill is on) — drives the
  // InceptionInput.
  const focusedAccount = acctFilter === 'all'
    ? null
    : brkAccounts.find((a) => a.id === acctFilter) ?? null;

  // Equity series — full 3-tier resolution (broker performance → forward-
  // filled holding snapshots → local account snapshots), scoped to the
  // selected account. This is what gives the chart real long-range history
  // instead of just the last few local snapshots.
  const convert = (value: number, currency: string): number =>
    convertAmount(value, currency, cur, rates);
  const fullSeries = buildEquitySeries({
    performance: data.performance,
    snapshots: data.snapshots,
    holdingSnapshots: data.holdingSnapshots,
    accounts: accounts.map((a) => ({
      id: a.id, connectionId: a.connectionId, inceptionDate: a.inceptionDate,
    })),
    acctFilter,
    convert,
  });
  const series = sliceRange(fullSeries, range);

  const periodChange = (series.at(-1)?.value ?? 0) - (series[0]?.value ?? 0);
  const chartTone: 'good' | 'bad' = periodChange >= 0 ? 'good' : 'bad';

  const currentValue = series.at(-1)?.value ?? 0;
  const startValue = series[0]?.value ?? currentValue;
  const change = currentValue - startValue;
  const changePct = startValue > 0 ? (change / startValue) * 100 : 0;

  // Holdings + accounts scoped to the selected pill — every metric below
  // follows the active account, not the whole portfolio.
  const scopedHoldings = acctFilter === 'all'
    ? data.holdings
    : data.holdings.filter((h) => h.accountId === acctFilter);
  const scopedBrkAccounts = acctFilter === 'all'
    ? brkAccounts
    : brkAccounts.filter((a) => a.id === acctFilter);

  // Portfolio value = sum of in-scope account balances (INCLUDES cash) —
  // the legacy SPA's definition. The holdings-value sum can be smaller
  // (uninvested cash) or, for brokers that report positions with null
  // value, would understate the account. Fall back to the holdings-value
  // sum only when no in-scope account exposes a balance.
  let balanceTotal = 0;
  let haveBalance = false;
  for (const a of scopedBrkAccounts) {
    if (a.balance == null) continue;
    balanceTotal += convertAmount(a.balance, a.currency, cur, rates);
    haveBalance = true;
  }

  // Cost + unrealized gain come from priced positions only (holdingStats).
  // holdingsValueTotal drives each row's allocation weight — relative to
  // the priced holdings, not the cash-inclusive balance.
  let holdingsValueTotal = 0;
  let unrealized = 0;
  let costBasis = 0;
  for (const h of scopedHoldings) {
    const s = holdingStats(h);
    holdingsValueTotal += convertAmount(s.value ?? 0, h.currency, cur, rates);
    unrealized        += convertAmount(s.gain ?? 0, h.currency, cur, rates);
    costBasis         += convertAmount(s.cost ?? 0, h.currency, cur, rates);
  }
  const portfolioValue = haveBalance ? balanceTotal : holdingsValueTotal;
  const returnOnCost = costBasis > 0 ? (unrealized / costBasis) * 100 : 0;
  // Uninvested cash = account balance minus the priced positions. Surfaced
  // as its own holdings row so the positions visibly add up to the
  // Portfolio total instead of silently falling short. Only when the
  // balance is the source AND the gap is more than rounding noise.
  const cashValue = haveBalance
    ? Math.max(0, portfolioValue - holdingsValueTotal)
    : 0;
  const hasCashRow = cashValue >= 0.5;

  // Gain · 1Y: latest equity vs the equity point ~365d back — BOTH taken
  // from the same equity series so the figure stays internally consistent
  // and matches the chart. (Using the holdings-value sum as "current" broke
  // when a broker reports positions with null value — e.g. IBKR's VBR/VT —
  // making the tile read −100%.) Falls back to the holdings sum only when
  // the series is empty.
  const latestEquity = fullSeries.at(-1)?.value ?? portfolioValue;
  const latestDate = fullSeries.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const oneYearAgo = rangeStart('1Y', latestDate);
  const oneYearPoint = fullSeries.find((p) => p.date >= oneYearAgo) ?? fullSeries[0];
  const gain1y = oneYearPoint ? latestEquity - oneYearPoint.value : 0;
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
          value={String(scopedHoldings.length)}
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
          <LineChart series={series} currency={cur} tone={chartTone} />
        </section>
      )}

      {brkAccounts.length > 0 && (
        <AccountPills
          accounts={brkAccounts}
          value={acctFilter}
          onChange={setAcctFilter}
        />
      )}
      {acctFilter === 'all' ? (
        <InceptionBadge earliest={earliestInception} />
      ) : (
        focusedAccount && (
          <InceptionInput account={focusedAccount} onSaved={refresh} />
        )
      )}

      {scopedHoldings.length > 0 && (
        <section className="ins-card">
          <header className="ins-card-head">
            <div className="ins-sub">
              Holdings · {scopedHoldings.length}
              {' '}position{scopedHoldings.length === 1 ? '' : 's'}
            </div>
            <span className="spacer" />
            <div className="ins-totals">
              <span className="brk-total-cap">Portfolio total</span>
              <b>{money(portfolioValue, cur)}</b>
            </div>
          </header>
          <ul className="brokerage-holdings" data-testid="brokerage-holdings">
            {scopedHoldings
              .slice()
              .sort((a, b) => (holdingStats(b).value ?? 0) - (holdingStats(a).value ?? 0))
              .map((h, i) => {
                const s = holdingStats(h);
                const valCur = convertAmount(s.value ?? 0, h.currency, cur, rates);
                // Weight is relative to the Portfolio total (balance incl.
                // cash) so the rows — including the Cash row below — sum to
                // 100%.
                const weight = portfolioValue > 0 ? (valCur / portfolioValue) * 100 : 0;
                const pnlCur = convertAmount(s.gain ?? 0, h.currency, cur, rates);
                const pnlPct = s.gainPct ?? 0;
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
                    {s.gain != null && (
                      <span className={`brk-pnl ${pnlCur >= 0 ? 'good' : 'bad'}`}>
                        {pnlCur >= 0 ? '▲' : '▼'} {Math.abs(pnlPct).toFixed(2)}%
                        {' '}
                        {pnlCur >= 0 ? '+' : '−'}{money(Math.abs(pnlCur), cur)}
                      </span>
                    )}
                  </li>
                );
              })}
            {hasCashRow && (
              <li className="bh-row brk-row" data-testid="brokerage-cash-row">
                <span className="bh-dot" style={{ background: '#7E8AA0' }} />
                <div className="bh-main">
                  <div className="bh-symbol">Cash</div>
                  <div className="bh-desc">Uninvested balance</div>
                </div>
                <div className="bh-weight">
                  <span
                    className="bh-weight-fill"
                    style={{
                      width: `${Math.max(2, portfolioValue > 0 ? (cashValue / portfolioValue) * 100 : 0)}%`,
                      background: '#7E8AA0',
                    }}
                  />
                </div>
                <div className="bh-value">
                  {money(cashValue, cur)}
                  <div className="bh-weight-pct">
                    {(portfolioValue > 0 ? (cashValue / portfolioValue) * 100 : 0).toFixed(1)}%
                  </div>
                </div>
              </li>
            )}
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
  /** Card-bill / manually-excluded predicate — drops those rows from the
   *  breakdown, deltas and biggest-expense so they don't double-count. */
  isExcluded: (t: Transaction) => boolean;
}

function MonthDetail(
  { monthKey, months, transactions, categories, monthStartDay, isExcluded }: MonthDetailProps,
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
    if (isExcluded(t)) continue;
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
    && !isExcluded(t)
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
