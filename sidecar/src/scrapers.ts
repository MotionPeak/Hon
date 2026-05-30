import { createHash } from 'node:crypto';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { CompanyTypes, SCRAPERS, createScraper } from 'israeli-bank-scrapers';
import type { ScraperCredentials, ScraperScrapingResult } from 'israeli-bank-scrapers';
import { SNAPTRADE_COMPANY_ID, snaptradeCompany } from './snaptrade.js';
import { PENSION_COMPANIES, isPensionCompany } from './pension.js';
import { watchForOtp, type OtpCallback } from './otp.js';
import { persistSession, restoreSession, type SessionHandle } from './session.js';
import { scrapeBankLoans, supportsBankLoans, type ScrapedLoan } from './bankLoans.js';
import { scrapeDiscountKerenKaspit } from './discountSavings.js';
import { makeLog } from './log.js';

// One logger per scrape mode so the tag identifies whether the line came
// from the headless library path, the interactive-with-2FA path, or post-
// scrape normalization. `child(companyId)` adds the bank/card name to the
// tag at call time (`[scrape:headless:hapoalim]`, etc).
const scrapeLog = makeLog('scrape:headless');
const interactiveLog = makeLog('scrape:interactive');
const normalizeLog = makeLog('scrape:normalize');

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
  /** Bank-reported current market value in `currency`. Pass-through when
   *  the broker hands it through (Discount's Tmura field); when absent the
   *  UI falls back to `units × price`. Needed because Israeli securities
   *  quote prices in agorot but value in NIS — a 100× gap. */
  value?: number;
}

