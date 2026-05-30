import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from '../format';
import type { Account, Company } from '../accounts/types';
import { DelayedLoader } from '../ui/DelayedLoader';
import { useSettings } from '../settings/useSettings';
import { currentCycleRange, currentCycleKey, prevCycleKey } from '../cycle';
import type { Transaction } from '../activity/types';
import type { Category } from '../settings/CategoriesPanel';
import {
  detectMerchants, expectedFixedThisCycle,
  type FreqOrIgnore, type RecurringData,
} from '../recurring/helpers';
import { useSplitwise } from '../splitwise/useSplitwise';
import { owedByFriend } from '../splitwise/owed';
import { OwedToYouCard } from './OwedToYouCard';
import { isExcludedFromCycle } from '../activity/excluded';
import { buildPieCats } from './spend';
import { SpendingCard } from './SpendingCard';
import { BudgetCard } from './BudgetCard';

/**
 * Builds the `/budget` query path, scoping it to the user's billing-cycle
 * window (`start`/`end`) so posted spend, income and essentials match the
 * cycle — not the calendar month — when monthStartDay ≠ 1. Also appends the
 * card-bill exclusion list as repeated `cardProvider` params: bank-side
 * credit-card bill lump sums (e.g. the monthly "מקס איט פיננסים" debit) are
 * already itemised under the card account, so counting them again on the bank
 * side double-counts spending. Same contract Insights, Activity, and the
 * legacy SPA already use.
 */
function budgetPathFor(
  cardProviders: string[],
  range: { start: string; end: string },
): string {
  const params = new URLSearchParams();
  params.set('start', range.start);
  params.set('end', range.end);
  for (const p of cardProviders) params.append('cardProvider', p);
  return `/budget?${params.toString()}`;
}

interface CurrencyTotal { currency: string; total: number; accountCount: number }

/** One net-worth source bucket from /summary (bank, card, pension, brokerage,
 *  loan, or an `asset:<kind>`); already converted to ILS by the engine.
 *  Negative for debt (cards, loans). */
interface NetWorthSource { key: string; amount: number }

interface Summary {
  byCurrency: CurrencyTotal[];
  accountCount: number;
  connectionCount: number;
  manualAssetCount?: number;
  netWorthILS: number | null;
  sources?: NetWorthSource[];
}

interface BudgetVariable {
  income: number;
  committed: number;
  spent: number;
  fixedSpent: number;
  essentialSpent: number;
  allowed: number;
  savings: number;
  piggyFunded: number;
}

interface BudgetLine {
  category: string;
  budget: number | null;
  spent: number;
}

interface BudgetResponse {
  currency: string;
  variable: BudgetVariable;
  essentials?: BudgetLine[];
}

