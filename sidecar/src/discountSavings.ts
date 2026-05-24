// Discount Bank — קרן כספית (money market fund) post-hook.
//
// israeli-bank-scrapers' discount scraper only returns the checking
// account's balance + transactions. The bank also exposes savings, deposits
// and money-market-fund (קרן כספית) balances on the same authenticated
// session, but via different gateway-API endpoints. This module reuses the
// already-logged-in Puppeteer page, probes a few likely endpoints, and
// returns whichever קרן-כספית balance it finds.
//
// Written as a standalone post-hook so it can fail soft: any error returns
// 0 balance + a log line; the underlying scrape's success is never affected.

import type { Page } from 'puppeteer';
import { makeLog } from './log.js';

const log = makeLog('discount:keren');

const BASE_URL = 'https://start.telebank.co.il';
const API_BASE = `${BASE_URL}/Titan/gatewayAPI`;

// Endpoints to probe, in order. Each may or may not exist depending on the
// account type — the loop stops as soon as one returns a recognisable
// קרן-כספית entry. Telebank's SPA navigates between these as the user
// switches sections; the JSON is what their frontend itself consumes.
const PROBES = [
  `${API_BASE}/lobby/getLobbyData`,
  `${API_BASE}/savings/getSavingsAndDepositsData`,
  `${API_BASE}/savings/getSavingsData`,
  `${API_BASE}/financialPortfolio/getPortfolioMain`,
  `${API_BASE}/securitiesPortfolio/getPortfolio`,
  `${API_BASE}/portfolio/getPortfolio`,
];

// Hebrew phrases / English tokens that mark a money-market-fund row in a
// Discount API response. Used to recognise the entry inside whatever
// arbitrary JSON shape the endpoint returns.
const KEREN_KASPIT_HINTS = [
  'קרן כספית',
  'קופה כספית',
  'money market',
  'moneyMarket',
  'MoneyMarketFund',
  'KerenKaspit',
];

/** A קרן כספית balance pulled from the bank's gateway API. */
export interface DiscountKerenKaspit {
  /** Total balance in NIS. */
  balance: number;
  /** Currency reported by the bank (ILS in practice). */
  currency: string;
  /** Human label — usually "קרן כספית" or the fund's own name. */
  label: string;
}

/**
 * Probes Discount's gateway API for the user's קרן כספית position. Returns
 * null when nothing was found (no balance, endpoint changed, or the account
 * doesn't hold one). Never throws — the underlying scrape's success comes
 * first; this is best-effort enrichment.
 */
export async function scrapeDiscountKerenKaspit(page: Page): Promise<DiscountKerenKaspit | null> {
  const done = log.timer('probe');
  log.info('probe.start', { endpoints: PROBES.length });
  let found: DiscountKerenKaspit | null = null;
  for (const url of PROBES) {
    try {
      const body = await fetchJson(page, url);
      if (!body) {
        log.info('probe.empty', { url });
        continue;
      }
      const hit = pickKerenKaspit(body);
      if (hit) {
        log.info('matched', { url, balance: hit.balance, label: hit.label });
        found = hit;
        break;
      }
      // Surface the top-level keys so we can tell what shape the endpoint
      // actually returned without dumping the whole tree.
      const topKeys = (typeof body === 'object' && body)
        ? Object.keys(body as Record<string, unknown>).slice(0, 10)
        : [];
      log.info('probe.no-match', { url, topKeys });
    } catch (err) {
      log.warn('probe.failed', {
        url, message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  done(found ? { balance: found.balance } : { result: 'not-found' });
  return found;
}

/** Hits one Discount API endpoint from inside the authenticated page. */
async function fetchJson(page: Page, url: string): Promise<unknown> {
  return page.evaluate(async (u: string) => {
    try {
      const r = await fetch(u, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) return null;
      // Some endpoints return text/plain when the session is stale; guard
      // against that so JSON.parse can't reject the whole probe loop.
      const txt = await r.text();
      try { return JSON.parse(txt); } catch { return null; }
    } catch { return null; }
  }, url);
}

/**
 * Recursively walks a JSON tree looking for a node that names קרן כספית and
 * also carries a numeric balance/value field. Returns the first hit; the
 * tree shape varies between endpoints, so the search is intentionally
 * generic rather than tied to one schema.
 */
function pickKerenKaspit(root: unknown): DiscountKerenKaspit | null {
  const candidates: DiscountKerenKaspit[] = [];

  function walk(node: unknown): void {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    // Pull every string field on this object and check for a hint match.
    const stringValues = Object.values(obj).filter((v) => typeof v === 'string') as string[];
    const matchesHint = stringValues.some((s) =>
      KEREN_KASPIT_HINTS.some((h) => s.includes(h)),
    );
    if (matchesHint) {
      const balance = extractBalance(obj);
      if (balance != null) {
        const label = (stringValues.find((s) =>
          KEREN_KASPIT_HINTS.some((h) => s.includes(h)),
        ) ?? 'קרן כספית').slice(0, 80);
        candidates.push({ balance, currency: 'ILS', label });
      }
    }
    for (const v of Object.values(obj)) walk(v);
  }
  walk(root);
  if (candidates.length === 0) return null;
  // Sum every קרן-כספית match in case the user holds more than one. The
  // largest single match also wins the displayed label.
  candidates.sort((a, b) => b.balance - a.balance);
  const total = candidates.reduce((s, c) => s + c.balance, 0);
  return { balance: total, currency: 'ILS', label: candidates[0]!.label };
}

/** Extracts a balance number from a Discount JSON node, trying common keys. */
function extractBalance(obj: Record<string, unknown>): number | null {
  const keys = [
    'Balance', 'balance',
    'Amount', 'amount',
    'CurrentBalance', 'currentBalance',
    'TotalAmount', 'totalAmount',
    'MarketValue', 'marketValue',
    'PortfolioValue', 'portfolioValue',
    'Value', 'value',
  ];
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/[,₪]/g, '').trim();
      const n = Number(cleaned);
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }
  return null;
}
