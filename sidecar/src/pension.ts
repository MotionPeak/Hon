// Pension / קרן השתלמות connector.
//
// Israeli pension, gemel and study-fund (קרן השתלמות) providers each run their
// own member portal — there is no shared scraping library for them the way
// israeli-bank-scrapers covers the banks. This connector logs into a provider's
// portal in a Hon-controlled Puppeteer browser, completes the SMS one-time-code
// step, and reads the accumulated balance of every product the member holds.
//
// Migdal and Altshuler Shaham are both Angular single-page apps behind a WAF,
// and both use **passwordless OTP login** — no static password:
//   • Migdal      — ID number → a code is sent to the number on file.
//   • Altshuler   — ID number + phone number → a code is sent by SMS
//                   (Altshuler also runs an invisible reCAPTCHA v3 on the form).
// Their post-login dashboards differ and cannot be inspected without real
// credentials, so the balance reader is a best-effort heuristic that always
// dumps the rendered page + JSON responses to <dataDir>/debug — the material
// needed to tighten it after a real login.

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
  /** Credentials the user supplies — rendered as fields in the Add flow. */
  loginFields: string[];
  /** CSS selector for the ID-number input on the login form. */
  idSelector: string;
  /** CSS selector for the phone-number input, when the portal needs one. */
  phoneSelector?: string;
  /** CSS selector for the "send the code by SMS" radio, clicked to be sure. */
  smsRadioSelector?: string;
  /** Text on the button that submits the form and triggers the SMS code. */
  submitLabels: string[];
  /** Page to open after login to reach the product balances, when separate. */
  productsUrl?: string;
}

const FUNDS: Record<string, PensionFund> = {
  migdal: {
    id: 'migdal',
    name: 'Migdal (מגדל)',
    domain: 'migdal.co.il',
    loginUrl: 'https://my.migdal.co.il/mymigdal/process/login',
    loginFields: ['id'],
    idSelector: '#username',
    smsRadioSelector: '#otpToCell',
    submitLabels: ['המשך', 'כניסה', 'שלח'],
    productsUrl: 'https://my.migdal.co.il/mymigdal/info/myproducts',
  },
  altshulerShaham: {
    id: 'altshulerShaham',
    name: 'Altshuler Shaham (אלטשולר שחם)',
    domain: 'as-invest.co.il',
    loginUrl: 'https://online.as-invest.co.il/login',
    loginFields: ['id', 'phone'],
    idSelector: '[formcontrolname="id"]',
    phoneSelector: '[formcontrolname="phoneNumber"]',
    smsRadioSelector: '[id="1"]',
    submitLabels: ['שלחו לי סיסמה', 'שלח', 'המשך'],
  },
};