export function OverviewView() {
  const [settings] = useSettings();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [budget, setBudget] = useState<BudgetResponse | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [recurring, setRecurring] = useState<RecurringData | null>(null);
  // Bumped after the budget editor saves, to re-run the /budget fetch below.
  const [refreshKey, setRefreshKey] = useState(0);

  // A plain string, stable by VALUE across renders (same providers + same
  // cycle → same path), so the effect refetches only when the exclusion list
  // or the billing cycle actually changes — not on every re-render an array
  // dependency would trigger.
  const budgetPath = budgetPathFor(
    settings.hideCardTotals ? settings.cardProviders : [],
    currentCycleRange(settings.monthStartDay),
  );

  useEffect(() => {
    Promise.all([
      // The engine wraps it as `{ summary: {...} }` (the legacy SPA unwraps
      // `r.summary`); reading it flat left net worth permanently "—".
      api<{ summary: Summary }>('/summary'),
      api<BudgetResponse>(budgetPath),
      api<{ companies: Company[] }>('/companies').catch(() => ({ companies: [] })),
      api<{ accounts: Account[] }>('/accounts').catch(() => ({ accounts: [] })),
    ]).then(([s, b, c, a]) => {
      setSummary(s.summary);
      setBudget(b);
      setCompanies(c.companies ?? []);
      setAccounts(a.accounts ?? []);
    }).catch(() => {
      setSummary({ byCurrency: [], accountCount: 0, connectionCount: 0, netWorthILS: 0 });
      setBudget(null);
    });

    // Recurring detection feeds the predicted-fixed headline (same source the
    // Fixed bills tab uses). Independent of the budget fetch — if any of these
    // fail, predictedFixed falls back to null and the headline reverts to the
    // posted figure (variable.committed). Never blocks the dashboard.
    Promise.all([
      api<{ transactions: Transaction[] }>('/transactions'),
      api<{ categories: Category[] }>('/categories'),
      api<{ frequencies: Record<string, FreqOrIgnore> }>('/merchant-frequencies'),
      api<{ splits: Record<string, number> }>('/category-splits'),
      api<{ cancelled: Record<string, string> }>('/subscriptions/cancelled')
        .catch(() => ({ cancelled: {} as Record<string, string> })),
    ]).then(([t, c, f, s, sub]) => {
      setRecurring({
        transactions: t.transactions, categories: c.categories,
        frequencies: f.frequencies ?? {}, splits: s.splits ?? {},
        cancelled: sub.cancelled ?? {},
      });
    }).catch(() => setRecurring(null));
  }, [budgetPath, refreshKey]);

  if (summary === null) return <DelayedLoader />;

  const v = budget?.variable;
  const hasAnything = summary.accountCount > 0
    || (summary.byCurrency?.length ?? 0) > 0
    || (v?.income ?? 0) > 0
    || (v?.committed ?? 0) > 0;

  if (!hasAnything) {
    return (
      <div className="overview-view">
        <h1>Overview</h1>
        <p className="blank">
          🏦 Nothing here yet — sync an account or add a hand-entered asset
          and Hon will start summarising your finances here.
        </p>
      </div>
    );
  }

  const essentials = (budget?.essentials ?? []).filter(
    (l) => (l.budget ?? 0) > 0 || l.spent > 0,
  );

  // Predicted fixed-this-cycle (same source as the Fixed bills tab) + posted
  // essentials. Falls back to the budget's posted committed total when the
  // recurring fetch failed or there is no detected fixed history yet.
  const predictedFixed = recurring
    ? expectedFixedThisCycle(detectMerchants(recurring).rows, settings.monthStartDay)
    : null;
  const committedDisplay = (v && predictedFixed !== null)
    ? predictedFixed + (v.essentialSpent ?? 0)
    : (v?.committed ?? 0);

  // This cycle's spend, grouped by category, for the donut + the budget card's
  // "Spent this month" total. Same card-bill / refund filter the Activity and
  // Insights tabs use, so the donut total reconciles with both. Falls back to
  // empty when the transactions fetch hasn't landed (or failed).
  const isExcluded = (t: Transaction): boolean => isExcludedFromCycle(t, {
    hideCardTotals: settings.hideCardTotals,
    cardProviders: settings.cardProviders,
  });
  const curKey = currentCycleKey(settings.monthStartDay);
  const spend = recurring
    ? buildPieCats(
        recurring.transactions, recurring.categories, settings.monthStartDay,
        isExcluded, curKey, prevCycleKey(curKey),
      )
    : { cats: [], total: 0, prevTotal: 0 };
  const spendChangePct = spend.prevTotal > 0
    ? ((spend.total - spend.prevTotal) / spend.prevTotal) * 100
    : null;

  return (
    <div className="overview-view">
      <h1>Overview</h1>
      <div className="ov-stack">
        {v && (
          <BalanceCard
            variable={v}
            committedDisplay={committedDisplay}
            currency={budget!.currency}
            companies={companies}
            accounts={accounts}
          />
        )}
        <NetWorthCard summary={summary} />
        {v && (
          <div className="ov-grid">
            <SpendingCard
              cats={spend.cats}
              total={spend.total}
              changePct={spendChangePct}
              transactions={recurring?.transactions ?? []}
              accounts={accounts}
              monthStartDay={settings.monthStartDay}
              isExcluded={isExcluded}
            />
            <BudgetCard
              variable={v}
              essentials={essentials}
              categories={recurring?.categories ?? []}
              predictedFixed={predictedFixed}
              totalSpent={spend.total}
              currency={budget!.currency}
              monthStartDay={settings.monthStartDay}
              onSaved={() => setRefreshKey((k) => k + 1)}
            />
          </div>
        )}
        <OwedToYouCard />
      </div>
    </div>
  );
}

