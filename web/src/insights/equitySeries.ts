// Brokerage equity-over-time series builder. Faithful port of the legacy
// SPA's buildEquitySeries() + sliceRange() (sidecar/public/app.html
// ~6387-6544). React previously summed only the local `snapshots` table,
// which holds ~days of history — so the chart showed a flat week while the
// legacy chart spanned a year. This restores the 3-tier resolution:
//
//   1. performance.totalEquity — the broker's own reported equity timeline
//      (SnapTrade reports, Meitav GetTsuot). Connection-scoped; the bulk of
//      real long-range history. If ANY performance points exist, they win.
//   2. holdingSnapshots — per-(account,symbol) price-history backfill
//      (Yahoo/Maya), forward-filled so a missing day doesn't tank the total.
//   3. snapshots — Hon's per-sync account-level fallback.
//
// Every tier applies the same inception clip: when an account has a pinned
// inceptionDate, points before it are dropped so "ALL" doesn't paint pretend
// pre-ownership history.

export interface EquityAccount {
  id: string;
  connectionId: string;
  inceptionDate: string | null;
}

export interface BrokerageRangeStats {
  rateOfReturn: number | null;
  dividendIncome: number | null;
  contributions: number | null;
}

export interface PerformanceEntry {
  connectionId: string;
  /** When the engine last fetched this — already on the wire from
   *  repo.listBrokeragePerformance(); now typed for client use. */
  fetchedAt?: string;
  data: {
    totalEquity: { date: string; value: number; currency?: string }[];
    currency?: string;
    rateOfReturn?: number | null;
    dividendIncome?: number | null;
    byRange?: Record<string, BrokerageRangeStats>;
  };
}

export interface ValueSnapshot {
  accountId: string;
  date: string;
  value: number;
  currency: string;
}

export interface HoldingSnapshot {
  accountId: string;
  symbol: string;
  date: string;
  value: number;
  currency: string;
}

export interface SeriesPoint {
  date: string;
  value: number;
}

/** Converts a native-currency amount into the display currency. Returns the
 *  converted number, or null to skip the point (unknown rate). */
export type Convert = (value: number, currency: string) => number | null;

export interface BuildEquityInput {
  performance: PerformanceEntry[];
  snapshots: ValueSnapshot[];
  holdingSnapshots: HoldingSnapshot[];
  accounts: EquityAccount[];
  /** 'all' or a specific account id. */
  acctFilter: 'all' | string;
  convert: Convert;
}

/** Builds the equity-over-time series for the brokerage chart, resolving the
 *  best available data source per the 3-tier fallback above and scoping to
 *  the selected account when one is focused. */
