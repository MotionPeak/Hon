import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useSummary } from '../api/hooks/useSummary';
import { type Summary, type CurrencyTotal } from '@hon/shared/summary';
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
import { buildPieCats, savedThisCycle } from './spend';
import { SpendingCard } from './SpendingCard';
import { BudgetCard } from './BudgetCard';
import { projectBank, classifyAccounts, type ProjectionMode } from './bankProjection';
import { loadProjectionMode, saveProjectionMode } from './projectionMode';
import { projectVariable } from './projectedVariable';
import type { MerchantRow } from '../recurring/helpers';

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

/** Shown when the /summary fetch fails — the dashboard degrades to an empty
 *  net worth rather than spinning on the loader forever (matches the
 *  pre-Query catch that set a zeroed summary). */
const EMPTY_SUMMARY: Summary = {
  connectionCount: 0, accountCount: 0, manualAssetCount: 0, voucherCount: 0,
  byCurrency: [], netWorthILS: 0, sources: [],
};

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
  const summaryQuery = useSummary();
  const summary: Summary | null =
    summaryQuery.data ?? (summaryQuery.isError ? EMPTY_SUMMARY : null);
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
    // Guard against a stale response overwriting fresher state: when the cycle
    // window or refreshKey changes mid-flight, this effect re-runs and the prior
    // run's `ignore` flips true so its late `.then` is a no-op.
    let ignore = false;

    Promise.all([
      api<BudgetResponse>(budgetPath),
      api<{ companies: Company[] }>('/companies').catch(() => ({ companies: [] })),
      api<{ accounts: Account[] }>('/accounts').catch(() => ({ accounts: [] })),
    ]).then(([b, c, a]) => {
      if (ignore) return;
      setBudget(b);
      setCompanies(c.companies ?? []);
      setAccounts(a.accounts ?? []);
    }).catch(() => {
      if (ignore) return;
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
      api<{ splits: Record<string, number>; shareAmounts: Record<string, number> }>('/category-splits'),
      api<{ cancelled: Record<string, string> }>('/subscriptions/cancelled')
        .catch(() => ({ cancelled: {} as Record<string, string> })),
    ]).then(([t, c, f, s, sub]) => {
      if (ignore) return;
      setRecurring({
        transactions: t.transactions, categories: c.categories,
        frequencies: f.frequencies ?? {}, splits: s.splits ?? {},
        shareAmounts: s.shareAmounts ?? {},
        cancelled: sub.cancelled ?? {},
      });
    }).catch(() => {
      if (ignore) return;
      setRecurring(null);
    });

    return () => { ignore = true; };
  }, [budgetPath, refreshKey]);

  // This cycle's spend (donut + "Spent this month") and savings tally. Memoized
  // so an unrelated re-render doesn't re-scan the whole transaction array 3x.
  // Hoisted above the early return to keep hook order stable.
  const { spend, saved } = useMemo(() => {
    const ck = currentCycleKey(settings.monthStartDay);
    const excluded = (t: Transaction): boolean => isExcludedFromCycle(t, {
      hideCardTotals: settings.hideCardTotals,
      cardProviders: settings.cardProviders,
    });
    if (!recurring) return { spend: { cats: [], total: 0, prevTotal: 0 }, saved: 0 };
    return {
      spend: buildPieCats(
        recurring.transactions, recurring.categories, settings.monthStartDay,
        excluded, ck, prevCycleKey(ck),
      ),
      saved: savedThisCycle(recurring.transactions, ck, settings.monthStartDay),
    };
  }, [recurring, settings.monthStartDay, settings.hideCardTotals, settings.cardProviders]);

  // Predicted fixed-this-cycle (same source as the Fixed bills tab). Null when
  // the recurring fetch failed, there's no detected history yet, or the user
  // turned projection off — driving the headline, BudgetCard and bank
  // projection back to posted figures so the master switch is honoured
  // everywhere. Memoized so it doesn't re-run the merchant rollup each render.
  const predictedFixed = useMemo(
    () =>
      recurring && settings.projectRecurring
        ? expectedFixedThisCycle(
            detectMerchants(recurring, settings.monthStartDay).rows, settings.monthStartDay,
          )
        : null,
    [recurring, settings.monthStartDay, settings.projectRecurring],
  );

  // Recurring rows (override-aware) for the bank projection's "fixed due" term.
  const merchantRows = useMemo(
    () => (recurring ? detectMerchants(recurring, settings.monthStartDay).rows : []),
    [recurring, settings.monthStartDay],
  );

  // The variable allowance still "left to spend" (the Budget card's figure);
  // the projection reserves it only in "+ Variable budget" mode.
  const variableLeftToSpend = useMemo(() => {
    const vv = budget?.variable;
    if (!vv) return 0;
    const ess = (budget?.essentials ?? []).filter((l) => (l.budget ?? 0) > 0 || l.spent > 0);
    const essTotal = ess.reduce((s, l) => s + (l.budget ?? 0), 0);
    const pv = projectVariable(
      {
        income: vv.income, spent: vv.spent, essentialSpent: vv.essentialSpent,
        fixedSpent: vv.fixedSpent, piggyFunded: vv.piggyFunded, savings: vv.savings,
      },
      essTotal, predictedFixed, settings.projectRecurring,
    );
    return Math.max(0, pv.allowed);
  }, [budget, predictedFixed, settings.projectRecurring]);

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

  // Headline "Expected fixed + essentials": the memoized predicted fixed plus
  // posted essentials. Falls back to the budget's posted committed total when
  // predictedFixed is null — i.e. the recurring fetch failed, there is no
  // detected fixed history yet, or the user turned projection off in Settings.
  const committedDisplay = (v && predictedFixed !== null)
    ? predictedFixed + (v.essentialSpent ?? 0)
    : (v?.committed ?? 0);

  // Same card-bill / refund filter the Activity and Insights tabs use, so the
  // donut total reconciles with both. (spend + saved are computed in the memo
  // above; this predicate is also passed to the donut.)
  const isExcluded = (t: Transaction): boolean => isExcludedFromCycle(t, {
    hideCardTotals: settings.hideCardTotals,
    cardProviders: settings.cardProviders,
  });
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
            transactions={recurring?.transactions ?? []}
            rows={merchantRows}
            monthStartDay={settings.monthStartDay}
            variableLeftToSpend={variableLeftToSpend}
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
              projectRecurring={settings.projectRecurring}
              totalSpent={spend.total}
              currency={budget!.currency}
              monthStartDay={settings.monthStartDay}
              onSaved={() => setRefreshKey((k) => k + 1)}
            />
          </div>
        )}
        {saved > 0 && (
          <div className="ov-saved" data-testid="saved-this-cycle">
            <span className="ov-saved-ico">💰</span>
            <span className="ov-saved-label">Saved this cycle</span>
            <span className="ov-saved-amt">{money(saved, 'ILS')}</span>
          </div>
        )}
        <OwedToYouCard />
      </div>
    </div>
  );
}

