// Bank-loan scraper. israeli-bank-scrapers exposes only `{accountNumber,
// balance, txns}` per account — it has no concept of a loan. This module
// reaches further into the bank's own portal (after the library has logged
// us in) and pulls each loan's terms, so Hon can auto-create matching Loan
// rows. Written as a free function that takes a Puppeteer Page, so it can
// be lifted into israeli-bank-scrapers upstream as a per-scraper add-on.

import type { Browser, Frame, Page } from 'puppeteer';
import { makeLog } from './log.js';

// The `document` global is only available inside the puppeteer evaluate
// callbacks (which run in the page). Declared here as `any` so tsc does not
// flag those references — the rest of pension.ts gets this for free via its
// puppeteer-extra value import, which this file does not pull in.
declare const document: any;

const fibiLog = makeLog('loans:fibi');
const hapoalimLog = makeLog('loans:hapoalim');
const log = fibiLog;

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
  const done = log.timer('scrape', { url: FIBI_LOANS_URL });
  const page = await browser.newPage();
  try {
    // The new shell is a single-spa Angular host; navigating to the hash URL
    // drives the router rather than a full reload. Wait for the document and
    // then for any element that says "שם ההלוואה" to appear before parsing.
    log.info('navigate', { url: FIBI_LOANS_URL, timeoutMs: 60_000 });
    try {
      await page.goto(FIBI_LOANS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      log.warn('goto.failed', { message: err instanceof Error ? err.message : String(err) });
    }
    log.info('navigate.done', { landedUrl: page.url() });

    const waitDone = log.timer('anchor.wait', { needle: FIBI_LOAN_HEADER_HE, timeoutMs: 45_000 });
    const target = await waitForLoansAnchor(page, 45_000);
    if (!target) {
      waitDone({ found: false });
      log.error('anchor.missing', {
        landedUrl: page.url(),
        frameCount: page.frames().length,
        frameUrls: page.frames().map((f) => f.url()),
      });
      // Dump the page HTML so the next pass has the material to tighten the
      // parser or pick a different navigation route.
      await dumpDebug(page, debugDumpPath);
      done({ result: 'anchor-missing', loans: 0 });
      return [];
    }
    waitDone({
      found: true,
      // Frames carry .url(); the top-level Page does not.
      where: 'url' in target ? `frame:${target.url()}` : 'main-page',
    });

    if (debugDumpPath) {
      try {
        const html = await target.content();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(debugDumpPath, html, 'utf8');
        log.info('debug.dump', { path: debugDumpPath, bytes: html.length });
      } catch (err) {
        log.warn('debug.dump.failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const rawRows = await extractRows(target);
    log.info('rows.extracted', { count: rawRows.length });
    const loans: ScrapedLoan[] = [];
    let skipped = 0;
    for (const row of rawRows) {
      const parsed = parseRow(row);
      if (parsed) {
        log.info('row.parsed', {
          externalId: parsed.externalId,
          name: parsed.name,
          principal: parsed.principal,
          rate: parsed.rateValue,
          isPrime: parsed.isPrime,
          isCpiLinked: parsed.isCpiLinked,
          termMonths: parsed.termMonths,
        });
        loans.push(parsed);
      } else {
        skipped += 1;
        log.warn('row.skipped', { firstCells: row.cells.slice(0, 4) });
      }
    }
    done({ result: 'ok', loans: loans.length, skipped });
    return loans;
  } catch (err) {
    log.error('scrape.threw', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    done({ result: 'exception', loans: 0 });
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
): Promise<void> {
  if (!debugPath) return;
  try {
    const html = await page.content();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(debugPath, html, 'utf8');
    log.info('debug.dump', { path: debugPath, bytes: html.length });
  } catch (err) {
    log.warn('debug.dump.failed', {
      message: err instanceof Error ? err.message : String(err),
    });
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
// Hapoalim has its own portal and is dispatched by `scrapeBankLoans`.
export function supportsBankLoans(companyId: string): boolean {
  return (
    companyId === 'beinleumi' ||
    companyId === 'otsarHahayal' ||
    companyId === 'massad' ||
    companyId === 'pagi' ||
    companyId === 'hapoalim'
  );
}

/**
 * Dispatches to the right per-bank loan scraper for `companyId`. Returns an
 * empty array (never throws) when the bank is unsupported or the scrape fails
 * for any reason — see the per-bank implementations for details.
 */
export async function scrapeBankLoans(
  companyId: string,
  browser: Browser,
  debugDumpPath?: string,
): Promise<ScrapedLoan[]> {
  if (companyId === 'hapoalim') {
    return scrapeHapoalimLoans(browser, debugDumpPath);
  }
  if (supportsBankLoans(companyId)) {
    return scrapeFibiLoans(browser, debugDumpPath);
  }
  return [];
}

// --- Hapoalim ---------------------------------------------------------------
// Hapoalim's loans page lives in their PortalNG Angular shell. Unlike FIBI it
// renders a per-loan summary table, but the rate/term/start-date fields only
// appear inside an expander panel for each row. So the scraper walks the
// rows, clicks each expander, and harvests the detail panel before moving on.

const HAPOALIM_LOANS_URL =
  'https://login.bankhapoalim.co.il/ng-portals/rb/he/credit-and-mortgage/transactions';

// Anchor text in the summary table head; appears once per loans page.
const HAPOALIM_HEADER_HE = 'סוג האשראי';

// Labels in the expanded detail panel. We anchor on label text rather than
// CSS selectors because the Angular shell hashes classnames between deploys.
const HAPOALIM_LABEL = {
  serial: 'סידורי',
  startDate: 'יום תחילת החישוב',
  endDate: 'תאריך הסיום',
  rateType: 'סוג הריבית',
  currentRate: 'שיעור הריבית הנוכחי',
  sourceRate: 'ריבית המקור',
  cpiBase: 'בסיס ההצמדה',
  principalCount: 'הקרן',
};

export async function scrapeHapoalimLoans(
  browser: Browser,
  debugDumpPath?: string,
): Promise<ScrapedLoan[]> {
  const done = hapoalimLog.timer('scrape', { url: HAPOALIM_LOANS_URL });
  const page = await browser.newPage();
  try {
    hapoalimLog.info('navigate', { url: HAPOALIM_LOANS_URL, timeoutMs: 60_000 });
    try {
      await page.goto(HAPOALIM_LOANS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      hapoalimLog.warn('goto.failed', { message: err instanceof Error ? err.message : String(err) });
    }
    hapoalimLog.info('navigate.done', { landedUrl: page.url() });

    const target = await waitForHapoalimAnchor(page, 45_000);
    if (!target) {
      hapoalimLog.error('anchor.missing', {
        landedUrl: page.url(),
        frameCount: page.frames().length,
        frameUrls: page.frames().map((f) => f.url()),
      });
      await dumpDebugFor(page, debugDumpPath, hapoalimLog);
      done({ result: 'anchor-missing', loans: 0 });
      return [];
    }

    if (debugDumpPath) {
      try {
        const html = await target.content();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(debugDumpPath, html, 'utf8');
        hapoalimLog.info('debug.dump', { path: debugDumpPath, bytes: html.length });
      } catch (err) {
        hapoalimLog.warn('debug.dump.failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Each row needs its expander opened so the detail panel materialises. We
    // do this row by row and read both the summary + detail in one pass.
    const rowCount = await countHapoalimRows(target);
    hapoalimLog.info('rows.counted', { count: rowCount });
    const loans: ScrapedLoan[] = [];
    for (let i = 0; i < rowCount; i += 1) {
      try {
        const expanded = await expandHapoalimRow(target, i);
        if (!expanded) {
          hapoalimLog.warn('row.expand.failed', { index: i });
          continue;
        }
        const raw = await readHapoalimRow(target, i);
        if (!raw) {
          hapoalimLog.warn('row.read.failed', { index: i });
          continue;
        }
        const parsed = parseHapoalimRow(raw);
        if (parsed) {
          hapoalimLog.info('row.parsed', {
            externalId: parsed.externalId,
            name: parsed.name,
            principal: parsed.principal,
            rate: parsed.rateValue,
            isPrime: parsed.isPrime,
            isCpiLinked: parsed.isCpiLinked,
            termMonths: parsed.termMonths,
          });
          loans.push(parsed);
        } else {
          hapoalimLog.warn('row.skipped', { index: i, raw });
        }
      } catch (err) {
        hapoalimLog.warn('row.threw', {
          index: i,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    done({ result: 'ok', loans: loans.length });
    return loans;
  } catch (err) {
    hapoalimLog.error('scrape.threw', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    done({ result: 'exception', loans: 0 });
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function dumpDebugFor(
  page: Page,
  debugPath: string | undefined,
  logger: ReturnType<typeof makeLog>,
): Promise<void> {
  if (!debugPath) return;
  try {
    const html = await page.content();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(debugPath, html, 'utf8');
    logger.info('debug.dump', { path: debugPath, bytes: html.length });
  } catch (err) {
    logger.warn('debug.dump.failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function waitForHapoalimAnchor(page: Page, timeoutMs: number): Promise<Page | Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates: (Page | Frame)[] = [page, ...page.frames()];
    for (const target of candidates) {
      const has = await target
        .evaluate((needle: string) => {
          const body = document.body;
          return !!body && body.innerText.includes(needle);
        }, HAPOALIM_HEADER_HE)
        .catch(() => false);
      if (has) return target;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}

// Returns the number of loan rows in the summary table — excludes the head
// row and any totals row. Anchored on the same Hebrew header as the parser.
async function countHapoalimRows(target: Page | Frame): Promise<number> {
  return (target as Page).evaluate((needle: string) => {
    const SUMMARY_HE = 'סה"כ';
    const headerCells: any[] = Array.from(document.querySelectorAll('th, td'));
    let table: any = null;
    for (const cell of headerCells) {
      if ((cell.textContent || '').trim() === needle) {
        table = cell.closest('table');
        if (table) break;
      }
    }
    if (!table) return 0;
    const trs: any[] = Array.from(table.querySelectorAll('tbody tr, tr'));
    let count = 0;
    for (const tr of trs) {
      const tds: any[] = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 4) continue;
      const cells: string[] = tds.map((td: any) =>
        (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim(),
      );
      if (cells.some((c) => c.startsWith(SUMMARY_HE))) continue;
      if (cells.includes(needle)) continue;
      count += 1;
    }
    return count;
  }, HAPOALIM_HEADER_HE);
}

// Clicks the expander button in row `index`. Hapoalim renders the toggle as
// the rightmost cell's chevron — `aria-expanded` flips when the panel opens.
// Returns true when the panel is visible.
async function expandHapoalimRow(target: Page | Frame, index: number): Promise<boolean> {
  const clicked = await (target as Page).evaluate(
    ({ needle, idx }: { needle: string; idx: number }) => {
      const headerCells: any[] = Array.from(document.querySelectorAll('th, td'));
      let table: any = null;
      for (const cell of headerCells) {
        if ((cell.textContent || '').trim() === needle) {
          table = cell.closest('table');
          if (table) break;
        }
      }
      if (!table) return false;
      const SUMMARY_HE = 'סה"כ';
      const dataRows: any[] = [];
      const trs: any[] = Array.from(table.querySelectorAll('tbody tr, tr'));
      for (const tr of trs) {
        const tds: any[] = Array.from(tr.querySelectorAll('td'));
        if (tds.length < 4) continue;
        const cells: string[] = tds.map((td: any) =>
          (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim(),
        );
        if (cells.some((c) => c.startsWith(SUMMARY_HE))) continue;
        if (cells.includes(needle)) continue;
        dataRows.push(tr);
      }
      const row = dataRows[idx];
      if (!row) return false;
      // Already expanded? aria-expanded on a button/cell inside the row.
      const toggles: any[] = Array.from(
        row.querySelectorAll('[aria-expanded], button, a, .toggle, [role="button"]'),
      );
      // Prefer an aria-expanded element since we can read state from it.
      let toggle: any =
        toggles.find((t: any) => t.hasAttribute && t.hasAttribute('aria-expanded')) || toggles[0];
      if (!toggle) {
        // Fall back to clicking the last cell (the "מידע ופעולות" column).
        const tds: any[] = Array.from(row.querySelectorAll('td'));
        toggle = tds[tds.length - 1];
      }
      if (!toggle) return false;
      if (toggle.getAttribute && toggle.getAttribute('aria-expanded') === 'true') return true;
      toggle.click();
      return true;
    },
    { needle: HAPOALIM_HEADER_HE, idx: index },
  );
  if (!clicked) return false;
  // Give the Angular animation a moment to settle and the panel content to
  // render. The detail panel only mounts once the row's expanded flag flips.
  await new Promise((r) => setTimeout(r, 600));
  return true;
}

interface HapoalimRowRaw {
  summaryCells: string[];
  detailText: string;
}

async function readHapoalimRow(
  target: Page | Frame,
  index: number,
): Promise<HapoalimRowRaw | null> {
  return (target as Page).evaluate(
    ({ needle, idx }: { needle: string; idx: number }) => {
      const SUMMARY_HE = 'סה"כ';
      const headerCells: any[] = Array.from(document.querySelectorAll('th, td'));
      let table: any = null;
      for (const cell of headerCells) {
        if ((cell.textContent || '').trim() === needle) {
          table = cell.closest('table');
          if (table) break;
        }
      }
      if (!table) return null;

      // Find the data rows in index order, then return the row's <td> texts
      // and the immediately-following row's text (Hapoalim renders the
      // detail panel as the sibling <tr> after the summary row, often with
      // a colspan-spanning <td>).
      const dataRows: any[] = [];
      const allRows: any[] = Array.from(table.querySelectorAll('tbody tr, tr'));
      for (const tr of allRows) {
        const tds: any[] = Array.from(tr.querySelectorAll('td'));
        if (tds.length < 4) continue;
        const cells: string[] = tds.map((td: any) =>
          (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim(),
        );
        if (cells.some((c) => c.startsWith(SUMMARY_HE))) continue;
        if (cells.includes(needle)) continue;
        dataRows.push(tr);
      }
      const row = dataRows[idx];
      if (!row) return null;
      const tds: any[] = Array.from(row.querySelectorAll('td'));
      const summaryCells: string[] = tds.map((td: any) =>
        (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim(),
      );

      // The detail panel can be either: (a) the very next <tr> sibling, or
      // (b) a div placed inside the same row that expands in-place. We grab
      // text from whichever sibling/child carries the "סידורי" anchor.
      const collected: string[] = [];
      const anchor = 'סידורי';
      const next = row.nextElementSibling as any;
      if (next && (next.innerText || '').includes(anchor)) {
        collected.push((next.innerText || next.textContent || '').toString());
      }
      // Some layouts place the panel inside the same row in a hidden cell.
      const inRow = Array.from(row.querySelectorAll('div, section')) as any[];
      for (const el of inRow) {
        const t = (el.innerText || el.textContent || '').toString();
        if (t.includes(anchor) && t.length > 30) {
          collected.push(t);
          break;
        }
      }
      const detailText = collected.join('\n').replace(/[ \t]+/g, ' ').trim();
      return { summaryCells, detailText };
    },
    { needle: HAPOALIM_HEADER_HE, idx: index },
  );
}

// Hapoalim's summary table in DOM order (RTL, so first <td> = rightmost):
//   0  סוג האשראי              loan name (e.g. "אוניברסיטה העברית ים")
//   1  הקרן                    original principal (e.g. 5,500.00)
//   2  יתרה משוערכת            current outstanding (CPI-revalued)
//   3  תשלום קרוב משוער        next payment
//   4  מועד התשלום הקרוב       next payment date  (DD/MM/YY)
//   5  שינוי בתשלומי ההלוואה   (text or empty)
//   6  למידע ופעולות           expander chevron
function parseHapoalimRow(raw: HapoalimRowRaw): ScrapedLoan | null {
  const cells = raw.summaryCells;
  if (cells.length < 5) return null;

  const nameCell = cells[0] || '';
  // The name cell ends with "ערוך כינוי" ("edit alias") link text — strip it.
  const name = nameCell.replace(/\s*ערוך כינוי\s*$/u, '').trim();
  if (!name) return null;

  const principal = parseMoney(cells[1]);
  const currentDebt = parseMoney(cells[2]);
  const nextPayment = parseMoney(cells[3]);

  const detail = raw.detailText || '';
  const serial = findLabelValue(detail, HAPOALIM_LABEL.serial);
  const startDate = parseDate(findLabelValue(detail, HAPOALIM_LABEL.startDate) ?? undefined);
  const endDate = parseDate(findLabelValue(detail, HAPOALIM_LABEL.endDate) ?? undefined);
  const rateType = findLabelValue(detail, HAPOALIM_LABEL.rateType) || '';
  const currentRate = findLabelValue(detail, HAPOALIM_LABEL.currentRate) || '';
  const cpiBase = findLabelValue(detail, HAPOALIM_LABEL.cpiBase) || '';
  // "הקרן: 1 מתוך 2" — second number is the total payment count.
  const principalCount = findLabelValue(detail, HAPOALIM_LABEL.principalCount) || '';
  const totalPayments = parseTotalPayments(principalCount);

  if (!Number.isFinite(principal) || !startDate) return null;

  const termMonths = totalPayments && totalPayments > 0
    ? totalPayments
    : endDate
      ? monthsBetweenDates(startDate, endDate)
      : 0;
  if (termMonths <= 0) return null;

  const isCpiLinked = !!cpiBase && cpiBase.trim() !== '-' && cpiBase.trim().length > 0;
  // Hapoalim labels prime as "פריים" inside the rate-type string. The
  // currentRate field carries the effective annual % ("6.00 | מיום ..."), so
  // we read it directly and let Hon's UI display it as a fixed rate snapshot.
  // Prime-tracking is recomputed each sync anyway — the user can re-sync
  // when prime moves and the new effective rate flows through.
  const isPrime = /פריים|prime/i.test(rateType);
  const rateValue = parseRateNumber(currentRate) ??
    parseRateNumber(findLabelValue(detail, HAPOALIM_LABEL.sourceRate) || '') ??
    0;

  // externalId: prefer "סידורי" (Hapoalim's per-account stable loan number).
  // Fall back to a name+startDate composite so we still upsert deterministically.
  const externalId = serial ? `hapoalim-${serial}` : `hapoalim-${name}-${startDate}`;

  return {
    externalId,
    name,
    principal,
    startDate,
    termMonths,
    isPrime,
    isCpiLinked,
    rateValue,
    currency: 'ILS',
    currentDebt: Number.isFinite(currentDebt) ? currentDebt : 0,
    nextPayment: Number.isFinite(nextPayment) ? nextPayment : null,
  };
}

// Pulls the value that follows a known Hebrew label in a free-text blob. The
// detail panel is rendered as label/value pairs on adjacent lines, so we
// match "label\nvalue" first and fall back to "label: value" / "label value".
function findLabelValue(text: string, label: string): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === label) {
      return lines[i + 1] ?? null;
    }
    if (line.startsWith(label + ':')) {
      return line.slice(label.length + 1).trim();
    }
    if (line.startsWith(label + ' ')) {
      const rest = line.slice(label.length).trim();
      if (rest) return rest;
    }
  }
  return null;
}

// Parses "1 מתוך 2" → 2 (total). Returns 0 when the value is missing.
function parseTotalPayments(s: string): number {
  if (!s) return 0;
  const m = s.match(/מתוך\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Parses "6.00", "6.00 | מיום 10/05/26", "P+0.50" etc. into a plain number.
// Prefer the first decimal-looking token; ignore everything after a separator.
function parseRateNumber(s: string): number | null {
  if (!s) return null;
  const m = s.replace(/[()]/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}
