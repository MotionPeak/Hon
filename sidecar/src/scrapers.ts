import { createHash } from 'node:crypto';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { CompanyTypes, SCRAPERS, createScraper } from 'israeli-bank-scrapers';
import type { ScraperCredentials, ScraperScrapingResult } from 'israeli-bank-scrapers';
import { SNAPTRADE_COMPANY_ID, snaptradeCompany } from './snaptrade.js';
import { PENSION_COMPANIES, isPensionCompany } from './pension.js';
import { watchForOtp, type OtpCallback } from './otp.js';
import { persistSession, restoreSession, type SessionHandle } from './session.js';
import { scrapeFibiLoans, supportsBankLoans, type ScrapedLoan } from './bankLoans.js';

// Extra Chromium flags for the scraper browser. Inside a container Chromium
// runs as root with no user namespace, so its sandbox cannot start — the Docker
// image sets HON_BROWSER_NO_SANDBOX=1 to drop it. On a normal desktop the
// sandbox stays on (the array is empty).
const BROWSER_ARGS: string[] =
  process.env.HON_BROWSER_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-setuid-sandbox']
    : [];

export type CompanyType = 'bank' | 'card' | 'brokerage' | 'pension';

export interface CompanyInfo {
  id: string;
  name: string;
  loginFields: string[];
  type: CompanyType;
  /** Website host, used to show the institution's favicon as a logo. */
  domain?: string;
  /** When true, syncing opens a visible browser for the user to sign in
   *  themselves (the portal is behind a CAPTCHA). No credentials are stored. */
  interactive?: boolean;
}

export interface NormalizedTransaction {
  externalId: string;
  date: string;
  processedDate?: string;
  amount: number;
  currency: string;
  description: string;
  memo?: string;
  kind?: string;
  status?: string;
  raw?: unknown;
}

/** A single brokerage security position (stock / ETF / crypto / fund). */
export interface NormalizedHolding {
  symbol: string;
  description?: string;
  units: number;
  price?: number;
  currency: string;
  /** Average purchase price per share, when the brokerage reports it. */
  costBasis?: number;
  /** Unrealized profit/loss on the position, as reported by the brokerage. */
  openPnl?: number;
}

export interface NormalizedAccount {
  accountNumber: string;
  label?: string;
  balance?: number;
  currency: string;
  transactions: NormalizedTransaction[];
  /** Set for brokerage accounts — the securities held in the account. */
  holdings?: NormalizedHolding[];
}

/** A daily equity point on a brokerage's historical chart. */
export interface PerformancePoint {
  date: string;
  value: number;
  currency?: string;
}

/** Per-timeframe SnapTrade stats. Rate of return, dividends and contributions
 *  are all window-scoped, so each pill the user picks (1M / 3M / YTD / 1Y /
 *  ALL) carries its own copy. The equity series is shared (sliced client-side
 *  from the ALL window). */
export interface BrokerageRangeStats {
  rateOfReturn: number | null;
  dividendIncome: number | null;
  contributions: number | null;
}

/**
 * The SnapTrade reporting payload Hon caches per brokerage connection. The
 * web app slices `totalEquity` for 1M / 3M / YTD / 1Y / ALL toggles without
 * a fresh API call; `byRange` holds the per-window summary numbers so tiles
 * like "Rate of return" and "Dividends" follow the active pill.
 */
export interface BrokeragePerformanceData {
  totalEquity: PerformancePoint[];
  contributionsCumulative?: PerformancePoint[];
  rateOfReturn?: number | null;
  dividendIncome?: number | null;
  contributions?: number | null;
  currency?: string;
  rangeStart: string;
  rangeEnd: string;
  /** Stats keyed by range — '1M' | '3M' | 'YTD' | '1Y' | 'ALL'. */
  byRange?: Record<string, BrokerageRangeStats>;
}

export interface ScrapeOutcome {
  success: boolean;
  accounts: NormalizedAccount[];
  errorType?: string;
  errorMessage?: string;
  /** Optional brokerage performance series, captured during a SnapTrade sync. */
  brokeragePerformance?: BrokeragePerformanceData;
  /** Loans pulled from the bank's loans page (FIBI-group today). The runner
   *  upserts these into the loans table keyed by the connection + bank id. */
  scrapedLoans?: ScrapedLoan[];
}

// Institutions excluded from the catalog. OneZero needs an interactive OTP
// retriever callback Hon's UI does not drive yet; behatsdaa and beyahadBishvilha
// are benefit-club programs the user does not want listed.
const UNSUPPORTED = new Set<string>([
  CompanyTypes.oneZero,
  'behatsdaa',
  'beyahadBishvilha',
]);

// israeli-bank-scrapers does not tag institutions by kind, so Hon classifies
// them. Anything not listed here is treated as a bank (a safe default for the
// banks that make up most of the catalog).
const COMPANY_TYPES: Record<string, CompanyType> = {
  max: 'card',
  visaCal: 'card',
  isracard: 'card',
  amex: 'card',
};