function BalanceCard({
  variable, committedDisplay, currency, companies, accounts, transactions, rows,
  monthStartDay, variableLeftToSpend,
}: {
  variable: BudgetVariable;
  committedDisplay: number;
  currency: string;
  companies: Company[];
  accounts: Account[];
  transactions: Transaction[];
  rows: MerchantRow[];
  monthStartDay: number;
  variableLeftToSpend: number;
}) {
  const sw = useSplitwise();
  const [mode, setMode] = useState<ProjectionMode>(loadProjectionMode());
  const setModePersist = (m: ProjectionMode) => { setMode(m); saveProjectionMode(m); };

  const { income, spent } = variable;
  // All hooks are above; these guards are safe below them.
  if (income <= 0 && committedDisplay <= 0 && spent <= 0) return null;

  const bankCompanyIds = new Set(
    companies.filter((c) => c.type === 'bank').map((c) => c.id),
  );
  const bankAccounts = accounts.filter(
    (a) => !a.excluded && a.currency === 'ILS' && bankCompanyIds.has(a.companyId),
  );
  const owed = sw.connected
    ? owedByFriend(sw.links).filter((f) => f.currency === currency).reduce((s, f) => s + f.owed, 0)
    : 0;
  const freeNet = income - committedDisplay - spent;

  // No bank balance to project from → keep the legacy "free this month" hero so
  // the card still says something useful.
  if (bankAccounts.length === 0) {
    const positive = freeNet >= 0;
    return (
      <section className="card balance-card" data-testid="balance-card">
        <div className="balance-head">This month</div>
        <div className={`balance-num ${positive ? 'good' : 'bad'}`}>
          {positive ? '+' : '−'}{money(Math.abs(freeNet), currency)}
        </div>
        <div className="balance-cap">
          free this month after fixed, essentials and variable spend so far
        </div>
      </section>
    );
  }

  const bankNow = bankAccounts.reduce((s, a) => s + (a.balance ?? 0), 0);
  // PRECONDITION of projectBank: exclude transactions from excluded accounts.
  const excludedIds = new Set(accounts.filter((a) => a.excluded).map((a) => a.id));
  const proj = projectBank({
    transactions: transactions.filter((t) => !excludedIds.has(t.accountId)),
    accountType: classifyAccounts(accounts, companies),
    bankNow,
    expectedIncome: income,
    owed,
    piggies: Math.max(0, variable.piggyFunded ?? 0),
    variableLeftToSpend,
    rows,
    monthStartDay,
    mode,
  });

  return (
    <section className="card balance-card" data-testid="balance-card">
      <div className="balance-head">Projected checking balance</div>
      <div className={`balance-num ${proj.futureBank >= 0 ? 'good' : 'bad'}`}>
        {money(proj.futureBank, currency)}
      </div>
      <div className="balance-cap">after income lands &amp; this cycle's bills clear</div>

      <div className="proj-picker" role="tablist" data-testid="projection-picker">
        <button
          type="button" role="tab" aria-selected={mode === 'committed'}
          className={`proj-tab${mode === 'committed' ? ' on' : ''}`}
          onClick={() => setModePersist('committed')}
        >Committed</button>
        <button
          type="button" role="tab" aria-selected={mode === 'budget'}
          className={`proj-tab${mode === 'budget' ? ' on' : ''}`}
          onClick={() => setModePersist('budget')}
        >+ Variable budget</button>
      </div>

      <div className="balance-details" data-testid="bank-projection">
        <div className="balance-detail balance-detail-baseline">
          <span>Bank balance now</span>
          <span className={`balance-detail-amt ${bankNow >= 0 ? 'good' : 'bad'}`}>
            {money(bankNow, currency)}
          </span>
        </div>
        <Detail label="Income still expected" amount={proj.incomeStillExpected} tone="good" currency={currency} />
        {owed > 0 && <Detail label="Owed to you (Splitwise)" amount={owed} tone="good" currency={currency} />}
        <Detail label="Fixed + essentials still due" amount={proj.fixedDueNotYetPosted} tone="bad" currency={currency} />
        <Detail label="Card spend still to bill" amount={proj.cardSpendThisCycle} tone="bad" currency={currency} />
        {mode === 'budget' && (
          <Detail label="Variable budget left" amount={proj.variableLeftToSpend} tone="bad" currency={currency} />
        )}
        <Detail label="Set-asides (piggies)" amount={proj.piggies} tone="bad" currency={currency} />
      </div>

      <div className="balance-free">
        <span>Free to spend this month</span>
        <span className={freeNet >= 0 ? 'good' : 'bad'}>
          {freeNet >= 0 ? '+' : '−'}{money(Math.abs(freeNet), currency)}
        </span>
      </div>
    </section>
  );
}

function Detail({ label, amount, tone, currency }: {
  label: string; amount: number; tone: 'good' | 'bad'; currency: string;
}) {
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
