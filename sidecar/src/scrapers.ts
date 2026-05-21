import { createHash } from 'node:crypto';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { CompanyTypes, SCRAPERS, createScraper } from 'israeli-bank-scrapers';
import type { ScraperCredentials, ScraperScrapingResult } from 'israeli-bank-scrapers';
import { SNAPTRADE_COMPANY_ID, snaptradeCompany } from './snaptrade.js';
import { watchForOtp, type OtpCallback } from './otp.js';

export type CompanyType = 'bank' | 'card' | 'brokerage';

export interface CompanyInfo {
  id: string;
  name: string;
  loginFields: string[];
  type: CompanyType;
  /** Website host, used to show the institution's favicon as a logo. */
  domain?: string;
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

export interface NormalizedAccount {
  accountNumber: string;
  label?: string;
  balance?: number;
  currency: string;
  transactions: NormalizedTransaction[];
}

export interface ScrapeOutcome {
  success: boolean;
  accounts: NormalizedAccount[];
  errorType?: string;
  errorMessage?: string;
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
  return [...scraped, snaptradeCompany].sort((a, b) => a.name.localeCompare(b.name));
}

export function isSupportedCompany(id: string): boolean {
  return id === SNAPTRADE_COMPANY_ID || (id in SCRAPERS && !UNSUPPORTED.has(id));
}

/**
 * Logs into one institution and pulls accounts + transactions. Credentials are
 * used in memory only; they are never written to disk by the sidecar.
 */
export async function runScrape(
  companyId: string,
  credentials: Record<string, string>,
  startDate: Date,
  onProgress?: (progressType: string) => void,
  screenshotPath?: string,
): Promise<ScrapeOutcome> {
  const scraper = createScraper({
    companyId: companyId as CompanyTypes,
    startDate,
    combineInstallments: false,
    showBrowser: false,
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

  return {
    success: true,
    accounts: (result.accounts ?? []).map((account) =>
      normalizeAccount(account as unknown as RawAccount),
    ),
  };
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
  htmlDumpPath: string,
  onOtpNeeded: OtpCallback,
): Promise<ScrapeOutcome> {
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({ headless: true });
    const launched = browser;

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
      .then((page) => watchForOtp(page, onOtpNeeded, htmlDumpPath, controller.signal))
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
    return {
      success: true,
      accounts: (result.accounts ?? []).map((account) =>
        normalizeAccount(account as unknown as RawAccount),
      ),
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
  return {
    accountNumber: account.accountNumber,
    balance: account.balance,
    currency: 'ILS',
    transactions: (account.txns ?? []).map(normalizeTransaction),
  };
}

function normalizeTransaction(txn: RawTransaction): NormalizedTransaction {
  const hasIdentifier = txn.identifier != null && String(txn.identifier).length > 0;
  return {
    externalId: hasIdentifier ? String(txn.identifier) : fingerprint(txn),
    date: txn.date,
    processedDate: txn.processedDate,
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
