import { cycleKey, prevCycleKey } from '../cycle';
import type { Transaction } from '../activity/types';

export interface CategoryAverages {
  /** Mean overall spending across qualifying cycles, or null if none. */
  avgSpending: number | null;
  /** Mean spending per category across qualifying cycles. */
  avgByCat: Map<string, number>;
}

/**
 * Trailing per-category spending averages over the `windowMonths` cycles
 * immediately BEFORE `displayedMonthKey`. A cycle qualifies only if its
 * overall spending is > 0, so empty pre-history months don't pull the mean
 * toward zero. Per-category means divide by the qualifying-cycle count.
 * Refund-fold, non-ILS, income, and `isExcluded` rows are dropped.
 */
export function categoryAverages(
  transactions: Transaction[],
  monthStartDay: number,
  isExcluded: (t: Transaction) => boolean,
  windowMonths: number,
  displayedMonthKey: string,
): CategoryAverages {
  const n = Math.max(1, Math.floor(windowMonths));

  const windowKeys = new Set<string>();
  let k = prevCycleKey(displayedMonthKey);
  for (let i = 0; i < n; i++) {
    windowKeys.add(k);
    k = prevCycleKey(k);
  }

  const overallByCycle = new Map<string, number>();
  const catByCycle = new Map<string, Map<string, number>>();
  for (const t of transactions) {
    if (t.currency !== 'ILS' || t.refundForId) continue;
    if (t.amount >= 0) continue;
    if (isExcluded(t)) continue;
    const key = cycleKey(t.date, monthStartDay);
    if (!windowKeys.has(key)) continue;
    const spent = -t.amount;
    overallByCycle.set(key, (overallByCycle.get(key) ?? 0) + spent);
    const cat = t.category || 'Other';
    let m = catByCycle.get(key);
    if (!m) { m = new Map(); catByCycle.set(key, m); }
    m.set(cat, (m.get(cat) ?? 0) + spent);
  }

  const qualifying = [...windowKeys].filter((key) => (overallByCycle.get(key) ?? 0) > 0);
  if (qualifying.length === 0) {
    return { avgSpending: null, avgByCat: new Map() };
  }

  let overallSum = 0;
  const catSums = new Map<string, number>();
  for (const key of qualifying) {
    overallSum += overallByCycle.get(key) ?? 0;
    const m = catByCycle.get(key);
    if (!m) continue;
    for (const [cat, amt] of m) catSums.set(cat, (catSums.get(cat) ?? 0) + amt);
  }

  const avgByCat = new Map<string, number>();
  for (const [cat, sum] of catSums) avgByCat.set(cat, sum / qualifying.length);

  return { avgSpending: overallSum / qualifying.length, avgByCat };
}
