import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from '../format';
import type { Account, Company } from '../accounts/types';
import { DelayedLoader } from '../ui/DelayedLoader';
import { useSettings } from '../settings/useSettings';
import type { Transaction } from '../activity/types';
import type { Category } from '../settings/CategoriesPanel';
import {
  detectMerchants, expectedFixedThisCycle,
  type FreqOrIgnore, type RecurringData,
} from '../recurring/helpers';
import { useSplitwise } from '../splitwise/useSplitwise';
import { OwedToYouCard } from './OwedToYouCard';

/**
 * Builds the `/budget` path with the card-bill exclusion list as repeated
 * `?cardProvider=` params. Bank-side credit-card bill lump sums (e.g. the
 * monthly "מקס איט פיננסים" debit) are already itemised under the card
 * account, so counting them again on the bank side double-counts spending.
 * The engine drops them only when these params are present — the same
 * contract Insights, Activity, and the legacy SPA already use.
 */
function budgetPathFor(cardProviders: string[]): string {
  if (cardProviders.length === 0) return '/budget';
  const qs = cardProviders
    .map((p) => `cardProvider=${encodeURIComponent(p)}`)
    .join('&');
  return `/budget?${qs}`;
}

interface CurrencyTotal { currency: string; total: number; accountCount: number }

interface Summary {
  byCurrency: CurrencyTotal[];
  accountCount: number;
  connectionCount: number;
  netWorthILS: number | null;
  breakdown?: Record<string, Record<string, number>>;
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

  // A plain string, stable by VALUE across renders (same providers → same
  // path), so the effect refetches only when the exclusion list actually
  // changes — not on every re-render an array dependency would trigger.
  const budgetPath = budgetPathFor(
    settings.hideCardTotals ? settings.cardProviders : [],
  );

  useEffect(() => {
    Promise.all([
      api<Summary>('/summary'),
      api<BudgetResponse>(budgetPath),
      api<{ companies: Company[] }>('/companies').catch(() => ({ companies: [] })),
      api<{ accounts: Account[] }>('/accounts').catch(() => ({ accounts: [] })),
    ]).then(([s, b, c, a]) => {
      setSummary(s);
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
      api<{ cancelled: Record<string, boolean> }>('/subscriptions/cancelled')
        .catch(() => ({ cancelled: {} as Record<string, boolean> })),
    ]).then(([t, c, f, s, sub]) => {
      setRecurring({
        transactions: t.transactions, categories: c.categories,
        frequencies: f.frequencies ?? {}, splits: s.splits ?? {},
        cancelled: sub.cancelled ?? {},
      });
    }).catch(() => setRecurring(null));
  }, [budgetPath]);

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
        {essentials.length > 0 && (
          <EssentialsCard essentials={essentials} currency={budget!.currency} />
        )}
        <NetWorthCard summary={summary} />
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
    ? sw.friends
        .flatMap((f) => f.balances)
        .filter((b) => b.currency === currency && b.amount > 0)
        .reduce((s, b) => s + b.amount, 0)
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

function EssentialsCard({
  essentials, currency,
}: {
  essentials: BudgetLine[];
  currency: string;
}) {
  const sorted = essentials.slice().sort((a, b) => b.spent - a.spent);
  return (
    <section className="card essentials-card" data-testid="essentials-card">
      <div className="ess-head">Essentials</div>
      <ul className="ess-list">
        {sorted.map((l) => {
          const budget = l.budget ?? 0;
          const over = budget > 0 && l.spent > budget;
          const pct = budget > 0
            ? Math.min(100, Math.round((l.spent / budget) * 100))
            : 0;
          return (
            <li key={l.category} className={`ess-row${over ? ' over' : ''}`}>
              <div className="ess-row-head">
                <span className="ess-cat">{l.category}</span>
                <span className="ess-nums">
                  <b>{money(l.spent, currency)}</b>
                  {budget > 0 && <span className="ess-budget"> / {money(budget, currency)}</span>}
                </span>
              </div>
              {budget > 0 && (
                <div className="ess-bar">
                  <div
                    className={`ess-bar-fill${over ? ' over' : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
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
  return (
    <section className="card networth">
      <div className="label">Total net worth</div>
      <div className={`nw-total${negative ? ' neg' : ''}`}>{headline}</div>
      {chipTotals.length > 0 && (
        <div className="nw-chips">
          {chipTotals.map((t) => (
            <span key={t.currency} className="nw-chip">
              {money(t.total, t.currency)}
            </span>
          ))}
        </div>
      )}
      <div className="nw-sub">
        Across {summary.accountCount} account{summary.accountCount === 1 ? '' : 's'}
        {summary.connectionCount > 0 && (
          <> · {summary.connectionCount} connection{summary.connectionCount === 1 ? '' : 's'}</>
        )}
      </div>
    </section>
  );
}
