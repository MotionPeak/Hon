import type { Repo } from './repo.js';

export interface MonthPoint {
  month: string; // "YYYY-MM"
  spending: number;
  income: number;
}

export interface CategorySlice {
  category: string;
  amount: number; // this month's spend
  changePct: number | null; // vs last month, null when no prior spend
}

export interface Analytics {
  currency: string;
  months: MonthPoint[]; // trailing 12, oldest first, zero-filled
  thisMonth: { spending: number; income: number };
  lastMonth: { spending: number; income: number };
  spendingChangePct: number | null;
  avgTransaction: number; // mean ILS expense over the trailing 12 months
  txnCount: number;
  byCategory: CategorySlice[]; // this month, descending by amount
}

const pad = (n: number): string => String(n).padStart(2, '0');
const firstOfMonth = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
const monthKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/**
 * Spending analytics for the Insights panel and Overview charts: a trailing
 * 12-month history, this-vs-last-month trend, average transaction, and a
 * per-category breakdown of the current month. ILS only — every transaction
 * Hon stores is ILS (brokerage syncs carry balances, not transactions).
 */
export function buildAnalytics(repo: Repo, cardProviders: string[] = []): Analytics {
  const now = new Date();
  const month = (offset: number) => new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const thisStart = firstOfMonth(month(0));
  const lastStart = firstOfMonth(month(-1));
  const nextStart = firstOfMonth(month(1));
  const windowStart = firstOfMonth(month(-11));

  // Trailing 12 months, zero-filled so the chart never has gaps.
  const rows = new Map(repo.monthlyTotals(windowStart, cardProviders).map((r) => [r.month, r]));
  const months: MonthPoint[] = [];
  for (let i = 11; i >= 0; i--) {
    const key = monthKey(month(-i));
    const row = rows.get(key);
    months.push({
      month: key,
      spending: row ? row.spending : 0,
      income: row ? row.income : 0,
    });
  }
  const thisMonth = months[11];
  const lastMonth = months[10];

  const lastCats = new Map(
    repo.categorySpending(lastStart, thisStart, cardProviders).map((c) => [c.category, c.total]),
  );
  const byCategory: CategorySlice[] = repo
    .categorySpending(thisStart, nextStart, cardProviders)
    .map((c) => {
      const prev = lastCats.get(c.category);
      return {
        category: c.category,
        amount: c.total,
        changePct: prev && prev > 0 ? ((c.total - prev) / prev) * 100 : null,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const stats = repo.expenseStats(windowStart, nextStart, cardProviders);

  return {
    currency: 'ILS',
    months,
    thisMonth: { spending: thisMonth.spending, income: thisMonth.income },
    lastMonth: { spending: lastMonth.spending, income: lastMonth.income },
    spendingChangePct:
      lastMonth.spending > 0
        ? ((thisMonth.spending - lastMonth.spending) / lastMonth.spending) * 100
        : null,
    avgTransaction: stats.avg,
    txnCount: stats.count,
    byCategory,
  };
}
