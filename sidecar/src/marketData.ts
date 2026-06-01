// Free historical price feed for brokerage holdings. Two sources, dispatched
// by symbol shape:
//   • Yahoo Finance for letter-based tickers (AAPL, TEVA.TA, …) — works for
//     most US/UK/EU listings and big Israeli stocks via the .TA suffix.
//   • TASE Maya for purely numeric symbols (Israeli mutual funds / ETFs /
//     קופות, e.g. Meitav's 5100474 = TA-125 tracker). These have no Yahoo
//     ticker — the MisparNiar is the identifier across every TASE service.
// Both return the same HistoricalClose[] shape so the runner can just iterate
// holdings and call fetchHistoryForSymbol() without caring about origin.

export interface HistoricalClose {
  /** ISO YYYY-MM-DD. */
  date: string;
  close: number;
  currency: string;
}

/**
 * fetch() with a hard timeout — without one, a stalled remote (Yahoo
 * rate-limit, Maya bot-wall, intermittent DNS) blocks the backfill loop
 * forever. Aborts the request when the deadline lapses and lets the caller
 * fall back to an empty result.
 */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pulls daily close prices for a ticker over the past `days` days. Returns an
 * empty array on any failure (Yahoo rate-limits, unknown symbols, transient
 * network errors) so the caller can keep going. Currency reflects what the
 * symbol is quoted in (USD for US listings, etc.).
 */
export async function fetchYahooHistory(
  symbol: string,
  days = 365 * 10,
): Promise<HistoricalClose[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 24 * 3600;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${start}&period2=${end}&interval=1d`;
  try {
    const res = await fetchWithTimeout(url, {
      // Yahoo blocks calls without a UA; a generic browser UA is enough.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Hon/0.2; +https://github.com)' },
    }, 15_000);
    if (!res.ok) {
      process.stderr.write(
        `yahoo history ${symbol}: HTTP ${res.status}\n`,
      );
      return [];
    }
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          meta?: { currency?: string; gmtoffset?: number };
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
        error?: { description?: string };
      };
    };
    if (data.chart?.error) {
      process.stderr.write(
        `yahoo history ${symbol}: ${data.chart.error.description ?? 'error'}\n`,
      );
      return [];
    }
    const result = data.chart?.result?.[0];
    if (!result) return [];
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const currency = result.meta?.currency || 'USD';
    // Each timestamp is the epoch of that day's market close in the exchange's
    // local time (e.g. 16:00 ET, ~20:00–21:00 UTC). Taking the bare UTC
    // calendar day pushes evening-UTC closes onto the *next* date (and would
    // pull early-UTC closes onto the previous one for exchanges east of UTC),
    // so the close lands on the wrong trading day. Shift the epoch by the
    // exchange's GMT offset before slicing so the date reflects the local
    // trading day. Falls back to a plain UTC day when Yahoo omits the offset.
    const offsetMs = typeof result.meta?.gmtoffset === 'number' ? result.meta.gmtoffset * 1000 : 0;
    const out: HistoricalClose[] = [];
    for (let i = 0; i < ts.length; i += 1) {
      const c = closes[i];
      if (typeof c !== 'number' || !isFinite(c)) continue;
      out.push({
        date: new Date(ts[i] * 1000 + offsetMs).toISOString().slice(0, 10),
        close: c,
        currency,
      });
    }
    return out;
  } catch (err) {
    process.stderr.write(
      `yahoo history ${symbol} threw: ${(err as Error).message}\n`,
    );
    return [];
  }
}

/**
 * Pulls current NAV and recent yield numbers for an Israeli mutual fund from
 * Maya's web API by MisparNiar. The endpoint Maya's own UI uses —
 * `maya.tase.co.il/api/v1/funds/mutual/{id}` — returns a single object with
 * `purchasePrice`, `redemptionPrice` (NAV in agorot) and a `yields` block:
 *   { dayYield, monthYield, yearYield, last12MonthYield, standardDeviation }
 *
 * Maya doesn't expose a public per-day NAV series here — the dashboard's
 * chart is rebuilt client-side from these aggregated yields, not from a
 * historical price array. So this returns one HistoricalClose (today's NAV)
 * plus, if the yield numbers are present, two extra back-derived points so
 * the Hon equity-curve has *some* shape to draw for an individual holding:
 *   • today          (current NAV)
 *   • 1 month ago    (today / (1 + monthYield/100))
 *   • 1 year ago     (today / (1 + yearYield/100))
 *
 * Better than nothing; for true daily-resolution series the Meitav portfolio
 * GetTsuot path (already wired in pension.ts) is the right place to look.
 */
export async function fetchMayaHistory(
  misparNiar: string,
  _days = 365 * 10,
): Promise<HistoricalClose[]> {
  const url = `https://maya.tase.co.il/api/v1/funds/mutual/${encodeURIComponent(misparNiar)}`;
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'he-IL',
    'Referer': `https://maya.tase.co.il/he/funds/mutual-funds/${encodeURIComponent(misparNiar)}`,
    'User-Agent': 'Mozilla/5.0 (compatible; Hon/0.3; +https://github.com)',
  };
  try {
    const res = await fetchWithTimeout(url, { headers }, 15_000);
    if (!res.ok) {
      process.stderr.write(`maya history ${misparNiar}: HTTP ${res.status}\n`);
      return [];
    }
    const data: any = await res.json();
    // The NAV fields come back in agorot — divide by 100 for NIS.
    const navAgorot = Number(data.redemptionPrice ?? data.purchasePrice);
    if (!Number.isFinite(navAgorot)) {
      process.stderr.write(`maya history ${misparNiar}: no usable NAV in response\n`);
      return [];
    }
    const today = navAgorot / 100;
    const todayIso = new Date().toISOString().slice(0, 10);
    const points: HistoricalClose[] = [{ date: todayIso, close: today, currency: 'ILS' }];
    const yields: any = data.yields ?? {};
    const monthYield = Number(yields.monthYield);
    const yearYield = Number(yields.yearYield);
    if (Number.isFinite(monthYield) && monthYield > -100) {
      const monthAgo = new Date();
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      points.push({
        date: monthAgo.toISOString().slice(0, 10),
        close: today / (1 + monthYield / 100),
        currency: 'ILS',
      });
    }
    if (Number.isFinite(yearYield) && yearYield > -100) {
      const yearAgo = new Date();
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      points.push({
        date: yearAgo.toISOString().slice(0, 10),
        close: today / (1 + yearYield / 100),
        currency: 'ILS',
      });
    }
    return points.sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    const msg = (err as Error).message || String(err);
    process.stderr.write(
      `maya history ${misparNiar} threw: ${msg}`
      + (msg.includes('abort') ? ' (timeout — Maya stalled or rate-limited)' : '')
      + '\n',
    );
    return [];
  }
}

/**
 * Routes a holding symbol to the right price source:
 *   • all-digit symbol → TASE Maya by MisparNiar
 *   • anything else    → Yahoo Finance
 * Both sources return `HistoricalClose[]` so the caller doesn't branch.
 */
export async function fetchHistoryForSymbol(
  symbol: string,
  days = 365 * 10,
): Promise<HistoricalClose[]> {
  if (/^\d+$/.test(symbol)) return fetchMayaHistory(symbol, days);
  return fetchYahooHistory(symbol, days);
}
