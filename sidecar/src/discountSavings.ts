// Discount Bank — קרן כספית (money market fund) post-hook.
//
// israeli-bank-scrapers' discount scraper only returns the checking
// account's balance + transactions. The bank also exposes the customer's
// full securities portfolio — including money-market-fund holdings
// (קרן כספית) — via the retail3 securities gateway. This module reuses
// the already-logged-in Puppeteer page, calls the portfolio endpoint, and
// returns each קרן-כספית position as its own holding so the brokerage
// view can show them separately.
//
// Endpoint + body shape were captured from the live Network panel after
// signing in to start.telebank.co.il/apollo/retail3/ in Chrome. Note the
// bank-side typo "LoaclRealTimeFlag" — that's their spelling, not ours;
// "fixing" it to "Local…" would break the request.
//
//   POST /Titan/gatewayAPI/securities/portfolioInfo/currentSecuritiesPortfolio
//   Headers (case-sensitive in practice):
//     AccountNumber: <accountNumber>
//     BusinessProcessID: CAPITAL_MARKET
//     language: HEBREW
//     site: retail
//   Body:
//     {"AccountNumber": "<acct>",
//      "ReutersFlag": "True",
//      "FetchBeginYearReturnFlag": "True",
//      "LoaclRealTimeFlag": "False",          (sic — Discount's typo)
//      "SecuritiesListFlag": "True",          (asks for the holdings list)
//      "ForeignRealTimeFlag": "False",
//      "DailyPortfolioLossOrProfitFlag": "True"}
//
// Best-effort enrichment: any failure logs and returns []; the underlying
// scrape's success is never affected.

import type { Page } from 'puppeteer';
import { makeLog } from './log.js';

const log = makeLog('discount:keren');

const BASE_URL = 'https://start.telebank.co.il';
const LOBBY_URL = `${BASE_URL}/apollo/retail3/`;
const PORTFOLIO_URL =
  `${BASE_URL}/Titan/gatewayAPI/securities/portfolioInfo/currentSecuritiesPortfolio`;

// "כספית" alone identifies every money-market fund Discount offers
// ("ברק כספית", "איילון כספית כשרה", "מגדל כספית" …). Filtering by name
// is more robust than by PaperSubTypeTZ — Discount's enum names have
// changed across portal versions, but the Hebrew product names haven't.
const KEREN_KASPIT_HINTS = ['כספית', 'KASPIT', 'kaspit', 'MoneyMarket', 'money market'];

/** A single money-market-fund position from Discount's securities portfolio. */
export interface DiscountKerenHolding {
  /** Trading symbol — e.g. "BARAK MM", "AYL MM FUN". Used as the holdings
   *  table's primary display field and as the per-day snapshot key. */
  symbol: string;
  /** Hebrew product name — e.g. "ברק כספית". */
  paperName: string;
  /** Units held. */
  units: number;
  /** Last known rate per unit (NIS). */
  price: number;
  /** Current market value in NIS (Discount's "תמורה" field). */
  marketValue: number;
}

/**
 * POSTs Discount's currentSecuritiesPortfolio endpoint and returns every
 * money-market-fund holding found. Returns [] when the account has none
 * or the call fails. Never throws.
 */