/** Catalog entries so the pension funds appear in the Add-connection picker. */
export const PENSION_COMPANIES: CompanyInfo[] = Object.values(FUNDS).map((fund) => ({
  id: fund.id,
  name: fund.name,
  loginFields: fund.loginFields,
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

// In a container Chromium runs as root with no user namespace, so its sandbox
// cannot start — the Docker image sets HON_BROWSER_NO_SANDBOX=1 to drop it
// (matches the bank scraper). On a normal desktop the array stays empty.
const SANDBOX_ARGS: string[] =
  process.env.HON_BROWSER_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-setuid-sandbox']
    : [];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Phrases that mark the SMS one-time-password step.
const OTP_HINTS = [
  'סיסמה חד פעמית', 'סיסמה חד-פעמית', 'קוד חד פעמי', 'קוד חד-פעמי',
  'קוד אימות', 'קוד שנשלח', 'הזן את הקוד', 'הזינו את הקוד', 'הקוד שקיבלת',
  'one-time password', 'one time password', 'verification code',
];

// Phrases that mark a rejected ID number / phone, or a wrong code.
const LOGIN_ERROR_HINTS = [
  'שם המשתמש או הסיסמה', 'פרטים שגויים', 'הפרטים שהוזנו', 'שגויים',
  'לא תקין', 'קוד שגוי', 'הקוד שגוי', 'אינם נכונים', 'incorrect', 'invalid',
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

  if (!(credentials.id ?? '').trim()) {
    return fail('CONFIG', 'This pension connection needs an ID number.');
  }
  if (fund.phoneSelector && !(credentials.phone ?? '').trim()) {
    return fail('CONFIG', 'This pension connection needs a phone number.');
  }

  const htmlPath = debugSibling(screenshotPath, '-pension.html');
  const dataPath = debugSibling(screenshotPath, '-pension.json');
  const jsonResponses: { url: string; body: string }[] = [];

  let browser: Browser | undefined;
  try {
    onProgress?.('Starting the browser…');
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: [...SANDBOX_ARGS, '--disable-blink-features=AutomationControlled', '--lang=he-IL'],
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
    if (!(await fillAndSubmitLogin(page, fund, credentials))) {
      await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);
      return fail(
        'LOGIN_FAILED',
        'Could not find the login form on the portal. A debug page was saved.',
      );
    }

    // Both portals always send an SMS code, so wait for that step, the
    // dashboard (if the portal skipped the code), or a rejection.
    onProgress?.('Waiting for the verification code…');
    let handledOtp = false;
    let deadline = Date.now() + 150_000;
    let reached = false;
    while (Date.now() < deadline) {
      await delay(2000);
      const state = await classifyState(page);
      if (state === 'otp' && !handledOtp) {
        const code = await onOtpNeeded();
        onProgress?.('Submitting the verification code…');
        await enterOtpCode(page, (code ?? '').trim());
        handledOtp = true;
        deadline = Date.now() + 90_000; // give the post-OTP dashboard time
        continue;
      }
      if (state === 'dashboard') {
        reached = true;
        break;
      }
      if (state === 'error') {
        await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);
        return fail(
          'LOGIN_FAILED',
          'The portal rejected the details (ID number, phone, or code).',
        );
      }
    }

    if (!reached) {
      // Login never completed — capture the stuck page and stop here.
      await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);
      return fail(
        'LOGIN_FAILED',
        handledOtp
          ? 'The verification code was not accepted. A debug page was saved.'
          : 'The login did not complete — the portal stayed on the sign-in ' +
            'step. A debug page was saved.',
      );
    }

    // Migdal shows balances on a separate "my products" page — open it.
    if (fund.productsUrl) {
      onProgress?.('Opening your products…');
      try {
        await page.goto(fund.productsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch {
        // fall through and read whatever page is loaded
      }
    }
    onProgress?.('Reading your balances…');
    await delay(4000); // let the products page render its data
    const accounts =
      companyId === 'migdal'
        ? await readMigdalBalances(page)
        : await readGenericBalances(page);
    await saveDebug(page, screenshotPath, htmlPath, dataPath, jsonResponses);

    if (accounts.length === 0) {
      return fail(
        'NEEDS_SELECTORS',
        'Signed in, but could not read the balances automatically yet — the ' +
          'portal layout still needs mapping. The rendered page was saved to ' +
          'the debug folder.',
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

type PageState = 'otp' | 'dashboard' | 'error' | 'unknown';

/** Best-effort read of which stage the portal is showing. */
async function classifyState(page: Page): Promise<PageState> {
  try {
    return (await page.evaluate(
      (otpHints: string[], errorHints: string[]) => {
        const text: string = document.body ? document.body.innerText : '';
        const url: string = String(location.href).toLowerCase();
        const has = (hints: string[]): boolean => hints.some((h) => text.includes(h));
        if (has(otpHints)) return 'otp';
        if (has(errorHints)) return 'error';
        if (!/login|signin|log-in|otp|verify/.test(url)) return 'dashboard';
        return 'unknown';
      },
      OTP_HINTS,
      LOGIN_ERROR_HINTS,
    )) as PageState;
  } catch {
    return 'unknown';
  }
}

/** Types a value into a field by CSS selector with real keystrokes. */
async function fillField(page: Page, selector: string, value: string): Promise<boolean> {
  const el = await page.$(selector);
  if (!el) return false;
  // Real keystrokes — Angular reactive forms ignore programmatic value writes.
  await el.click({ clickCount: 3 });
  await el.type(value, { delay: 45 });
  return true;
}

/** Clicks the first enabled element whose text matches one of `labels`. */
async function clickByText(page: Page, labels: string[]): Promise<boolean> {
  try {
    return await page.evaluate((wanted: string[]) => {
      const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
      const off = (n: any): boolean =>
        Boolean(n.disabled) || n.getAttribute('aria-disabled') === 'true';
      for (const label of wanted) {
        const controls: any[] = Array.from(
          document.querySelectorAll(
            'button, input[type=submit], input[type=button], a, [role=button]',
          ),
        );
        let hit: any = controls.find((n: any) => {
          const t = norm(n.innerText || n.value || n.getAttribute('aria-label') || '');
          return !off(n) && (t === label || t.includes(label));
        });
        // Buttons built from plain <div>/<span> (e.g. Migdal's "המשך") carry no
        // button tag or role — take the innermost element whose own text is the
        // label; a click on it bubbles up to the real handler.
        if (!hit) {
          const plain: any[] = Array.from(
            document.querySelectorAll('span, div, a, p, li'),
          ).filter((n: any) => norm(n.innerText || '') === label && !off(n));
          plain.sort(
            (a: any, b: any) =>
              a.querySelectorAll('*').length - b.querySelectorAll('*').length,
          );
          hit = plain[0];
        }
        if (hit) {
          (hit.closest('button, a, [role=button]') || hit).click();
          return true;
        }
      }
      return false;
    }, labels);
  } catch {
    return false;
  }
}

/**
 * Fills the login form (ID number, plus phone where the portal needs it),
 * makes sure the code goes by SMS, and submits — which triggers the SMS code.
 */
async function fillAndSubmitLogin(
  page: Page,
  fund: PensionFund,
  credentials: Record<string, string>,
): Promise<boolean> {
  try {
    await page.waitForSelector(fund.idSelector, { visible: true, timeout: 45_000 });
  } catch {
    return false;
  }
  if (!(await fillField(page, fund.idSelector, (credentials.id ?? '').trim()))) {
    return false;
  }
  if (fund.phoneSelector) {
    await fillField(page, fund.phoneSelector, (credentials.phone ?? '').trim());
  }
  if (fund.smsRadioSelector) {
    // A JS click checks the radio even when it is a visually-hidden custom
    // control (Puppeteer's page.click needs a visible, hit-testable target).
    await page
      .evaluate((sel: string) => {
        const radio: any = document.querySelector(sel);
        if (radio) radio.click();
      }, fund.smsRadioSelector)
      .catch(() => {});
  }
  await delay(800); // let Angular validate the form and enable the button
  if (!(await clickByText(page, fund.submitLabels))) {
    await page.keyboard.press('Enter');
  }
  return true;
}

/**
 * Types the verification code and submits it. The code field may be a single
 * input or several single-digit boxes — Migdal uses six boxes named
 * otp, otp2…otp6, so each digit is typed into its own box.
 */
async function enterOtpCode(page: Page, code: string): Promise<void> {
  const digits = code.replace(/\D/g, '');
  // Tag the OTP box(es): prefer inputs named like otp/otp2…, else fall back to
  // the visible empty text inputs on the page.
  const boxes = await page.evaluate(() => {
    const inputs: any[] = Array.from(document.querySelectorAll('input'));
    const visible = (el: any): boolean => Boolean(el.offsetWidth || el.offsetHeight);
    let picked: any[] = inputs.filter(
      (el: any) =>
        /^otp\d*$/i.test(el.getAttribute('name') || el.id || '') &&
        visible(el) &&
        !el.disabled,
    );
    if (picked.length === 0) {
      picked = inputs.filter((el: any) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const textLike = ['text', 'tel', 'number', 'password', ''].includes(type);
        return textLike && visible(el) && !el.disabled && !el.readOnly && !el.value;
      });
    }
    picked.forEach((el: any, i: number) => el.setAttribute('data-hon-otp', String(i)));
    return picked.length;
  });

  if (boxes >= 2) {
    for (let i = 0; i < boxes && i < digits.length; i += 1) {
      await page.click(`[data-hon-otp="${i}"]`).catch(() => {});
      await page.type(`[data-hon-otp="${i}"]`, digits[i] ?? '', { delay: 80 });
    }
  } else if (boxes === 1) {
    await page.click('[data-hon-otp="0"]', { clickCount: 3 }).catch(() => {});
    await page.type('[data-hon-otp="0"]', digits, { delay: 60 });
  }

  await delay(600);
  if (
    !(await clickByText(page, [
      'המשך', 'אישור', 'כניסה', 'התחברות', 'שלח', 'כניסה לאזור האישי',
      'Continue', 'Submit', 'Verify',
    ]))
  ) {
    await page.keyboard.press('Enter');
  }
}

/**
 * Reads balances from Migdal's "my products" page (verified live 2026-05-22):
 * each product is a `.table` block — the name is in an <a>, and the accumulated
 * balance is the <strong> whose preceding label reads "ערכי פדיון" (or, for a
 * gemel / study fund, "צבירה" / "יתרה"). Other <strong> values in the block
 * (deposits, projected monthly pension) are deliberately skipped by the label.
 */
async function readMigdalBalances(page: Page): Promise<NormalizedAccount[]> {
  await page.waitForSelector('.table', { timeout: 30_000 }).catch(() => {});
  let products: { name: string; balance: number }[] = [];
  try {
    products = (await page.evaluate(() => {
      const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
      const isBalanceLabel = (s: string): boolean =>
        /ערכי פדיון|צבירה|יתרה|סך חיסכון|סך צבירה/.test(s);
      const out: { name: string; balance: number }[] = [];
      const tables: any[] = Array.from(document.querySelectorAll('.table'));
      for (const table of tables) {
        const link = table.querySelector('a');
        const name = norm(link ? link.innerText : '');
        if (!name) continue;
        let balance = 0;
        const strongs: any[] = Array.from(table.querySelectorAll('strong'));
        for (const strong of strongs) {
          // The value's label is a nearby preceding sibling.
          let label = '';
          let prev = strong.previousElementSibling;
          for (let i = 0; prev && !label && i < 4; i += 1) {
            label = norm(prev.innerText || '');
            prev = prev.previousElementSibling;
          }
          if (!isBalanceLabel(label)) continue;
          const value = parseFloat(norm(strong.innerText).replace(/[^\d.]/g, ''));
          if (Number.isFinite(value) && value > balance) balance = value;
        }
        if (balance > 0) out.push({ name, balance });
      }
      return out;
    })) as { name: string; balance: number }[];
  } catch {
    return [];
  }
  return products.map((p) => ({
    accountNumber: `migdal:${p.name}`,
    label: p.name,
    balance: Math.round(p.balance * 100) / 100,
    currency: 'ILS',
    transactions: [],
  }));
}

/**
 * Fallback balance reader for portals not yet precisely mapped (e.g. Altshuler):
 * finds page blocks that name a pension product and pairs each with the largest
 * shekel-sized number inside it. A miss is expected — saveDebug keeps the page.
 */
async function readGenericBalances(page: Page): Promise<NormalizedAccount[]> {
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
