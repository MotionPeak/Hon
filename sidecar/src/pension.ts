// Pension / קרן השתלמות connector.
//
// Israeli pension, gemel and study-fund (קרן השתלמות) providers each run their
// own member portal — there is no shared scraping library for them the way
// israeli-bank-scrapers covers the banks. This connector logs into a provider's
// portal in a Hon-controlled Puppeteer browser, completes any SMS one-time-code
// step, and reads the accumulated balance of every product the member holds.
//
// Migdal and Altshuler Shaham are both Angular single-page apps behind a WAF,
// with ID-number + password login (Altshuler additionally runs an invisible
// reCAPTCHA v3). Their post-login dashboards differ and cannot be inspected
// without real credentials, so the balance reader is a best-effort heuristic
// that always dumps the rendered page + JSON responses to <dataDir>/debug —
// the material needed to tighten it after a real login.

import { writeFileSync } from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { CompanyInfo, NormalizedAccount, ScrapeOutcome } from './scrapers.js';
import type { OtpCallback } from './otp.js';

// page.evaluate runs its callback in the browser, where these globals exist.
declare const document: any;
declare const location: any;

interface PensionFund {
  id: string;
  /** Shown in the catalog / Add-connection picker. */
  name: string;
  /** Website host, used to show the provider's favicon as a logo. */
  domain: string;
  /** Member-portal login URL. */
  loginUrl: string;
}

const FUNDS: Record<string, PensionFund> = {
  migdal: {
    id: 'migdal',
    name: 'Migdal (מגדל)',
    domain: 'migdal.co.il',
    loginUrl: 'https://my.migdal.co.il/mymigdal/process/login',
  },
  altshulerShaham: {
    id: 'altshulerShaham',
    name: 'Altshuler Shaham (אלטשולר שחם)',
    domain: 'as-invest.co.il',
    loginUrl: 'https://online.as-invest.co.il/login',
  },
};

/** Catalog entries so the pension funds appear in the Add-connection picker. */
export const PENSION_COMPANIES: CompanyInfo[] = Object.values(FUNDS).map((fund) => ({
  id: fund.id,
  name: fund.name,
  loginFields: ['id', 'password'],
  type: 'pension',
  domain: fund.domain,
}));

export function isPensionCompany(companyId: string): boolean {
  return Object.prototype.hasOwnProperty.call(FUNDS, companyId);
}

// Set HON_PENSION_HEADFUL=1 to scrape with a visible browser — a real window
// scores higher with Altshuler's invisible reCAPTCHA v3 if a headless run is
// rejected.
const HEADLESS = process.env.HON_PENSION_HEADFUL !== '1';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Phrases that mark the SMS one-time-password step.
const OTP_HINTS = [
  'סיסמה חד פעמית', 'סיסמה חד-פעמית', 'קוד חד פעמי', 'קוד חד-פעמי',
  'קוד אימות', 'קוד שנשלח', 'הזן את הקוד', 'הזינו את הקוד',
  'one-time password', 'one time password', 'verification code',
];

// Phrases that mark a rejected ID number / password.
const LOGIN_ERROR_HINTS = [
  'שם המשתמש או הסיסמה', 'הפרטים שהוזנו', 'פרטים שגויים', 'סיסמה שגויה',
  'שגויים', 'לא תקין', 'נסה שנית', 'incorrect', 'invalid',
];