export async function scrapeDiscountKerenKaspit(
  page: Page,
  accountNumber: string,
): Promise<DiscountKerenHolding[]> {
  const done = log.timer('probe');
  log.info('probe.start', { startUrl: page.url(), accountNumber });

  // Step 1 — load the retail3 lobby so page-side fetch() runs from the
  // start.telebank.co.il origin and the session cookies attach.
  try {
    await page.goto(LOBBY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    log.info('lobby.loaded', { url: page.url() });
  } catch (err) {
    log.warn('lobby.failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    done({ result: 'lobby-failed' });
    return [];
  }

  // Step 2 — POST the exact request the SPA sends. Header casing matters:
  // "Accountnumber" → E100146 even on a valid session.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    AccountNumber: accountNumber,
    BusinessProcessID: 'CAPITAL_MARKET',
    language: 'HEBREW',
    site: 'retail',
  };
  const body = JSON.stringify({
    AccountNumber: accountNumber,
    ReutersFlag: 'True',
    FetchBeginYearReturnFlag: 'True',
    LoaclRealTimeFlag: 'False', // sic — Discount's own typo, do not "fix"
    SecuritiesListFlag: 'True',
    ForeignRealTimeFlag: 'False',
    DailyPortfolioLossOrProfitFlag: 'True',
  });

  let parsed: unknown;
  try {
    const result = await page.evaluate(
      async (u: string, h: Record<string, string>, b: string) => {
        const r = await fetch(u, {
          method: 'POST',
          credentials: 'include',
          headers: h,
          body: b,
        });
        const txt = await r.text();
        return { status: r.status, length: txt.length, body: txt };
      },
      PORTFOLIO_URL,
      headers,
      body,
    );
    log.info('portfolio.response', { status: result.status, length: result.length });
    if (result.status !== 200 || result.length === 0) {
      done({ result: 'bad-status', status: result.status });
      return [];
    }
    try { parsed = JSON.parse(result.body); } catch {
      log.warn('portfolio.notJson', { preview: result.body.slice(0, 120) });
      done({ result: 'not-json' });
      return [];
    }
    if (parsed && typeof parsed === 'object' && 'Error' in (parsed as Record<string, unknown>)) {
      log.warn('portfolio.error', {
        error: JSON.stringify((parsed as { Error: unknown }).Error).slice(0, 240),
      });
      done({ result: 'gateway-error' });
      return [];
    }
  } catch (err) {
    log.warn('portfolio.threw', {
      message: err instanceof Error ? err.message : String(err),
    });
    done({ result: 'threw' });
    return [];
  }

  // Step 3 — pull out the money-market entries. The response is keyed
  // `CurrentSecuritiesPortfolio.SecuritiesEntry: SecurityEntry[]`. We
  // pluck every row whose Hebrew name contains "כספית"; symbol + Tmura
  // (market value) come straight off each row.
  const holdings = parseHoldings(parsed);
  log.info('parsed', {
    holdings: holdings.length,
    names: holdings.map((h) => h.paperName),
  });
  done({ holdings: holdings.length });
  return holdings;
}

function parseHoldings(root: unknown): DiscountKerenHolding[] {
  const out: DiscountKerenHolding[] = [];
  if (!root || typeof root !== 'object') return out;
  const top = (root as Record<string, unknown>).CurrentSecuritiesPortfolio;
  if (!top || typeof top !== 'object') return out;
  const rawEntries = (top as Record<string, unknown>).SecuritiesEntry;
  const entries = Array.isArray(rawEntries)
    ? rawEntries
    : rawEntries ? [rawEntries] : [];

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const row = e as Record<string, unknown>;
    const name = pickString(row, [
      'PaperNameLongTitan', 'PaperNameTitan', 'SecurityName',
    ]);
    if (!name) continue;
    if (!KEREN_KASPIT_HINTS.some((h) => name.includes(h))) continue;

    const symbol = pickString(row, ['Symbol', 'SecurityNumber'])
      ?? `DSC-${pickString(row, ['SecurityNumber']) ?? 'unknown'}`;
    const units = pickNumber(row, ['CurrentUnits', 'BaseUnits', 'PreviousDayUnits']);
    const price = pickNumber(row, [
      'LastOperationRate', 'BaseRate', 'ClosingRate', 'LastOperationRateTitan',
    ]);
    const marketValue = pickNumber(row, ['Tmura', 'TmuraTitan', 'TmuraInCurrency']);

    // Drop only rows we couldn't price (parse failed) or that hold nothing at
    // all — keep a real position whose market value is transiently 0 but still
    // holds units (e.g. a just-opened money-market fund).
    if (marketValue == null || (marketValue === 0 && (units ?? 0) === 0)) continue;
    out.push({
      symbol: symbol.trim(),
      paperName: name.trim(),
      units: units ?? 0,
      price: price ?? 0,
      marketValue,
    });
  }
  return out;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/[,₪\s]/g, '').trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
