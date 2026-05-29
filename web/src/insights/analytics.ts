import { cycleKey, currentCycleKey, prevCycleKey } from '../cycle';
import type { Transaction } from '../activity/types';

export interface MonthBucket {
  month: string;
  spending: number;
  income: number;
}

/** 12-month rolling cycle analytics — sums spending and income per cycle.
 *  Returns oldest → newest so the chart can render left-to-right with the
 *  current month on the far right. Non-ILS and refund-fold rows are always
 *  skipped; `isExcluded` lets the caller drop card-bill lump sums (and any
 *  manually-excluded txn) so Insights doesn't double-count the credit-card
 *  total on top of its itemised charges — the same filter the legacy app's
 *  cycleAnalytics applies via isCardTotal. */
export function cycleAnalytics(
  transactions: Transaction[],
  monthStartDay: number,
  isExcluded: (t: Transaction) => boolean = () => false,
): MonthBucket[] {
  const keys: string[] = [];
  let k = currentCycleKey(monthStartDay);
  for (let i = 0; i < 12; i++) {
    keys.unshift(k);
    k = prevCycleKey(k);
  }
  const agg = new Map<string, MonthBucket>();
  for (const key of keys) agg.set(key, { month: key, spending: 0, income: 0 });
  for (const t of transactions) {
    if (t.currency !== 'ILS') continue;
    if (t.refundForId) continue;
    if (isExcluded(t)) continue;
    const key = cycleKey(t.date, monthStartDay);
    const bucket = agg.get(key);
    if (!bucket) continue;
    if (t.amount < 0) bucket.spending += -t.amount;
    else bucket.income += t.amount;
  }
  return keys.map((key) => agg.get(key) ?? { month: key, spending: 0, income: 0 });
}
