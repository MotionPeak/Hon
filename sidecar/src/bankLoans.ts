// Bank-loan scraper. israeli-bank-scrapers exposes only `{accountNumber,
// balance, txns}` per account — it has no concept of a loan. This module
// reaches further into the bank's own portal (after the library has logged
// us in) and pulls each loan's terms, so Hon can auto-create matching Loan
// rows. Written as a free function that takes a Puppeteer Page, so it can
// be lifted into israeli-bank-scrapers upstream as a per-scraper add-on.

import type { Browser, Frame, Page } from 'puppeteer';

// The `document` global is only available inside the puppeteer evaluate
// callbacks (which run in the page). Declared here as `any` so tsc does not
// flag those references — the rest of pension.ts gets this for free via its
// puppeteer-extra value import, which this file does not pull in.
declare const document: any;

/** One loan exactly as the bank shows it on its loans page. */
export interface ScrapedLoan {
  /** Bank-side stable id (e.g. FIBI shows "108-416" beneath the loan name). */
  externalId: string;
  /** Display name (e.g. "דיגיטל"). The externalId is appended in Hon's UI. */
  name: string;
  /** Original principal in NIS. */
  principal: number;
  /** Loan-start date, YYYY-MM-DD. */
  startDate: string;
  /** Total length in months, derived from start → final-payment date. */
  termMonths: number;
  /** Prime + margin track (rate quoted as "P+X.XX"). */
  isPrime: boolean;
  /** Principal scales with the consumer price index ("צמוד למדד"). */
  isCpiLinked: boolean;
  /** Annual %: the fixed rate, or the margin over prime when isPrime. */
  rateValue: number;
  currency: string;
  /** Bank-reported outstanding (used to cross-check the calculator). */
  currentDebt: number;
  /** Bank-reported next monthly payment (cross-check). */
  nextPayment: number | null;
}

const FIBI_LOANS_URL =
  'https://online.fibi.co.il/appsng/Resources/PortalNG/shell/' +
  '#/Online/OnLoansMortgageMenu/OnLoans/AuthLoansDetails';

const FIBI_LOAN_HEADER_HE = 'שם ההלוואה';

/**
 * Scrapes the FIBI/Beinleumi-group loans page using an already-authenticated
 * Puppeteer browser. Navigates to the loans tab inside the new PortalNG
 * shell, waits for the table to render, and parses each row.
 *
 * Returns an empty array (no throw) when the page is missing or the layout
 * has shifted — callers should treat it as "no loans found this sync" and
 * keep going. A non-empty rendered HTML is dumped to `debugDumpPath` when
 * supplied, so the next pass has the material to tighten the parser.
 */
