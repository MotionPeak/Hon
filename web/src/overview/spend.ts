import { cycleKey } from '../cycle';
import type { Transaction } from '../activity/types';
import type { Category } from '../settings/CategoriesPanel';

/** The default chip + colour for a category with no matching row in the
 *  categories table — mirrors the legacy SPA's DEFAULT_CATEGORY_STYLE. */
const DEFAULT_COLOR = '#8C8FA8';
const DEFAULT_EMOJI = '🏷️';

export interface CycleSpend {
  total: number;
  byCat: Map<string, number>;
}

export interface PieCat {
  category: string;
  amount: number;
  /** % change vs the same category last cycle; null when there was no prior
   *  spend to compare against. */
  changePct: number | null;
  color: string;
  emoji: string;
}

/**
 * Total + per-category ILS expense for one billing cycle. Mirrors the legacy
 * SPA's `cycleSpending`: ILS only, refund-fold rows skipped, card-bill /
 * manually-excluded rows dropped via `isExcluded`, and income (amount >= 0)
 * ignored. Computing it the same way the Activity and Insights tabs do means
 * the donut total reconciles with the budget card's "Spent this month".
 */
export function categorySpend(
  transactions: Transaction[],
  key: string,
  monthStartDay: number,
  isExcluded: (t: Transaction) => boolean,
): CycleSpend {
  const byCat = new Map<string, number>();
  let total = 0;
  for (const t of transactions) {
    if (t.currency !== 'ILS') continue;
    if (t.refundForId) continue;
    if (isExcluded(t)) continue;
    if (cycleKey(t.date, monthStartDay) !== key) continue;
    if (t.amount >= 0) continue; // income / zero rows never count as spend
    const spent = -t.amount;
    total += spent;
    const c = t.category || 'Uncategorized';
    byCat.set(c, (byCat.get(c) ?? 0) + spent);
  }
  return { total, byCat };
}

/**
 * Sorted spend-by-category for the current cycle, each row carrying its colour,
 * emoji and month-over-month change — the exact shape the donut slices and the
 * legend rows render from. Biggest spender first (largest slice leads).
 */
export function buildPieCats(
  transactions: Transaction[],
  categories: Category[],
  monthStartDay: number,
  isExcluded: (t: Transaction) => boolean,
  currentKey: string,
  prevKey: string,
): { cats: PieCat[]; total: number; prevTotal: number } {
  const cur = categorySpend(transactions, currentKey, monthStartDay, isExcluded);
  const prev = categorySpend(transactions, prevKey, monthStartDay, isExcluded);
  const styleByName = new Map<string, Category>();
  for (const c of categories) styleByName.set(c.name, c);

  const cats: PieCat[] = Array.from(cur.byCat.entries())
    .map(([category, amount]) => {
      const pv = prev.byCat.get(category);
      const style = styleByName.get(category);
      return {
        category,
        amount,
        changePct: pv && pv > 0 ? ((amount - pv) / pv) * 100 : null,
        color: style?.color || DEFAULT_COLOR,
        emoji: style?.emoji || DEFAULT_EMOJI,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  return { cats, total: cur.total, prevTotal: prev.total };
}
