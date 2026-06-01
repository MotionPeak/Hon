import type { HoldingSnapshot, SeriesPoint, Convert } from './equitySeries';

/** Per-holding value series: sums one symbol's daily value across the given
 *  accounts, clips each account's points before its inception date, and
 *  converts each point to the display currency. Faithful port of the legacy
 *  SPA's buildHoldingSeries. Points the converter returns null for (unknown
 *  FX rate) are dropped. */
export function buildHoldingSeries(
  snapshots: HoldingSnapshot[],
  symbol: string,
  accountIds: string[],
  convert: Convert,
  fallbackCurrency: string,
  inceptionByAccount: Record<string, string>,
): SeriesPoint[] {
  const ids = new Set(accountIds);
  const byDate = new Map<string, number>();
  for (const s of snapshots) {
    if (s.symbol !== symbol || !ids.has(s.accountId)) continue;
    const cap = inceptionByAccount[s.accountId];
    if (cap && s.date < cap) continue;
    const v = convert(s.value, s.currency || fallbackCurrency);
    // convertAmount returns null for an unknown/unavailable FX rate; drop the
    // point so the sparkline omits unconvertible values rather than pricing
    // them 1:1 with ILS.
    if (v == null) continue;
    byDate.set(s.date, (byDate.get(s.date) ?? 0) + v);
  }
  return [...byDate.keys()]
    .sort()
    .map((date) => ({ date, value: byDate.get(date)! }));
}