// Website host per institution, used only to fetch its favicon as a logo.
// A missing entry just means the UI falls back to a category icon.
const COMPANY_DOMAINS: Record<string, string> = {
  hapoalim: 'bankhapoalim.co.il',
  leumi: 'leumi.co.il',
  mizrahi: 'mizrahi-tefahot.co.il',
  discount: 'discountbank.co.il',
  mercantile: 'mercantile.co.il',
  union: 'unionbank.co.il',
  beinleumi: 'fibi.co.il',
  // Otsar Hahayal, Massad and Pagi are First International Bank Group banks;
  // their sites serve the shared FIBI group favicon, the same as Beinleumi.
  otsarHahayal: 'bankotsar.co.il',
  massad: 'bankmassad.co.il',
  pagi: 'pagi.co.il',
  yahav: 'bank-yahav.co.il',
  max: 'max.co.il',
  visaCal: 'cal-online.co.il',
  isracard: 'isracard.co.il',
  amex: 'americanexpress.co.il',
};

/** The institutions Hon can connect to, with the login fields each one needs. */
export function companyCatalog(): CompanyInfo[] {
  const scraped: CompanyInfo[] = Object.entries(SCRAPERS)
    .filter(([id]) => !UNSUPPORTED.has(id))
    .map(([id, info]) => ({
      id,
      name: (info as { name: string }).name,
      loginFields: (info as { loginFields: string[] }).loginFields,
      type: COMPANY_TYPES[id] ?? 'bank',
      domain: COMPANY_DOMAINS[id],
    }));
  return [...scraped, snaptradeCompany, ...PENSION_COMPANIES].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function isSupportedCompany(id: string): boolean {
  return (
    id === SNAPTRADE_COMPANY_ID ||
    isPensionCompany(id) ||
    (id in SCRAPERS && !UNSUPPORTED.has(id))
  );
}

/**
 * Logs into one institution and pulls accounts + transactions. Credentials are
 * used in memory only; they are never written to disk by the sidecar.
 *
 * The browser is launched by Hon (rather than by the scraper library) so a
 * saved session's cookies can be replayed before the login runs, and the
 * resulting cookies captured after it succeeds.
 */
export async function runScrape(
  companyId: string,
  credentials: Record<string, string>,
  startDate: Date,
  onProgress?: (progressType: string) => void,
  screenshotPath?: string,
  session?: SessionHandle,
): Promise<ScrapeOutcome> {
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
    await restoreSession(browser, session);

    const scraper = createScraper({
      companyId: companyId as CompanyTypes,
      startDate,
      combineInstallments: false,
      browser,
      skipCloseBrowser: true,
      timeout: 90_000,
      defaultTimeout: 60_000,
      // On failure, save a screenshot of the stuck page for diagnosis.
      storeFailureScreenShotPath: screenshotPath,
    });

    if (onProgress) {
      scraper.onProgress((_company, payload) => onProgress(payload.type));
    }

    let result: ScraperScrapingResult;
    try {
      result = await scraper.scrape(credentials as unknown as ScraperCredentials);
    } catch (err) {
      return {
        success: false,
        accounts: [],
        errorType: 'EXCEPTION',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (!result.success) {
      return {
        success: false,
        accounts: [],
        errorType: result.errorType ?? 'GENERIC',
        errorMessage: result.errorMessage ?? 'The scrape did not complete.',
      };
    }

    // Login succeeded — keep the session so the next sync can reuse it.
    await persistSession(browser, session);

    // FIBI-group banks have a loans page we know how to read; pull it before
    // the browser closes so the runner can upsert Loan rows alongside the
    // accounts. A failure here never breaks the main scrape; a debug HTML is
    // written next to the failure screenshot so a missing anchor can be
    // diagnosed by inspecting what the scraper actually rendered.
    let scrapedLoans: ScrapedLoan[] | undefined;
    if (supportsBankLoans(companyId)) {
      const loansDebugPath = screenshotPath
        ? screenshotPath.replace(/\.png$/i, '-loans.html')
        : undefined;
      try {
        scrapedLoans = await scrapeFibiLoans(browser, loansDebugPath);
      } catch (err) {
        console.error('[bank-loans] runScrape post-hook threw:', err);
        scrapedLoans = undefined;
      }
    }

    return {
      success: true,
      accounts: (result.accounts ?? []).map((account) =>
        normalizeAccount(account as unknown as RawAccount),
      ),
      scrapedLoans,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Like runScrape, but runs in a Hon-controlled headless browser with a 2FA
 * watcher: if the bank shows an OTP page, it is completed via `onOtpNeeded`.
 */
export async function runInteractiveScrape(
  companyId: string,
  credentials: Record<string, string>,
  startDate: Date,
  onProgress: ((progressType: string) => void) | undefined,
  screenshotPath: string | undefined,
  onOtpNeeded: OtpCallback,
  session?: SessionHandle,
): Promise<ScrapeOutcome> {
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
    const launched = browser;
    // Replay a saved session before the scrape: the bank may then trust this
    // device and skip the SMS step.
    await restoreSession(launched, session);

    // Capture the page israeli-bank-scrapers creates on our browser.
    const pagePromise = new Promise<Page>((resolve) => {
      launched.once('targetcreated', (target) => {
        void target.page().then((page) => {
          if (page) resolve(page);
        });
      });
    });

    const scraper = createScraper({
      companyId: companyId as CompanyTypes,
      startDate,
      combineInstallments: false,
      browser: launched,
      skipCloseBrowser: true,
      defaultTimeout: 240_000,
      storeFailureScreenShotPath: screenshotPath,
    });
    if (onProgress) {
      scraper.onProgress((_company, payload) => onProgress(payload.type));
    }

    const controller = new AbortController();
    const scrapePromise = scraper
      .scrape(credentials as unknown as ScraperCredentials)
      .finally(() => controller.abort());

    // Watch for (and complete) the 2FA page concurrently with the scrape.
    void pagePromise
      .then((page) => watchForOtp(page, onOtpNeeded, controller.signal))
      .catch(() => {});

    const result = await scrapePromise;
    if (!result.success) {
      return {
        success: false,
        accounts: [],
        errorType: result.errorType ?? 'GENERIC',
        errorMessage: result.errorMessage ?? 'The scrape did not complete.',
      };
    }
    // Login succeeded — keep the session so the next sync can reuse it.
    await persistSession(launched, session);

    // Same post-hook as runScrape: pull the bank's loans page for the FIBI
    // group while we still have an authenticated browser. Failure here never
    // breaks the main scrape; a debug HTML is dumped beside the failure
    // screenshot when the anchor cannot be found.
    let scrapedLoans: ScrapedLoan[] | undefined;
    if (supportsBankLoans(companyId)) {
      const loansDebugPath = screenshotPath
        ? screenshotPath.replace(/\.png$/i, '-loans.html')
        : undefined;
      try {
        scrapedLoans = await scrapeFibiLoans(launched, loansDebugPath);
      } catch (err) {
        console.error('[bank-loans] runInteractiveScrape post-hook threw:', err);
        scrapedLoans = undefined;
      }
    }

    return {
      success: true,
      accounts: (result.accounts ?? []).map((account) =>
        normalizeAccount(account as unknown as RawAccount),
      ),
      scrapedLoans,
    };
  } catch (err) {
    return {
      success: false,
      accounts: [],
      errorType: 'EXCEPTION',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// --- Normalization ----------------------------------------------------------
// Minimal shapes for the fields Hon reads from israeli-bank-scrapers output.

interface RawTransaction {
  type?: string;
  identifier?: string | number;
  date: string;
  processedDate?: string;
  originalAmount: number;
  originalCurrency?: string;
  chargedAmount: number;
  chargedCurrency?: string;
  description: string;
  memo?: string;
  status?: string;
}

interface RawAccount {
  accountNumber: string;
  balance?: number;
  txns: RawTransaction[];
}

function normalizeAccount(account: RawAccount): NormalizedAccount {
  // A scraper that fails to parse a balance yields NaN; store null instead so
  // it reads as "unknown" rather than corrupting the column.
  const balance =
    typeof account.balance === 'number' && Number.isFinite(account.balance)
      ? account.balance
      : undefined;
  return {
    accountNumber: account.accountNumber,
    balance,
    currency: 'ILS',
    transactions: (account.txns ?? []).map(normalizeTransaction),
  };
}

// israeli-bank-scrapers reports transaction dates as UTC ISO timestamps pinned
// to local midnight — in Israel that lands on the previous evening, so storing
// the raw string files every transaction one calendar day (and 1st-of-month
// transactions a whole month) early. Reduce to the Asia/Jerusalem calendar date.
function israelDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function normalizeTransaction(txn: RawTransaction): NormalizedTransaction {
  const date = israelDate(txn.date);
  // An institution's identifier is not unique on its own: banks reuse a
  // reference number across recurring deposits, and card installments share
  // one id across months. (A non-numeric reference also parses to NaN.)
  // Pairing it with the date keeps each occurrence a distinct row instead of
  // overwriting the previous one through the (account_id, external_id) upsert.
  const id = txn.identifier;
  const hasIdentifier =
    id != null &&
    String(id).length > 0 &&
    !(typeof id === 'number' && Number.isNaN(id));
  const base = hasIdentifier ? String(id) : fingerprint(txn);
  return {
    externalId: `${base}:${date}`,
    date,
    processedDate: txn.processedDate ? israelDate(txn.processedDate) : undefined,
    amount: txn.chargedAmount,
    currency: txn.chargedCurrency ?? txn.originalCurrency ?? 'ILS',
    description: txn.description,
    memo: txn.memo,
    kind: txn.type,
    status: txn.status,
  };
}

/** Stable id for transactions the institution did not give an identifier. */
function fingerprint(txn: RawTransaction): string {
  return createHash('sha1')
    .update([txn.date, txn.chargedAmount, txn.description, txn.memo ?? ''].join('|'))
    .digest('hex')
    .slice(0, 16);
}
