import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from '../format';

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

interface BudgetResponse {
  currency: string;
  variable: BudgetVariable;
}

export function OverviewView() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [budget, setBudget] = useState<BudgetResponse | null>(null);

  useEffect(() => {
    Promise.all([
      api<Summary>('/summary'),
      api<BudgetResponse>('/budget'),
    ]).then(([s, b]) => {
      setSummary(s);
      setBudget(b);
    }).catch(() => {
      setSummary({ byCurrency: [], accountCount: 0, connectionCount: 0, netWorthILS: 0 });
      setBudget(null);
    });
  }, []);

  if (summary === null) return <p>Loading…</p>;

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

  return (
    <div className="overview-view">
      <h1>Overview</h1>
      <div className="ov-stack">
        {v && <BalanceCard variable={v} currency={budget!.currency} />}
        <NetWorthCard summary={summary} />
      </div>
    </div>
  );
}

function BalanceCard({ variable, currency }: { variable: BudgetVariable; currency: string }) {
  const { income, committed, spent } = variable;
  if (income <= 0 && committed <= 0 && spent <= 0) return null;
  const net = income - committed - spent;
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
        <span>Expected fixed + essentials</span> <b>{money(committed, currency)}</b>
        {spent > 0 && (
          <>
            <span className="balance-sep">−</span>
            <span>Variable spent</span> <b>{money(spent, currency)}</b>
          </>
        )}
      </div>
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
