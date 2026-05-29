/**
 * Returns the earliest transaction date across the supplied scoped account
 * set, or null when no in-scope transactions exist.
 *
 * Used by the brokerage chart to cap the ALL range at the user's first known
 * transaction so the chart doesn't paint years of pretend pre-ownership Yahoo
 * backfill for accounts that lack an explicit inceptionDate.
 */
export function earliestTxnDate(
  transactions: { date: string | null | undefined; accountId: string }[],
  scopedAcctIds: Set<string>,
): string | null {
  let first: string | null = null;
  for (const t of transactions) {
    if (!scopedAcctIds.has(t.accountId)) continue;
    if (!t.date) continue;
    if (first === null || t.date < first) first = t.date;
  }
  return first;
}