export function buildEquitySeries(input: BuildEquityInput): SeriesPoint[] {
  const { performance, snapshots, holdingSnapshots, accounts, acctFilter, convert } = input;
  const focusedAcctId = acctFilter === 'all' ? null : acctFilter;
  const focusedAccount = focusedAcctId
    ? accounts.find((a) => a.id === focusedAcctId) ?? null
    : null;
  const focusedInception = focusedAccount?.inceptionDate ?? null;

  // Per-connection earliest inception across that connection's accounts —
  // used for the "all accounts" view so a multi-account portfolio shows the
  // full joint history.
  const earliestByConn = new Map<string, string>();
  for (const a of accounts) {
    if (!a.inceptionDate) continue;
    const cur = earliestByConn.get(a.connectionId);
    if (!cur || a.inceptionDate < cur) earliestByConn.set(a.connectionId, a.inceptionDate);
  }
  // When filtered, EVERY branch uses the focused account's own inception
  // (or null) — a sibling's earlier inception must not lend history to a
  // younger account on the same connection.
  const inceptionFor = (connectionId: string): string | null =>
    focusedAcctId ? focusedInception : (earliestByConn.get(connectionId) ?? null);

  // Scope inputs to the focused account. Performance is connection-keyed, so
  // a filtered view keeps any report whose connection owns the focused acct.
  const scopedPerf = acctFilter === 'all'
    ? performance
    : performance.filter((p) =>
        accounts.some((a) => a.id === acctFilter && a.connectionId === p.connectionId));
  const scopedHoldSnaps = acctFilter === 'all'
    ? holdingSnapshots
    : holdingSnapshots.filter((s) => s.accountId === acctFilter);
  const scopedSnaps = acctFilter === 'all'
    ? snapshots
    : snapshots.filter((s) => s.accountId === acctFilter);

  // --- Tier 1: broker-reported performance timeline ----------------------
  const fromPerf = new Map<string, number>();
  let havePerformance = false;
  for (const p of scopedPerf) {
    const pts = p.data?.totalEquity ?? [];
    if (pts.length) havePerformance = true;
    const pcur = p.data?.currency ?? 'USD';
    const inception = inceptionFor(p.connectionId);
    for (const pt of pts) {
      if (inception && pt.date < inception) continue;
      const v = convert(pt.value, pt.currency ?? pcur);
      if (v == null) continue;
      fromPerf.set(pt.date, (fromPerf.get(pt.date) ?? 0) + v);
    }
  }
  const brokerSeries: SeriesPoint[] = havePerformance
    ? [...fromPerf.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, value]) => ({ date, value }))
    : [];

  // --- Tier 2: per-holding snapshots, forward-filled ---------------------
  let snapshotSeries: SeriesPoint[] = [];
  if (scopedHoldSnaps.length) {
    const acctIdsInSeries = new Set(scopedHoldSnaps.map((s) => s.accountId));
    const inceptionDates = accounts
      .filter((a) => acctIdsInSeries.has(a.id) && a.inceptionDate)
      .map((a) => a.inceptionDate as string);
    const earliestRealSnap = inceptionDates.length
      ? inceptionDates.reduce((m, d) => (d < m ? d : m), inceptionDates[0]!)
      : null;

    const bySym = new Map<string, SeriesPoint[]>();
    for (const s of scopedHoldSnaps) {
      const v = convert(s.value, s.currency);
      if (v == null) continue;
      const k = `${s.accountId}:${s.symbol}`;
      const arr = bySym.get(k) ?? [];
      arr.push({ date: s.date, value: v });
      bySym.set(k, arr);
    }
    const keys = [...bySym.keys()];
    for (const k of keys) bySym.get(k)!.sort((a, b) => a.date.localeCompare(b.date));
    const dateSet = new Set<string>();
    for (const k of keys) for (const p of bySym.get(k)!) dateSet.add(p.date);
    const dates = [...dateSet]
      .sort()
      .filter((d) => earliestRealSnap == null || d >= earliestRealSnap);
    const cursor = new Map<string, number>();
    for (const k of keys) cursor.set(k, 0);
    const out: SeriesPoint[] = [];
    for (const d of dates) {
      let sum = 0;
      let any = false;
      for (const k of keys) {
        const arr = bySym.get(k)!;
        let ci = cursor.get(k)!;
        while (ci + 1 < arr.length && arr[ci + 1]!.date <= d) ci += 1;
        cursor.set(k, ci);
        if (arr[ci]!.date <= d) { sum += arr[ci]!.value; any = true; }
      }
      if (any) out.push({ date: d, value: sum });
    }
    if (out.length) snapshotSeries = out;
  }

  // --- Tier 3: account-level snapshots (Hon's per-sync fallback) ---------
  if (!snapshotSeries.length) {
    const acctInception = new Map<string, string | null>();
    for (const a of accounts) {
      if (focusedAcctId) {
        acctInception.set(a.id, a.id === focusedAcctId ? focusedInception : null);
      } else if (a.inceptionDate) {
        acctInception.set(a.id, a.inceptionDate);
      }
    }
    const byDate = new Map<string, number>();
    for (const s of scopedSnaps) {
      const inception = acctInception.get(s.accountId);
      if (inception && s.date < inception) continue;
      const v = convert(s.value, s.currency);
      if (v == null) continue;
      byDate.set(s.date, (byDate.get(s.date) ?? 0) + v);
    }
    snapshotSeries = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, value]) => ({ date, value }));
  }

  return stitchSeries(brokerSeries, snapshotSeries);
}

/** Stitches a broker-reported equity series with Hon's own snapshot-derived
 *  series: broker points up to (and including) the broker's last date, then
 *  snapshot points strictly after it. Keeps the deep broker history while the
 *  live tail comes from Hon's per-sync snapshots — so a revoked/frozen broker
 *  performance feed no longer freezes the chart. Either side empty → the other
 *  side as-is. Both empty → []. */
export function stitchSeries(
  broker: SeriesPoint[],
  snapshot: SeriesPoint[],
): SeriesPoint[] {
  if (!broker.length) return snapshot;
  const lastBrokerDate = broker[broker.length - 1]!.date;
  const tail = snapshot.filter((p) => p.date > lastBrokerDate);
  return tail.length ? [...broker, ...tail] : broker;
}

export type Range = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

/** Filters an equity series to a preset window. When the in-window slice has
 *  fewer than 2 points (sparse monthly Meitav cadence, a freshly-linked
 *  broker), anchor it to the last point BEFORE the window so the line still
 *  draws from a known start and the since-start diff stays meaningful.
 *  `now` is injectable for deterministic tests. */
export function sliceRange(
  series: SeriesPoint[],
  range: Range,
  now: Date = new Date(),
): SeriesPoint[] {
  if (!series.length || range === 'ALL') return series;
  let cutoff: Date;
  if (range === 'YTD') {
    cutoff = new Date(now.getFullYear(), 0, 1);
  } else {
    const months = range === '1M' ? 1 : range === '3M' ? 3 : 12;
    cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);
  }
  const iso = cutoff.toISOString().slice(0, 10);
  const inside = series.filter((p) => p.date >= iso);
  if (inside.length >= 2) return inside;
  const before = series.filter((p) => p.date < iso);
  if (!before.length) return inside;
  return [before[before.length - 1]!, ...inside];
}