// Product keywords used to recognise a pension / gemel / study-fund balance.
const PRODUCT_KEYWORDS = [
  'קרן השתלמות', 'השתלמות', 'קופת גמל', 'גמל להשקעה', 'גמל',
  'קרן פנסיה', 'פנסיה', 'תגמולים', 'פיצויים', 'ביטוח מנהלים',
  'קצבה', 'חיסכון',
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(errorType: string, errorMessage: string): ScrapeOutcome {
  return { success: false, accounts: [], errorType, errorMessage };
}

/** Derives a debug-file path next to the run's failure screenshot. */
function debugSibling(screenshotPath: string | undefined, suffix: string): string | undefined {
  return screenshotPath ? screenshotPath.replace(/\.png$/i, suffix) : undefined;
}

/**
 * Logs into a pension provider's member portal and reads each product's
 * balance. Mirrors runInteractiveScrape's shape (Puppeteer + OTP callback) but
 * drives the whole login itself, since pension funds have no scraper library.
 */
export async function runPensionScrape(
  companyId: string,
  credentials: Record<string, string>,
  onProgress: ((message: string) => void) | undefined,
  screenshotPath: string | undefined,
  onOtpNeeded: OtpCallback,
): Promise<ScrapeOutcome> {
  const fund = FUNDS[companyId];
  if (!fund) return fail('CONFIG', `Unknown pension fund: ${companyId}`);

  const id = (credentials.id ?? '').trim();
  const password = credentials.password ?? '';
  if (!id || !password) {
    return fail('CONFIG', 'This pension connection needs an ID number and a password.');
  }

  const htmlPath = debugSibling(screenshotPath, '-pension.html');
  const dataPath = debugSibling(screenshotPath, '-pension.json');
  const jsonResponses: { url: string; body: string }[] = [];

  let browser: Browser | undefined;
  try {
    onProgress?.('Starting the browser…');
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--disable-blink-features=AutomationControlled', '--lang=he-IL'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });

    // Collect JSON API responses — the dashboard's real balance data, and the
    // best material for tightening the balance reader after a real run.
    page.on('response', (res) => {
      const contentType = res.headers()['content-type'] ?? '';
      if (!contentType.includes('json') || jsonResponses.length >= 60) return;
      res
        .text()
        .then((body) => {
          if (body && body.length < 200_000) {
            jsonResponses.push({ url: res.url(), body });
          }
        })
        .catch(() => {});
    });

    onProgress?.('Opening the pension portal…');
    await page.goto(fund.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    onProgress?.('Logging in…');
    if (!(await fillCredentials(page, id, password))) {
      await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);
      return fail(
        'LOGIN_FAILED',
        'Could not find the login form on the portal. A debug page was saved.',
      );
    }
    await submitLogin(page);

    // Wait for the portal to settle into the OTP step, the dashboard, or an error.
    onProgress?.('Waiting for the portal…');
    let handledOtp = false;
    let deadline = Date.now() + 150_000;
    let reached: PageState = 'unknown';
    while (Date.now() < deadline) {
      await delay(2000);
      const state = await classifyState(page);
      if (state === 'otp' && !handledOtp) {
        onProgress?.('Waiting for the verification code…');
        await maybeSendOtp(page);
        const code = await onOtpNeeded();
        onProgress?.('Submitting the verification code…');
        await enterOtpCode(page, (code ?? '').trim());
        handledOtp = true;
        deadline = Date.now() + 90_000; // give the post-OTP dashboard time
        continue;
      }
      if (state === 'dashboard') {
        reached = 'dashboard';
        break;
      }
      if (state === 'error') {
        await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);
        return fail('INVALID_PASSWORD', 'The portal rejected the ID number or password.');
      }
    }

    onProgress?.('Reading your balances…');
    await delay(3500); // let the dashboard's data calls finish
    const accounts = await readBalances(page);
    await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);

    if (accounts.length === 0) {
      const where = reached === 'dashboard' ? 'Signed in' : 'Reached the portal';
      return fail(
        'NEEDS_SELECTORS',
        `${where}, but could not read the balances automatically yet — the ` +
          'portal layout still needs mapping. The rendered page was saved to the ' +
          'debug folder.',
      );
    }
    return { success: true, accounts };
  } catch (err) {
    if (browser) {
      const pages = await browser.pages().catch(() => []);
      if (pages[0]) {
        await saveDebug(pages[0], screenshotPath, htmlPath, dataPath, jsonResponses);
      }
    }
    return fail('EXCEPTION', err instanceof Error ? err.message : String(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

type PageState = 'login' | 'otp' | 'dashboard' | 'error' | 'unknown';

/** Best-effort read of which stage of the login the portal is showing. */
async function classifyState(page: Page): Promise<PageState> {
  try {
    return (await page.evaluate(
      (otpHints: string[], errorHints: string[]) => {
        const text: string = document.body ? document.body.innerText : '';
        const url: string = String(location.href).toLowerCase();
        const has = (hints: string[]): boolean => hints.some((h) => text.includes(h));
        const passwordShown = Array.from(
          document.querySelectorAll('input[type=password]'),
        ).some((el: any) => Boolean(el.offsetWidth || el.offsetHeight));
        if (has(otpHints)) return 'otp';
        if (!passwordShown && !/login|signin|log-in/.test(url)) return 'dashboard';
        if (passwordShown && has(errorHints)) return 'error';
        return passwordShown ? 'login' : 'unknown';
      },
      OTP_HINTS,
      LOGIN_ERROR_HINTS,
    )) as PageState;
  } catch {
    return 'unknown';
  }
}

/**
 * Fills the ID number + password fields. The login form is tagged in-page and
 * then typed into with real keystrokes — Angular reactive forms ignore values
 * written programmatically.
 */
async function fillCredentials(page: Page, id: string, password: string): Promise<boolean> {
  try {
    await page.waitForSelector('input[type=password]', { visible: true, timeout: 45_000 });
  } catch {
    return false;
  }
  const tagged = await page.evaluate(() => {
    const inputs: any[] = Array.from(document.querySelectorAll('input'));
    const visible = (el: any): boolean => Boolean(el.offsetWidth || el.offsetHeight);
    const password = inputs.find(
      (el: any) =>
        (el.getAttribute('type') || '').toLowerCase() === 'password' && visible(el),
    );
    // The ID field is the first visible, editable, text-like input on the form.
    const idField = inputs.find((el: any) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      const textLike = ['text', 'tel', 'number', 'email', ''].includes(type);
      return textLike && visible(el) && !el.disabled && !el.readOnly;
    });
    if (!password || !idField) return false;
    idField.setAttribute('data-hon-id', '1');
    password.setAttribute('data-hon-pw', '1');
    return true;
  });
  if (!tagged) return false;
  await page.click('[data-hon-id]', { clickCount: 3 });
  await page.type('[data-hon-id]', id, { delay: 45 });
  await page.click('[data-hon-pw]', { clickCount: 3 });
  await page.type('[data-hon-pw]', password, { delay: 45 });
  return true;
}

/** Clicks the login form's submit button (a real submit, or one matched by text). */
async function submitLogin(page: Page): Promise<void> {
  await delay(500); // let Angular validate the form and enable the button
  const clicked = await page.evaluate((labels: string[]) => {
    const nodes: any[] = Array.from(
      document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]'),
    );
    const enabled = (n: any): boolean =>
      !n.disabled && n.getAttribute('aria-disabled') !== 'true';
    const submit = nodes.find(
      (n: any) => (n.getAttribute('type') || '').toLowerCase() === 'submit' && enabled(n),
    );
    const byText = nodes.find((n: any) => {
      const t = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
      return enabled(n) && labels.some((l) => t.includes(l));
    });
    const pick = submit || byText;
    if (pick) {
      pick.click();
      return true;
    }
    return false;
  }, ['כניסה', 'התחבר', 'התחברות', 'המשך', 'אישור', 'Login', 'Sign in', 'Log in']);
  if (!clicked) await page.keyboard.press('Enter');
}

/** If the OTP step has an explicit "send code" button, clicks it. */
async function maybeSendOtp(page: Page): Promise<void> {
  try {
    await page.evaluate((labels: string[]) => {
      const nodes: any[] = Array.from(
        document.querySelectorAll('button, input[type=submit], input[type=button], a, [role=button]'),
      );
      const pick = nodes.find((n: any) => {
        const t = (
          n.innerText ||
          n.value ||
          n.getAttribute('title') ||
          n.getAttribute('aria-label') ||
          ''
        ).trim();
        return !n.disabled && labels.some((l) => t.includes(l));
      });
      if (pick) pick.click();
    }, ['שלח קוד', 'שליחת קוד', 'קבלת קוד', 'שלח לי', 'שלחו לי', 'שלח שוב', 'send code', 'resend']);
    await delay(800);
  } catch {
    // best-effort — most portals send the SMS automatically
  }
}

/** Types the verification code into the OTP field and submits it. */
async function enterOtpCode(page: Page, code: string): Promise<void> {
  const tagged = await page.evaluate(() => {
    const inputs: any[] = Array.from(document.querySelectorAll('input'));
    const field = inputs.find((el: any) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      const textLike = ['text', 'tel', 'number', 'password', ''].includes(type);
      const visible = Boolean(el.offsetWidth || el.offsetHeight);
      return textLike && visible && !el.disabled && !el.readOnly && !el.value;
    });
    if (!field) return false;
    field.setAttribute('data-hon-otp', '1');
    return true;
  });
  if (tagged) {
    await page.click('[data-hon-otp]', { clickCount: 3 });
    await page.type('[data-hon-otp]', code, { delay: 60 });
  }
  await delay(400);
  const submitted = await page.evaluate((labels: string[]) => {
    const nodes: any[] = Array.from(
      document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]'),
    );
    const pick = nodes.find((n: any) => {
      const t = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
      return !n.disabled && labels.some((l) => t.includes(l));
    });
    if (pick) {
      pick.click();
      return true;
    }
    return false;
  }, ['המשך', 'אישור', 'כניסה', 'התחברות', 'שלח', 'Continue', 'Submit', 'Verify']);
  if (!submitted) await page.keyboard.press('Enter');
}

