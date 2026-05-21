import type { Repo } from './repo.js';

export interface BudgetLine {
  category: string;
  budget: number | null;
  spent: number;
}

export interface BudgetReport {
  month: string; // "YYYY-MM"
  currency: string;
  lines: BudgetLine[];
  totalBudget: number;
  totalSpent: number;
  categorized: number;
  total: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** ISO date bounds [start, end) for the current calendar month. */
export function currentMonthRange(): { start: string; end: string; label: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  return {
    start: `${year}-${pad(month + 1)}-01`,
    end: `${nextYear}-${pad(nextMonth + 1)}-01`,
    label: `${year}-${pad(month + 1)}`,
  };
}

/** Combines budgets with this month's spending into a per-category report. */
export function buildBudgetReport(repo: Repo): BudgetReport {
  const { start, end, label } = currentMonthRange();
  const budgets = new Map(repo.listBudgets().map((b) => [b.category, b.monthlyAmount]));
  const spending = new Map(repo.monthlySpending(start, end).map((s) => [s.category, s.total]));

  const categories = new Set<string>([...budgets.keys(), ...spending.keys()]);
  const lines: BudgetLine[] = [...categories]
    .map((category) => ({
      category,
      budget: budgets.get(category) ?? null,
      spent: spending.get(category) ?? 0,
    }))
    .sort((a, b) => b.spent - a.spent);

  let totalBudget = 0;
  for (const amount of budgets.values()) totalBudget += amount;
  let totalSpent = 0;
  for (const value of spending.values()) totalSpent += value;

  const counts = repo.categorizationCounts();
  return {
    month: label,
    currency: 'ILS',
    lines,
    totalBudget,
    totalSpent,
    categorized: counts.categorized,
    total: counts.total,
  };
}