export interface NormalizedAccount {
  accountNumber: string;
  label?: string;
  balance?: number;
  currency: string;
  transactions: NormalizedTransaction[];
  /** Set for brokerage accounts — the securities held in the account. */
  holdings?: NormalizedHolding[];
  /** Provider-discovered "when this account was first active" date
   *  (YYYY-MM-DD). SnapTrade computes it from the earliest activity in
   *  getActivities; other connectors can fill it as they learn it. The repo
   *  saves it only when the account has no user-set inception date yet — a
   *  manual override always wins. */
  inceptionDate?: string;
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
  /** True when SnapTrade's performance feature is disabled for this plan
   *  (every reporting range returned 403 code 1141). The runner persists
   *  this so the UI can degrade and future syncs can skip the dead calls. */
  performanceDisabled?: boolean;
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

// Banks the in-browser OTP watcher knows how to drive. Each id here selects
// a per-bank driver in `otp.ts` (FIBI-group portals share one; Hapoalim
// has its own). Anything not listed leans on the underlying
// israeli-bank-scrapers library to handle login — running our watcher
// against an unknown portal risks misfiring on coincidental Hebrew text.
const HON_OTP_WATCHER_COMPANIES = new Set<string>([
  'beinleumi',
  'otsarHahayal',
  'massad',
  'pagi',
  // Hapoalim's library scraper has no OTP code — when the bank shows its
  // 2FA page the library just hangs. Hon's watcher fills the gap with a
  // Hapoalim-shaped driver (input[autocomplete=one-time-code], "שלח קוד",
  // "המשך"). Selectors are best-effort across portal versions.
  'hapoalim',
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
  const log = scrapeLog.child(companyId);
  const overall = log.timer('run', {
    startDate: startDate.toISOString().slice(0, 10),
    hasSession: !!session,
    screenshotPath: screenshotPath ?? null,
  });
  let browser: Browser | undefined;
  try {
    const launchDone = log.timer('browser.launch', {
      headless: true,
      sandbox: process.env.HON_BROWSER_NO_SANDBOX !== '1',
    });
    browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
    launchDone();
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

    // Always wire onProgress, even when the caller didn't supply one, so the
    // engine logs library lifecycle events — INITIALIZING, LOGGING_IN,
    // LOGIN_SUCCESS, etc. Each one is invaluable when a scrape hangs and you
    // need to know WHERE in the flow it stopped.
    scraper.onProgress((_company, payload) => {
      log.info('library.progress', { type: payload.type });
      onProgress?.(payload.type);
    });

    let result: ScraperScrapingResult;
    try {
      const scrapeDone = log.timer('library.scrape');
      result = await scraper.scrape(credentials as unknown as ScraperCredentials);
      scrapeDone({ success: result.success, errorType: result.errorType });
    } catch (err) {
      log.error('library.scrape.threw', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      overall({ result: 'exception' });
      return {
        success: false,
        accounts: [],
        errorType: 'EXCEPTION',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (!result.success) {
      log.error('library.unsuccessful', {
        errorType: result.errorType,
        errorMessage: result.errorMessage,
      });
      overall({ result: 'error', errorType: result.errorType });
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
        scrapedLoans = await scrapeBankLoans(companyId, browser, loansDebugPath);
      } catch (err) {
        log.error('loans.post-hook.threw', {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        scrapedLoans = undefined;
      }
    }

    const accounts = (result.accounts ?? []).map((account) =>
      normalizeAccount(account as unknown as RawAccount, log),
    );

    // Discount specifically: pull the קרן-כספית balance from the still-open
    // session and surface it as a synthetic account on the same connection.
    // The stable accountNumber `keren-kaspit-<id>` keeps a re-sync upserting
    // the same row rather than creating a new one each time.
    if (companyId === 'discount') {
      await appendDiscountKerenKaspit(browser, accounts, log);
    }

    overall({
      result: 'success',
      accounts: accounts.length,
      transactions: accounts.reduce((s, a) => s + a.transactions.length, 0),
      loans: scrapedLoans?.length ?? 0,
    });
    return { success: true, accounts, scrapedLoans };
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
  const log = interactiveLog.child(companyId);
  const overall = log.timer('run', {
    startDate: startDate.toISOString().slice(0, 10),
    hasSession: !!session,
    screenshotPath: screenshotPath ?? null,
    otpWatcher: HON_OTP_WATCHER_COMPANIES.has(companyId),
  });
  let browser: Browser | undefined;
  try {
    const launchDone = log.timer('browser.launch');
    browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS });
    launchDone();
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
    // Always wire onProgress for logging, even when the caller didn't supply
    // one — every library lifecycle event needs to be visible in the logs.
    scraper.onProgress((_company, payload) => {
      log.info('library.progress', { type: payload.type });
      onProgress?.(payload.type);
    });

    const controller = new AbortController();
    const scrapeDone = log.timer('library.scrape');
    const scrapePromise = scraper
      .scrape(credentials as unknown as ScraperCredentials)
      .finally(() => controller.abort());
    // If the OTP-failure arm wins the race below, this scrapePromise is left
    // pending — the library is still grinding toward its own timeout. Once the
    // browser is closed in `finally`, the library call will reject (Target
    // closed). Swallow that here so it can't surface as an unhandled rejection
    // AFTER this function has already returned its error outcome (H-5).
    scrapePromise.catch((err) => {
      log.info('library.scrape.lateError', {
        message: err instanceof Error ? err.message : String(err),
      });
    });

    // The OTP watcher looks for generic Hebrew/English 2FA phrases ("סיסמה
    // חד פעמית", "קוד אימות", etc.) and then dispatches to a per-bank
    // driver in `otp.ts`. We still scope it to known banks — running it
    // against Max / Isracard / Cal / Amex risks misfiring on any page
    // that coincidentally contains those phrases. The driver name passed
    // through is the company id so otp.ts can pick FIBI vs. Hapoalim.
    //
    // watchForOtp rejects when it cannot complete the 2FA step — most
    // importantly when onOtpNeeded() rejects with `otp.timeout` after the
    // user abandoned the prompt (H-5). We surface that rejection on a
    // dedicated promise and RACE it against the main scrape: if the OTP wait
    // fails, the race rejects, control falls into this function's catch and
    // then `finally { browser.close() }`, tearing the Puppeteer browser down
    // immediately instead of leaving Chrome pinned for the library's full
    // 240s defaultTimeout. controller.abort() also stops the watcher's poll
    // loop. The promise is created even when the watcher is disabled so the
    // race below always has two arms — a never-rejecting placeholder then.
    // This arm only ever REJECTS (on an OTP failure) — it never resolves, so
    // when the watcher completes 2FA happily the scrape promise is the only one
    // that can settle the race. A resolving arm would make Promise.race yield
    // `undefined` and break `result.success` below.
    const otpFailure: Promise<never> = new Promise<never>((_, reject) => {
      if (!HON_OTP_WATCHER_COMPANIES.has(companyId)) {
        // No watcher for this bank → leave the promise pending forever; the
        // scrape promise wins the race unconditionally.
        return;
      }
      log.info('otp.watcher.armed', { companyId });
      void pagePromise
        .then((page) => watchForOtp(page, onOtpNeeded, controller.signal, companyId))
        .then(
          () => {
            // 2FA handled (or no 2FA was needed). Do nothing — let the scrape
            // promise settle the race normally.
          },
          (err) => {
            // OTP wait/drive failed — most importantly onOtpNeeded() rejecting
            // with `otp.timeout`. Abort the watcher loop and reject the race so
            // the awaited path unwinds into `finally { browser.close() }` (H-5).
            controller.abort();
            log.warn('otp.watcher.threw', {
              message: err instanceof Error ? err.message : String(err),
            });
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
    });

    // Whichever settles first wins: a normal scrape result, or an OTP-watcher
    // rejection we propagate so the catch + finally close the browser promptly.
    const result = await Promise.race([scrapePromise, otpFailure]);
    scrapeDone({ success: result.success, errorType: result.errorType });
    if (!result.success) {
      log.error('library.unsuccessful', {
        errorType: result.errorType,
        errorMessage: result.errorMessage,
      });
      overall({ result: 'error', errorType: result.errorType });
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
        scrapedLoans = await scrapeBankLoans(companyId, launched, loansDebugPath);
      } catch (err) {
        log.error('loans.post-hook.threw', {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        scrapedLoans = undefined;
      }
    }

    const accounts = (result.accounts ?? []).map((account) =>
      normalizeAccount(account as unknown as RawAccount, log),
    );

    // Discount: pull the קרן-כספית balance through the same authenticated
    // session and append it as a synthetic account on the connection.
    if (companyId === 'discount') {
      await appendDiscountKerenKaspit(launched, accounts, log);
    }

    overall({
      result: 'success',
      accounts: accounts.length,
      transactions: accounts.reduce((s, a) => s + a.transactions.length, 0),
      loans: scrapedLoans?.length ?? 0,
    });
    return { success: true, accounts, scrapedLoans };
  } catch (err) {
    log.error('run.threw', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    overall({ result: 'exception' });
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

// Exported for the test suite; the production runtime never references this
// from outside the module — it's an internal shape mirroring what
// israeli-bank-scrapers' Transaction type carries.
export interface RawTransaction {
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

/**
 * Hits Discount's gateway API for the user's קרן-כספית balance and pushes
 * it onto `accounts` as a synthetic row. The accountNumber is derived from
 * the user's primary account so a re-sync upserts the same row rather than
 * stacking duplicates. Best-effort — a failure is logged and the run still
 * succeeds with whatever accounts the underlying scraper found.
 */
async function appendDiscountKerenKaspit(
  browser: Browser,
  accounts: NormalizedAccount[],
  log: ReturnType<typeof makeLog>,
): Promise<void> {
  let page: Page | undefined;
  try {
    // Open a fresh page on the browser — the library closes its working
    // page after the scrape but the session cookies stay on the browser
    // context, so a new page is already logged in.
    page = await browser.newPage();
    // The retail3 portfolio endpoints require the customer's account number
    // in the AccountNumber header — the SPA passes it on every securities
    // call. Use the primary account from the underlying scrape; the
    // gateway scopes the response to that customer either way.
    const primary = accounts[0]?.accountNumber ?? 'discount';
    const holdings = await scrapeDiscountKerenKaspit(page, primary);
    if (!holdings.length) return;
    const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
    // One synthetic account carries every money-market position as a
    // holding row — that way the Discount tile shows a single "קרן כספית"
    // line with the total, the per-holding rows are visible when the user
    // expands it, and the Insights brokerage view picks up each position
    // independently (via the holdings table).
    accounts.push({
      accountNumber: `keren-kaspit-${primary}`,
      label: 'קרן כספית',
      balance: totalValue,
      currency: 'ILS',
      transactions: [],
      holdings: holdings.map((h) => ({
        symbol: h.symbol,
        description: h.paperName,
        units: h.units,
        price: h.price,
        currency: 'ILS',
        // Discount quotes price in agorot (e.g. 101.75) but the holding
        // value comes through in NIS (Tmura). Pass it explicitly so the
        // UI doesn't try to compute units × agorot-price.
        value: h.marketValue,
      })),
    });
    log.info('discount.keren.attached', {
      total: totalValue, positions: holdings.length,
    });
  } catch (err) {
    log.warn('discount.keren.failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

interface RawAccount {
  accountNumber: string;
  balance?: number;
  txns: RawTransaction[];
}

function normalizeAccount(
  account: RawAccount,
  log = normalizeLog,
): NormalizedAccount {
  // A scraper that fails to parse a balance yields NaN; store null instead so
  // it reads as "unknown" rather than corrupting the column.
  const balance =
    typeof account.balance === 'number' && Number.isFinite(account.balance)
      ? account.balance
      : undefined;
  const transactions = (account.txns ?? []).map(normalizeTransaction);
  // One summary line per account so a "wrong balance" or "missing txns"
  // problem is visible at a glance. Date range is included because a
  // narrow window often points to monthsBack being too small for the bank.
  const dates = transactions.map((t) => t.date).filter(Boolean).sort();
  log.info('account', {
    account: account.accountNumber,
    balance: balance ?? null,
    txns: transactions.length,
    firstTxn: dates[0] ?? null,
    lastTxn: dates[dates.length - 1] ?? null,
    balanceParsed: typeof account.balance === 'number' && Number.isFinite(account.balance),
  });
  return {
    accountNumber: account.accountNumber,
    balance,
    currency: 'ILS',
    transactions,
  };
}

// israeli-bank-scrapers reports transaction dates as UTC ISO timestamps pinned
// to local midnight — in Israel that lands on the previous evening, so storing
// the raw string files every transaction one calendar day (and 1st-of-month
// transactions a whole month) early. Reduce to the Asia/Jerusalem calendar date.
/**
 * Reduces a UTC ISO timestamp to its Asia/Jerusalem calendar date.
 * israeli-bank-scrapers reports dates as UTC midnight, which lands on the
 * previous evening in Israel — storing the raw string would file every
 * transaction one calendar day (and 1st-of-month transactions a whole
 * month) early. Exported so the test suite can pin the DST + crossover
 * cases. */
export function israelDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

// Exported for the test suite — the rest of the code path runs it via
// normalizeAccount (which iterates a raw account's txns and maps each).
export function normalizeTransaction(txn: RawTransaction): NormalizedTransaction {
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
  // Prefer chargedAmount, but fall back to originalAmount when the charge
  // hasn't been billed yet (Max's pending rows ship with chargedAmount = 0
  // until the bank finalises the figure). Only safe when both fields are in
  // the same currency — for foreign purchases originalAmount is in the
  // merchant's currency and would need FX conversion before becoming a
  // chargedAmount equivalent, so we leave those at 0 and let the next sync
  // update the row once the conversion lands.
  const sameCurrency = txn.chargedCurrency === txn.originalCurrency
    || !txn.chargedCurrency || !txn.originalCurrency;
  const amount = (typeof txn.chargedAmount === 'number' && txn.chargedAmount !== 0)
    ? txn.chargedAmount
    : (sameCurrency && typeof txn.originalAmount === 'number' && txn.originalAmount !== 0
        ? txn.originalAmount
        : txn.chargedAmount);
  return {
    externalId: `${base}:${date}`,
    date,
    processedDate: txn.processedDate ? israelDate(txn.processedDate) : undefined,
    amount,
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