export async function scrapeFibiLoans(
  browser: Browser,
  debugDumpPath?: string,
): Promise<ScrapedLoan[]> {
  const log = (...parts: unknown[]): void => console.error('[bank-loans]', ...parts);
  log('starting FIBI loans scrape');
  const page = await browser.newPage();
  try {
    // The new shell is a single-spa Angular host; navigating to the hash URL
    // drives the router rather than a full reload. Wait for the document and
    // then for any element that says "שם ההלוואה" to appear before parsing.
    log('navigating to', FIBI_LOANS_URL);
    try {
      await page.goto(FIBI_LOANS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      log('goto threw:', err instanceof Error ? err.message : String(err));
    }
    log('post-goto url:', page.url());

    const target = await waitForLoansAnchor(page, 45_000);
    if (!target) {
      log('anchor not found within 45s; current url:', page.url());
      log('frames at timeout:', page.frames().map((f) => f.url()));
      // Dump the page HTML so the next pass has the material to tighten the
      // parser or pick a different navigation route.
      await dumpDebug(page, debugDumpPath, log);
      return [];
    }
    log(
      'anchor found in',
      'url' in target ? `frame ${target.url()}` : 'main page',
    );

    if (debugDumpPath) {
      try {
        const html = await target.content();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(debugDumpPath, html, 'utf8');
        log('wrote debug HTML to', debugDumpPath);
      } catch (err) {
        log('debug dump failed:', err instanceof Error ? err.message : String(err));
      }
    }

    const rawRows = await extractRows(target);
    log('extracted', rawRows.length, 'raw row(s)');
    const loans: ScrapedLoan[] = [];
    for (const row of rawRows) {
      const parsed = parseRow(row);
      if (parsed) {
        log('parsed loan:', parsed.externalId, parsed.name, parsed.principal);
        loans.push(parsed);
      } else {
        log('skipped unparseable row:', row.cells.slice(0, 4));
      }
    }
    log('returning', loans.length, 'loan(s)');
    return loans;
  } catch (err) {
    log('scrape threw:', err instanceof Error ? err.stack : String(err));
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

// Writes the main-page HTML to disk so we can inspect what the scraper
// actually saw when the anchor never appeared. Best-effort — a failed dump
// never blocks the parent scrape.
async function dumpDebug(
  page: Page,
  debugPath: string | undefined,
  log: (...p: unknown[]) => void,
): Promise<void> {
  if (!debugPath) return;
  try {
    const html = await page.content();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(debugPath, html, 'utf8');
    log('dumped page HTML to', debugPath);
  } catch (err) {
    log('debug dump failed:', err instanceof Error ? err.message : String(err));
  }
}

// --- Plumbing ---------------------------------------------------------------

// FIBI's new shell sometimes nests the loans page in the legacy iframe
// (`iframe-old-pages`) and sometimes renders it directly in the host. Wait
// for the Hebrew header to appear in any frame, then return that frame.
async function waitForLoansAnchor(page: Page, timeoutMs: number): Promise<Page | Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates: (Page | Frame)[] = [page, ...page.frames()];
    for (const target of candidates) {
      const has = await target
        .evaluate((needle: string) => {
          const body = document.body;
          return !!body && body.innerText.includes(needle);
        }, FIBI_LOAN_HEADER_HE)
        .catch(() => false);
      if (has) return target;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}

// Pulls every loan row out of the loans page. Anchors on the Hebrew header
// "שם ההלוואה" — that text is the rightmost cell in the table head — then
// walks every following row in the same <table>, dropping the totals row.
async function extractRows(target: Page | Frame): Promise<RawRow[]> {
  // Cast to Page so puppeteer's evaluate overload resolves cleanly; Frame's
  // evaluate has the same shape and accepts the same callback at runtime.
  return (target as Page).evaluate((needle: string) => {
    const SUMMARY_HE = 'סה"כ';
    // Locate the table by finding the cell whose text matches the header.
    let table: any = null;
    const headerCells: any[] = Array.from(document.querySelectorAll('th, td'));
    for (const cell of headerCells) {
      if ((cell.textContent || '').trim() === needle) {
        table = cell.closest('table');
        if (table) break;
      }
    }
    if (!table) return [] as RawRow[];

    const rows: RawRow[] = [];
    const trs: any[] = Array.from(table.querySelectorAll('tbody tr, tr'));
    for (const tr of trs) {
      const tds: any[] = Array.from(tr.querySelectorAll('td'));
      const cells: string[] = tds.map((td: any) =>
        (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim(),
      );
      if (cells.length < 4) continue;
      // The totals row leads with "סה״כ" / "סה"כ" — skip it.
      if (cells.some((c) => c.startsWith(SUMMARY_HE))) continue;
      // The header row repeats inside <tbody> in some FIBI layouts; skip it.
      if (cells.includes(needle)) continue;
      rows.push({ cells });
    }
    return rows;
  }, FIBI_LOAN_HEADER_HE);
}

interface RawRow {
  cells: string[];
}

// FIBI's table is rendered right-to-left, so the first <td> in DOM order is
// the rightmost visual column. The Hebrew column order is:
//   0  שם ההלוואה              loan name (+ optional id sub-line)
//   1  סכום הלוואה מקורי       original principal
//   2  יום מתן ההלוואה         start date  (DD/MM/YY)
//   3  שיעור הריבית            rate, e.g. "P+3.30 %" then "(8.80 %)"
//   4  סך החוב                 current outstanding
//   5  מועד פירעון סופי        final-payment date  (DD/MM/YY)
//   6  סכום התשלום הבא         next payment amount
//   7  מועד התשלום הבא         next payment date
//   8  לוח סילוקין             amortization-schedule icon link
//   9  פירעון/שינוי            edit link
// We anchor on text shape (digits / "P+" / "צמוד") rather than the exact
// index so a layout reshuffle does not silently produce wrong figures.
function parseRow(row: RawRow): ScrapedLoan | null {
  const cells = row.cells;
  if (cells.length < 6) return null;

  // The name cell mixes the loan label and a sub-id (e.g. "דיגיטל 108-416").
  // Split on the digit-heavy second line if present.
  const nameCell = cells[0] || '';
  const nameMatch = nameCell.match(/^(.*?)\s+(\d{2,}[\d-]+)\s*$/);
  const name = (nameMatch ? nameMatch[1] : nameCell).trim();
  const externalId = nameMatch ? nameMatch[2] : nameCell;
  if (!externalId) return null;

  const principal = parseMoney(cells[1]);
  const startDate = parseDate(cells[2]);
  const rate = parseRate(cells[3]);
  const currentDebt = parseMoney(cells[4]);
  const finalDate = parseDate(cells[5]);
  const nextPayment = cells.length > 6 ? parseMoney(cells[6]) : null;

  if (!Number.isFinite(principal) || !startDate || !finalDate) return null;

  return {
    externalId,
    name: name || externalId,
    principal,
    startDate,
    termMonths: monthsBetweenDates(startDate, finalDate),
    isPrime: rate.isPrime,
    isCpiLinked: rate.isCpiLinked,
    rateValue: rate.value,
    currency: 'ILS',
    currentDebt: Number.isFinite(currentDebt) ? currentDebt : 0,
    nextPayment: nextPayment != null && Number.isFinite(nextPayment) ? nextPayment : null,
  };
}

function parseMoney(s: string | undefined): number {
  if (!s) return NaN;
  // Strip everything but digits, dot, minus. Hebrew amount cells often wrap
  // in directional marks and a "ש"ח" suffix.
  const cleaned = s.replace(/[^\d.\-]/g, '');
  return cleaned ? parseFloat(cleaned) : NaN;
}

function parseDate(s: string | undefined): string | null {
  if (!s) return null;
  // FIBI prints DD/MM/YY. Two-digit years are 21st-century — anything from
  // '70 onward is unrealistic for a current loan, so the cutoff is 1970.
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  let yyyy = m[3];
  if (yyyy.length === 2) yyyy = (Number(yyyy) >= 70 ? '19' : '20') + yyyy;
  return `${yyyy}-${mm}-${dd}`;
}

// "P+3.30 %"            → prime + 3.30
// "P 3.30 %"            → prime + 3.30
// "5.50 %"              → fixed 5.50
// "צמוד P+1.20 %"      → cpi-prime margin 1.20
// "צמוד 4.20 %"        → cpi-fixed 4.20
// "(8.80 %)"            → effective rate, ignored on its own
function parseRate(s: string | undefined): { isPrime: boolean; isCpiLinked: boolean; value: number } {
  const text = (s || '').trim();
  const isCpiLinked = /צמוד/.test(text);
  // Drop the parenthesised effective-rate so the digits we read are the
  // formula's, not its evaluation.
  const formula = text.replace(/\(.*?\)/g, '').trim();
  const isPrime = /\bP\b|פריים|prime/i.test(formula);
  const numMatch = formula.match(/-?\d+(?:\.\d+)?/);
  const value = numMatch ? parseFloat(numMatch[0]) : NaN;
  return {
    isPrime,
    isCpiLinked,
    value: Number.isFinite(value) ? value : 0,
  };
}

function monthsBetweenDates(fromIso: string, toIso: string): number {
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  // Round to the nearest whole month using day-of-month as the tiebreaker.
  return Math.max(1, months + (b.getDate() >= a.getDate() ? 0 : -1));
}

// The Beinleumi-group banks share one portal and one loans page; the company
// ids below all route through the same scraper, so the same URL applies.
export function supportsBankLoans(companyId: string): boolean {
  return (
    companyId === 'beinleumi' ||
    companyId === 'otsarHahayal' ||
    companyId === 'massad' ||
    companyId === 'pagi'
  );
}