function BalanceCard({
  variable, committedDisplay, currency, companies, accounts,
}: {
  variable: BudgetVariable;
  committedDisplay: number;
  currency: string;
  companies: Company[];
  accounts: Account[];
}) {
  const { income, spent } = variable;
  if (income <= 0 && committedDisplay <= 0 && spent <= 0) return null;
  const net = income - committedDisplay - spent;
  const positive = net >= 0;
  const cls = positive ? 'good' : 'bad';
  const sign = positive ? '+' : '−';
  const cap = positive
    ? 'free this month after fixed, essentials and variable spend so far'
    : "short of what this month's commitments need";
  return (
    <section className="card balance-card" data-testid="balance-card">
      <div className="balance-head">This month</div>
      <div className={`balance-num ${cls}`}>
        {sign}{money(Math.abs(net), currency)}
      </div>
      <div className="balance-cap">{cap}</div>
      <div className="balance-line">
        <span>Income</span> <b>{money(income, currency)}</b>
        <span className="balance-sep">−</span>
        <span>Expected fixed + essentials</span> <b>{money(committedDisplay, currency)}</b>
        {spent > 0 && (
          <>
            <span className="balance-sep">−</span>
            <span>Variable spent</span> <b>{money(spent, currency)}</b>
          </>
        )}
      </div>
      <BankProjection
        variable={variable}
        committedDisplay={committedDisplay}
        currency={currency}
        companies={companies}
        accounts={accounts}
      />
    </section>
  );
}

function BankProjection({
  variable, committedDisplay, currency, companies, accounts,
}: {
  variable: BudgetVariable;
  committedDisplay: number;
  currency: string;
  companies: Company[];
  accounts: Account[];
}) {
  // Hook must run before the early return below — money friends owe the user
  // (same-currency, positive) is incoming, so it lifts the end-of-cycle balance.
  const sw = useSplitwise();
  const bankCompanyIds = new Set(
    companies.filter((c) => c.type === 'bank').map((c) => c.id),
  );
  const bankAccounts = accounts.filter(
    (a) => !a.excluded && a.currency === 'ILS' && bankCompanyIds.has(a.companyId),
  );
  if (bankAccounts.length === 0) return null;

  const owed = sw.connected
    ? owedByFriend(sw.links)
        .filter((f) => f.currency === currency)
        .reduce((s, f) => s + f.owed, 0)
    : 0;
  const bankNow = bankAccounts.reduce((s, a) => s + (a.balance ?? 0), 0);
  const expectedIncome = variable.income;
  const fixedEss = committedDisplay; // predicted fixed-this-cycle + posted essentials
  const cycleVariable = variable.spent;
  const cyclePiggy = Math.max(0, variable.piggyFunded ?? 0);
  const change = expectedIncome - fixedEss - cycleVariable - cyclePiggy + owed;
  const endBalance = bankNow + change;
  const up = change >= 0;
  const sign = up ? '+' : '−';
  const dcls = up ? 'good' : 'bad';

  const Detail = ({ label, amount, tone }: {
    label: string; amount: number; tone: 'good' | 'bad';
  }) => {
    const dSign = amount === 0 ? '' : tone === 'good' ? '+' : '−';
    const toneClass = amount === 0 ? '' : tone;
    return (
      <div className="balance-detail">
        <span>{label}</span>
        <span className={`balance-detail-amt ${toneClass}`}>
          {dSign}{money(Math.abs(amount), currency)}
        </span>
      </div>
    );
  };

  return (
    <div className="balance-sub" data-testid="bank-projection">
      <div className="balance-sub-head">Projected bank balance at end of cycle</div>
      <div className="balance-sub-row">
        <div className="balance-sub-num">{money(endBalance, currency)}</div>
        <div className={`balance-sub-delta ${dcls}`}>
          {sign}{money(Math.abs(change), currency)}
        </div>
      </div>
      <div className="balance-details">
        <div className="balance-detail balance-detail-baseline">
          <span>Bank balance now</span>
          <span className={`balance-detail-amt ${bankNow >= 0 ? 'good' : 'bad'}`}>
            {money(bankNow, currency)}
          </span>
        </div>
        <Detail label="Income expected this cycle" amount={expectedIncome} tone="good" />
        {owed > 0 && (
          <Detail label="Owed to you (Splitwise)" amount={owed} tone="good" />
        )}
        <Detail label="Fixed + essentials this cycle" amount={fixedEss} tone="bad" />
        <Detail label="Variable spent so far" amount={cycleVariable} tone="bad" />
        <Detail label="Set asides (piggies)" amount={cyclePiggy} tone="bad" />
      </div>
    </div>
  );
}