/**
 * Best-effort balance reader: finds page blocks that name a pension product and
 * pairs each with the largest shekel-sized number inside it. The portal layout
 * is unknown until a real login, so a miss is expected — saveDebug always keeps
 * the rendered page so this can be tightened into a precise reader.
 */
async function readBalances(page: Page): Promise<NormalizedAccount[]> {
  let found: { label: string; balance: number }[] = [];
  try {
    found = (await page.evaluate((keywords: string[]) => {
      const toAmount = (text: string): number | null => {
        const cleaned = (text || '').replace(/[^\d.,]/g, '').replace(/,/g, '');
        const value = parseFloat(cleaned);
        return Number.isFinite(value) ? value : null;
      };
      const results: { label: string; balance: number }[] = [];
      const blocks: any[] = Array.from(
        document.querySelectorAll('div, section, article, li, tr'),
      );
      for (const block of blocks) {
        const text: string = (block.innerText || '').trim();
        if (!text || text.length > 400) continue;
        const keyword = keywords.find((k) => text.includes(k));
        if (!keyword) continue;
        let largest = 0;
        for (const match of text.match(/[\d][\d.,]{3,}/g) || []) {
          const value = toAmount(match);
          if (value != null && value > largest) largest = value;
        }
        // Pension balances are at least a few thousand shekels; smaller hits
        // are fees or contribution amounts, not the accumulated balance.
        if (largest >= 1000) results.push({ label: keyword, balance: largest });
      }
      return results;
    }, PRODUCT_KEYWORDS)) as { label: string; balance: number }[];
  } catch {
    return [];
  }

  // One account per product type, keeping the largest balance seen for each.
  const byLabel = new Map<string, number>();
  for (const item of found) {
    byLabel.set(item.label, Math.max(byLabel.get(item.label) ?? 0, item.balance));
  }
  return [...byLabel].map(([label, balance]) => ({
    accountNumber: `pension:${label}`,
    label,
    balance: Math.round(balance * 100) / 100,
    currency: 'ILS',
    transactions: [],
  }));
}

/** Saves a screenshot, the rendered HTML and the captured JSON for diagnosis. */
async function saveDebug(
  page: Page,
  screenshotPath: string | undefined,
  htmlPath: string | undefined,
  dataPath: string | undefined,
  jsonResponses: { url: string; body: string }[],
): Promise<void> {
  try {
    if (screenshotPath) {
      const shot = await page.screenshot({ fullPage: true });
      writeFileSync(screenshotPath, shot);
    }
  } catch {
    // best-effort
  }
  try {
    if (htmlPath) writeFileSync(htmlPath, await page.content());
  } catch {
    // best-effort
  }
  try {
    if (dataPath) writeFileSync(dataPath, JSON.stringify(jsonResponses, null, 2));
  } catch {
    // best-effort
  }
}
