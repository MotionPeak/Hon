// Free historical price feed for brokerage holdings. SnapTrade's reporting
// endpoint frequently returns empty for newly-linked accounts and for plans
// that don't include performance reporting; Yahoo's chart API hands back
// daily closes going years back with no auth, so Hon reconstructs portfolio
// value over time as `current units × historical close` per position.

export interface HistoricalClose {
  /** ISO YYYY-MM-DD. */
  date: string;
  close: number;
  currency: string;
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
    const res = await fetch(url, {
      // Yahoo blocks calls without a UA; a generic browser UA is enough.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Hon/0.2; +https://github.com)' },
    });
    if (!res.ok) {
      process.stdout.write(
        `yahoo history ${symbol}: HTTP ${res.status}\n`,
      );
      return [];
    }
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          meta?: { currency?: string };
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
        error?: { description?: string };
      };
    };
    if (data.chart?.error) {
      process.stdout.write(
        `yahoo history ${symbol}: ${data.chart.error.description ?? 'error'}\n`,
      );
      return [];
    }
    const result = data.chart?.result?.[0];
    if (!result) return [];
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const currency = result.meta?.currency || 'USD';
    const out: HistoricalClose[] = [];
    for (let i = 0; i < ts.length; i += 1) {
      const c = closes[i];
      if (typeof c !== 'number' || !isFinite(c)) continue;
      out.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        close: c,
        currency,
      });
    }
    return out;
  } catch (err) {
    process.stdout.write(
      `yahoo history ${symbol} threw: ${(err as Error).message}\n`,
    );
    return [];
  }
}