// Emoji, label and allocation-bar colour for each net-worth source bucket.
// Ported verbatim from the legacy SPA's SOURCE_LABEL.
const SOURCE_LABEL: Record<string, [string, string, string]> = {
  bank: ['🏦', 'Bank accounts', '#3dcd84'],
  card: ['💳', 'Credit cards', '#f4685a'],
  brokerage: ['📈', 'Investments', '#7c83ff'],
  pension: ['🪺', 'Pension funds', '#ffd166'],
  'asset:car': ['🚗', 'Car', '#5fb0ff'],
  'asset:property': ['🏠', 'Property', '#f896c8'],
  'asset:cash': ['💵', 'Cash savings', '#74d0c2'],
  'asset:crypto': ['🪙', 'Crypto', '#ffb74d'],
  'asset:other': ['💎', 'Other assets', '#c2b3ff'],
  loan: ['📉', 'Loans', '#ff8aa1'],
};

function sourceMeta(key: string): [string, string, string] {
  const m = SOURCE_LABEL[key];
  return m ?? ['•', key, '#ffffff'];
}

/** "N accounts · M assets" — the synced-account + hand-entered-asset tally
 *  under the figure (matches the legacy SPA's netWorthSub). */
function netWorthSub(summary: Summary): string {
  const parts: string[] = [];
  const a = summary.accountCount || 0;
  const m = summary.manualAssetCount || 0;
  if (a) parts.push(`${a} account${a === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} asset${m === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'Nothing added yet';
}

function NetWorthCard({ summary }: { summary: Summary }) {
  const totals = (summary.byCurrency ?? []).slice().sort((a, b) =>
    a.currency === 'ILS' ? -1 : b.currency === 'ILS' ? 1 : b.total - a.total,
  );
  let headline: string;
  let negative = false;
  let chipTotals: CurrencyTotal[] = [];
  if (summary.netWorthILS != null) {
    headline = money(summary.netWorthILS, 'ILS');
    negative = summary.netWorthILS < 0;
    chipTotals = totals.length > 1 ? totals : [];
  } else if (totals[0]) {
    headline = money(totals[0].total, totals[0].currency);
    negative = totals[0].total < 0;
    chipTotals = totals.slice(1);
  } else {
    headline = '—';
  }

  // The breakdown only renders when the engine returns a combined ILS figure
  // (i.e. FX is up). Positive sources drive the allocation bar; debt rows show
  // a "—" share so the percentages stay honest.
  const sources = summary.netWorthILS != null ? (summary.sources ?? []) : [];
  const positiveTotal = sources
    .filter((s) => s.amount > 0)
    .reduce((sum, s) => sum + s.amount, 0);

  return (
    <section className="networth">
      <div className="label">Total net worth</div>
      <div className={`nw-total${negative ? ' neg' : ''}`}>{headline}</div>
      {chipTotals.length > 0 && (
        <div className="nw-chips">
          {chipTotals.map((t) => (
            <span key={t.currency} className="nw-chip">{money(t.total, t.currency)}</span>
          ))}
        </div>
      )}
      {positiveTotal > 0 && (
        <div className="nw-alloc">
          {sources.filter((s) => s.amount > 0).map((s) => {
            const [, name, color] = sourceMeta(s.key);
            return (
              <div
                key={s.key}
                className="nw-alloc-seg"
                style={{ width: `${(s.amount / positiveTotal) * 100}%`, background: color }}
                title={`${name} · ${money(s.amount, 'ILS')}`}
              />
            );
          })}
        </div>
      )}
      {sources.length > 0 && (
        <div className="nw-breakdown">
          {sources.map((s) => {
            const [emoji, name, color] = sourceMeta(s.key);
            const pct = s.amount > 0 && positiveTotal
              ? `${Math.round((s.amount / positiveTotal) * 100)}%`
              : '—';
            return (
              <div key={s.key} className="nw-bd-row">
                <span className="nw-bd-dot" style={{ background: color }} />
                <span className="nw-bd-ico">{emoji}</span>
                <span className="nw-bd-name">{name}</span>
                <span className={`nw-bd-amt${s.amount < 0 ? ' neg' : ''}`}>
                  {money(s.amount, 'ILS')}
                </span>
                <span className="nw-bd-pct">{pct}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="nw-sub">{netWorthSub(summary)}</div>
    </section>
  );
}
