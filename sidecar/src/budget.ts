import type { Repo } from './repo.js';
import { settlePiggyBanks, type PiggyReport } from './piggy.js';

export interface BudgetLine {
  category: string;
  budget: number | null;
  spent: number;
}

/**
 * The discretionary "variable" budget is never set by hand. It is whatever the
 * month's incoming money leaves once fixed bills and essential spending are
 * covered. `allowed` is that headroom minus the variable spending already made,
 * so it shrinks through the month and turns negative once outgoings outpace
 * income — the point at which there is no room left for variable spending.
 */
export interface VariableBudget {
  spent: number;
  income: number;
  fixedSpent: number;
  essentialSpent: number;
  committed: number; // fixedSpent + essentialSpent
  piggyFunded: number; // set aside into piggy banks this month — also an expense
  disposable: number; // income - committed - piggyFunded
  allowed: number; // disposable - spent (may be negative)
}

export interface BudgetReport {
  month: string; // "YYYY-MM"
  currency: string;
  essentials: BudgetLine[];
  variable: VariableBudget;
  piggy: PiggyReport;
  totalBudget: number;
  totalSpent: number;
  categorized: number;
  total: number;
}

// Day-to-day "essential" categories each keep an individual monthly budget.
// The discretionary categories below pool into the computed variable
// allowance; every other category is a recurring "fixed" bill — tracked, but
// never budgeted.
const ESSENTIAL_CATEGORIES = ['Groceries', 'Dining', 'Transport', 'Fuel', 'Health'];
export const VARIABLE_CATEGORIES = [
  'Shopping', 'Entertainment', 'Travel', 'Other', 'Transfers', 'Income',
];

const pad = (n: number): string => String(n).padStart(2, '0');

/** A spending window [start, end) — ISO date strings — with a "YYYY-MM" label. */
export interface MonthRange {
  start: string;
  end: string;
  label: string;
}

/** ISO date bounds [start, end) for the current calendar month. */
export function currentMonthRange(): MonthRange {
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

/**
 * The recurring projection the web app derives client-side: expected income
 * averaged over recent cycles and fixed bills smoothed to a monthly-equivalent.
 * When present, piggy-bank set-asides are settled against it rather than the
 * actual money in so far — so a bank is not paused merely because this month's
 * salary has not landed yet.
 */
export interface BudgetProjection {
  expectedIncome?: number;
  expectedFixed?: number;
}

/**
 * Combines budgets with the spending inside `range` — the user's billing cycle
 * when supplied, otherwise the calendar month. Essential categories each keep
 * their own budget line; fixed bills are summed but not budgeted; the variable
 * allowance is derived from income minus fixed and essential spending.
 */
export function buildBudgetReport(
  repo: Repo,
  range: MonthRange = currentMonthRange(),
  projection?: BudgetProjection,
): BudgetReport {
  const { start, end, label } = range;
  const budgets = new Map(repo.listBudgets().map((b) => [b.category, b.monthlyAmount]));
  const spending = new Map(
    repo.monthlySpending(start, end).map((s) => [s.category, s.total]),
  );

  // Split this month's expenses into the three umbrellas.
  let essentialSpent = 0;
  let variableSpent = 0;
  let fixedSpent = 0;
  for (const [category, total] of spending) {
    if (ESSENTIAL_CATEGORIES.includes(category)) essentialSpent += total;
    else if (VARIABLE_CATEGORIES.includes(category)) variableSpent += total;
    else fixedSpent += total;
  }

  // Essentials: one budgeted line per category with a limit or any spend.
  const essentials: BudgetLine[] = ESSENTIAL_CATEGORIES.filter(
    (c) => budgets.has(c) || (spending.get(c) ?? 0) > 0,
  )
    .map((category) => ({
      category,
      budget: budgets.get(category) ?? null,
      spent: spending.get(category) ?? 0,
    }))
    .sort((a, b) => b.spent - a.spent);

  const income = repo.monthlyInflow(start, end);
  const committed = fixedSpent + essentialSpent;

  // Piggy-bank set-asides draw from whatever income is left after the month's
  // fixed bills and essentials, ahead of discretionary spending. Each funded
  // bank is a committed expense; one that does not fit is paused for the month.
  // When the web app supplies a recurring projection, the saving room is the
  // expected income and smoothed fixed bills — so a bank is not paused early in
  // the month just because the salary has not arrived yet.
  const useProjection =
    projection !== undefined &&
    (projection.expectedIncome !== undefined || projection.expectedFixed !== undefined);
  const piggyIncome = projection?.expectedIncome ?? income;
  const piggyFixed = projection?.expectedFixed ?? fixedSpent;
  const piggy = settlePiggyBanks(
    repo,
    piggyIncome - piggyFixed - essentialSpent,
    label,
    useProjection,
  );

  const disposable = income - committed - piggy.fundedTotal;
  const variable: VariableBudget = {
    spent: variableSpent,
    income,
    fixedSpent,
    essentialSpent,
    committed,
    piggyFunded: piggy.fundedTotal,
    disposable,
    allowed: disposable - variableSpent,
  };

  let totalBudget = 0;
  for (const line of essentials) totalBudget += line.budget ?? 0;

  const counts = repo.categorizationCounts();
  return {
    month: label,
    currency: 'ILS',
    essentials,
    variable,
    piggy,
    totalBudget,
    totalSpent: essentialSpent + variableSpent + fixedSpent,
    categorized: counts.categorized,
    total: counts.total,
  };
}
