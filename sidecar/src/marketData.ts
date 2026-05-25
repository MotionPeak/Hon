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

/**
 * Pulls daily NAV history for an Israeli security (mutual fund / ETF / קופה)
 * by its TASE MisparNiar from the Maya web API. Tries the fund-shaped endpoint
 * first; falls back to the security-shaped one. Empty array on any failure.
 *
 * Maya's API is browser-driven and rejects requests without a Referer / Origin
 * matching maya.tase.co.il, so we set both. The endpoints return
 * `[{ TradeDate, SellPrice, BuyPrice, Yield, … }]` where `SellPrice` is the
 * end-of-day NAV in agorot — divided by 100 to land back in NIS.
 */
export async function fetchMayaHistory(
  misparNiar: string,
  days = 365 * 10,
): Promise<HistoricalClose[]> {
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 3600 * 1000);
  const candidates = [
    // Mutual fund / ETF — the most common shape for Meitav holdings.
    `https://mayaapi.tase.co.il/api/fund/historyByDates?fundId=${encodeURIComponent(misparNiar)}` +
      `&fromDate=${toIso(start)}&toDate=${toIso(end)}`,
    // Listed security (stock / corporate bond / index-tracker ETF).
    `https://mayaapi.tase.co.il/api/securities/trading/eod/historyByDates?securityId=${encodeURIComponent(misparNiar)}` +
      `&fromDate=${toIso(start)}&toDate=${toIso(end)}`,
  ];
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
    'Origin': 'https://maya.tase.co.il',
    'Referer': 'https://maya.tase.co.il/',
    'User-Agent': 'Mozilla/5.0 (compatible; Hon/0.3; +https://github.com)',
    'X-Maya-With': 'allow',
  };
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        process.stdout.write(`maya history ${misparNiar} (${shortUrl(url)}): HTTP ${res.status}\n`);
        continue;
      }
      const data: any = await res.json();
      // Normalise the row list — Maya wraps the array in different keys per
      // endpoint (Items / HistoryData / a bare array). Pick the first one
      // that looks like a list of {Date,Price}-ish rows.
      const rows: any[] = Array.isArray(data) ? data
        : Array.isArray(data?.Items) ? data.Items
        : Array.isArray(data?.HistoryData) ? data.HistoryData
        : Array.isArray(data?.Data) ? data.Data
        : Array.isArray(data?.t) ? data.t
        : [];
      const out: HistoricalClose[] = [];
      for (const r of rows) {
        const dateRaw = r.TradeDate ?? r.Date ?? r.date ?? r.tradeDate ?? '';
        const date = typeof dateRaw === 'string' ? dateRaw.slice(0, 10) : '';
        // Maya quotes mutual funds in agorot; the SellPrice / Price fields
        // are the canonical end-of-day NAV. Divide by 100 to express in NIS.
        const rawPrice = r.SellPrice ?? r.Price ?? r.ClosingPrice ?? r.NAV ?? r.nav ?? r.price;
        const num = typeof rawPrice === 'number' ? rawPrice : Number(rawPrice);
        if (!date || !Number.isFinite(num)) continue;
        out.push({ date, close: num / 100, currency: 'ILS' });
      }
      if (out.length) return out.sort((a, b) => a.date.localeCompare(b.date));
      process.stdout.write(`maya history ${misparNiar} (${shortUrl(url)}): empty rows\n`);
    } catch (err) {
      process.stdout.write(
        `maya history ${misparNiar} (${shortUrl(url)}) threw: ${(err as Error).message}\n`,
      );
    }
  }
  return [];
}

function shortUrl(url: string): string {
  return url.replace('https://mayaapi.tase.co.il/api/', '').split('?')[0];
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
