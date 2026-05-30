import type { Page } from 'puppeteer';
import { makeLog } from './log.js';

// DOM globals — these exist in the browser context that page.evaluate runs in.
declare const document: any;
declare const location: any;
declare const window: any;

const log = makeLog('otp');

export type OtpCallback = () => Promise<string>;

// Phrases that identify a one-time-password page. Each Israeli bank phrases
// it slightly differently — substring matched against the page's body text,
// so a hint must appear verbatim. FIBI uses "סיסמה חד פעמית"; Hapoalim's new
// "ממחשב חדש" challenge says "כניסה חדשה ממחשב זה" + "קוד האימות" (note the
// definite article — "קוד אימות" without ה would NOT substring-match this
// page); Leumi/others vary.
const OTP_HINTS = [
  // FIBI group
  'סיסמה חד פעמית',
  'סיסמה חד-פעמית',
  // Generic 2FA wording across banks
  'קוד חד פעמי',
  'קוד חד-פעמי',
  'קוד אימות',
  'קוד האימות',
  'אימות דו שלבי',
  'אימות דו-שלבי',
  'אימות בשני שלבים',
  'הזדהות חד פעמית',
  'הזדהות חד-פעמית',
  'הודעה קולית',
  // Hapoalim's "new computer" challenge that uses different phrasing
  'כניסה חדשה ממחשב',
  'הודעת SMS',
  'להקליד כאן את',
  // English fallbacks (some portals offer EN UI)
  'one-time password',
  'one time password',
  'verification code',
  'two-step verification',
];

/**
 * Per-bank knowledge of how the OTP page is shaped. The shared loop classifies
 * the page generically (Hebrew/English hints) but the actual button clicks
 * and field IDs vary by portal.
 *
 * Add a new bank by adding a driver here and listing the company id in
 * `HON_OTP_WATCHER_COMPANIES` (sidecar/src/scrapers.ts). A working driver
 * needs `loggedInSelectors` / `loggedInUrlPatterns` so the watcher knows
 * when to stop polling.
 */
interface OtpDriver {
  /** Human label used in log lines. */
  name: string;
  /** A query-selector match here means login already succeeded. */
  loggedInSelectors: string[];
  /** A URL match here also means login already succeeded. */
  loggedInUrlPatterns: RegExp[];
  /** Buttons that trigger the SMS / push code; tried in order. Empty when
   *  the bank sends the code automatically as the page loads. */
  sendSelectors: string[];
  sendLabels: string[];
  /** Inputs to type the code into; tried in order. */
  fieldSelectors: string[];
  /** Submit buttons after the code is entered. */
  submitSelectors: string[];
  submitLabels: string[];
  /** A delivery-method radio to click first, when applicable. */
  deliverySelectors?: string[];
}

const FIBI_DRIVER: OtpDriver = {
  name: 'fibi',
  // Beinleumi-group portal post-login markers.
  loggedInSelectors: ['#card-header', '#account_num', '#matafLogoutLink'],
  loggedInUrlPatterns: [/accountSummary|PortalNG\/shell|FibiMenu\/Online/],
  // Pick the SMS delivery method (it usually is the default).
  deliverySelectors: ['#type2'],
  sendSelectors: ['#sendSms', '#sendOtp', '#btnSend'],
  sendLabels: ['שלח', 'שליחה', 'Send'],
  fieldSelectors: ['#otpCode', '#otp', '#smsCode', '#code', '#inputCode'],
  submitSelectors: ['#sendOtpCode', '#btnContinue', '#continue', '#submitOtp'],
  submitLabels: ['המשך', 'כניסה', 'אישור', 'התחברות', 'שלח', 'Continue', 'Submit'],
};

const HAPOALIM_DRIVER: OtpDriver = {
  name: 'hapoalim',
  // Hapoalim's NG portal shell mounts these once login completes — any of
  // them means we're past the auth wall. URL patterns are anchored on
  // specific post-login path segments because the auth URL itself is
  // `/ng-portals/auth/he/` — a too-loose match here silently swallows the
  // 2FA window (we drove that bug once, see git history).
  loggedInSelectors: [
    'hp-logout-button',
    'div[data-test-id="account-info"]',
    'poalim-main-page',
  ],
  loggedInUrlPatterns: [
    /\/portalserver\//i,
    /\/ng-portals\/portal\//i,
    /\/home-page/i,
    /\/account-summary/i,
  ],
  // Hapoalim auto-sends the SMS when its OTP modal mounts. Clicking
  // "שלחו קוד חדש" would trigger a SECOND SMS, which confuses the user —
  // the code they were about to type would become stale. Leave send empty;
  // if the SMS never arrives the user can re-sync and Hapoalim issues a
  // fresh challenge.
  sendSelectors: [],
  sendLabels: [],
  fieldSelectors: [
    // Hapoalim's NG portal renders each of the 5 digit boxes with
    // `inputmode="decimal"` and nothing else distinctive — no id, no name,
    // no formcontrolname, no autocomplete. The login userCode + password
    // both use `inputmode="text"`, so this picks the OTP widget cleanly.
    // (Captured from `/tmp/hon-otp-inputs.json` after a real 2FA prompt.)
    'input[inputmode="decimal"]',
    // Other banks tag the OTP field directly. These come AFTER the
    // Hapoalim selector so the more specific one wins.
    'input[autocomplete="one-time-code"]',
    'input[name="otp" i]',
    'input[name="verificationCode" i]',
    'input[name*="otp" i]',
    'input[formcontrolname*="otp" i]',
    'input[id*="otp" i]',
    // Avoid `id*="code"` / `name*="code"` — those false-match Hapoalim's
    // `id="userCode"` login field, then the typer clobbers the username
    // with OTP digits and the whole login is silently rejected.
  ],
  submitSelectors: [
    'button[type="submit"]',
    'button[id*="continue" i]',
    'button[id*="submit" i]',
    'button[id*="confirm" i]',
  ],
  submitLabels: ['המשך', 'אישור', 'כניסה', 'התחברות', 'Continue', 'Submit'],
};

const FIBI_COMPANIES = new Set([
  'beinleumi', 'otsarHahayal', 'massad', 'pagi',
]);

function driverFor(companyId: string): OtpDriver | null {
  if (FIBI_COMPANIES.has(companyId)) return FIBI_DRIVER;
  if (companyId === 'hapoalim') return HAPOALIM_DRIVER;
  return null;
}

type PageState = 'login' | 'otp' | 'loggedIn' | 'unknown';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort classification of the bank page currently shown. */
async function classifyPage(page: Page, driver: OtpDriver): Promise<PageState> {
  try {
    return (await page.evaluate(
      (hints: string[], loggedSels: string[], urlPatternSources: string[]) => {
        // While the URL is still on the auth sub-tree, no amount of selector
        // pre-rendering counts as "logged in" — banks' Angular shells often
        // mount placeholder components for the post-login layout that the
        // generic selectors would otherwise false-match.
        const onAuthUrl = /\/auth\//i.test(location.href);
        if (!onAuthUrl) {
          for (const selector of loggedSels) {
            if (document.querySelector(selector)) return 'loggedIn';
          }
          for (const src of urlPatternSources) {
            if (new RegExp(src, 'i').test(location.href)) return 'loggedIn';
          }
        }
        const text = document.body ? document.body.innerText : '';
        if (hints.some((hint: string) => text.includes(hint))) return 'otp';
        if (document.querySelector('#username') || document.querySelector('#password')) {
          return 'login';
        }
        return 'unknown';
      },
      OTP_HINTS,
      driver.loggedInSelectors,
      driver.loggedInUrlPatterns.map((r) => r.source),
    )) as PageState;
  } catch {
    return 'unknown';
  }
}

/**
 * Clicks the first VISIBLE element matching any of the given CSS selectors.
 * Uses querySelectorAll per selector so a hidden first match (e.g. the
 * login form's `button[type=submit]` still in DOM under the 2FA modal)
 * doesn't shadow the visible one we actually want to click.
 */
async function clickSelector(page: Page, selectors: string[]): Promise<boolean> {
  try {
    return await page.evaluate((wanted: string[]) => {
      for (const selector of wanted) {
        const matches: any[] = Array.from(document.querySelectorAll(selector));
        for (const el of matches) {
          if (!el || el.disabled) continue;
          const visible = Boolean(el.offsetWidth || el.offsetHeight);
          if (!visible) continue;
          el.click();
          return true;
        }
      }
      return false;
    }, selectors);
  } catch {
    return false;
  }
}

/**
 * Clicks the first clickable element whose text/value/title/aria-label matches
 * a label. Beinleumi's buttons often carry only a `title` attribute (e.g. the
 * #sendSms send button), so all four sources are checked.
 */
async function clickByText(page: Page, labels: string[]): Promise<boolean> {
  try {
    return await page.evaluate((wanted: string[]) => {
      const nodes: any[] = Array.from(
        document.querySelectorAll(
          'button, input[type=button], input[type=submit], a, [role=button]',
        ),
      );
      for (const label of wanted) {
        const match = nodes.find((node: any) => {
          const t = (
            node.innerText ||
            node.value ||
            node.getAttribute('title') ||
            node.getAttribute('aria-label') ||
            ''
          ).trim();
          return (t === label || t.includes(label)) && !node.disabled;
        });
        if (match) {
          match.click();
          return true;
        }
      }
      return false;
    }, labels);
  } catch {
    return false;
  }
}

/** Focuses the first visible, empty, text-like input (the OTP code field). */
async function focusOtpField(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const inputs: any[] = Array.from(document.querySelectorAll('input'));
      const field = inputs.find((input: any) => {
        const type = (input.getAttribute('type') || 'text').toLowerCase();
        const typeOk = ['text', 'tel', 'number', 'password'].includes(type);
        const visible = Boolean(input.offsetWidth || input.offsetHeight);
        return typeOk && visible && !input.disabled && !input.readOnly && !input.value;
      });
      if (field) {
        field.focus();
        return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Types the OTP into the page. Handles both shapes Israeli banks use:
 *   - Single input — type the whole code in.
 *   - N single-digit boxes (Hapoalim "ממחשב חדש" is 5 boxes; some banks 6)
 *     — type one character per box.
 *
 * Candidate inputs come from the driver's fieldSelectors first; if none
 * match, fall back to "visible, empty, text-like" with the same search-box
 * exclusion the pension scraper uses (a stray search field next to the OTP
 * widget would otherwise be mistaken for a code box).
 *
 * Returns the number of boxes typed into (0 = nothing was found, scrape
 * will time out with a logged warning).
 */
async function typeOtpCode(
  page: Page, driver: OtpDriver, code: string,
): Promise<number> {
  const digits = code.replace(/\s/g, '');

  // Debug dump: every input on the page, with the attributes we care about.
  // Lets us see what Hapoalim's OTP widget actually exposes when our normal
  // selectors miss the visible boxes. The structured logger truncates lines,
  // so dump to a file. Removed once the matcher is solid.
  try {
    const inputs = await page.evaluate(() => {
      const all: any[] = Array.from(document.querySelectorAll('input'));
      return all.map((el: any) => ({
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        id: el.id || null,
        formcontrolname: el.getAttribute('formcontrolname'),
        autocomplete: el.getAttribute('autocomplete'),
        maxlength: el.getAttribute('maxlength'),
        inputmode: el.getAttribute('inputmode'),
        ariaLabel: el.getAttribute('aria-label'),
        cls: el.className || null,
        disabled: !!el.disabled,
        readOnly: !!el.readOnly,
        visible: Boolean(el.offsetWidth || el.offsetHeight),
        hasValue: Boolean(el.value),
      }));
    });
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      '/tmp/hon-otp-inputs.json',
      JSON.stringify(inputs, null, 2),
    );
    log.info('otp.dom.dumped', { count: inputs.length, path: '/tmp/hon-otp-inputs.json' });
  } catch (err) {
    log.warn('otp.dom.dumpFailed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Tag candidate inputs with a data-attribute so we can click + type one at
  // a time without holding DOM references across page.evaluate boundaries.
  //
  // Logic is inlined deliberately: declaring helper arrow functions inside
  // page.evaluate (`const usable = (el) => ...`) triggers esbuild's
  // `__name(usable, "usable")` wrapper that preserves `.name`, but the
  // `__name` helper itself lives at the module top level and doesn't
  // travel to the browser context — the result is "__name is not defined"
  // at evaluate time.
  const boxes: number = await page.evaluate((fieldSelectors: string[]) => {
    const picked: any[] = [];
    // First pass — anything matching the driver's specific selectors.
    // Always skip filled inputs: a value-bearing match is the username or
    // password the user just typed, never the empty OTP box we want.
    for (const sel of fieldSelectors) {
      const matches: any[] = Array.from(document.querySelectorAll(sel));
      for (const el of matches) {
        if (picked.indexOf(el) >= 0) continue;
        const isVisible = Boolean(el.offsetWidth || el.offsetHeight);
        if (!isVisible || el.disabled || el.readOnly || el.value) continue;
        const idStr = (el.id || '') + ' ' + (el.getAttribute('name') || '');
        const elType = (el.getAttribute('type') || '').toLowerCase();
        const isSearch =
          elType === 'search'
          || el.getAttribute('role') === 'searchbox'
          || /search|חיפוש/i.test(idStr);
        if (isSearch) continue;
        picked.push(el);
      }
    }
    // Fallback — first empty, text-like inputs on the page.
    if (picked.length === 0) {
      const inputs: any[] = Array.from(document.querySelectorAll('input'));
      for (const el of inputs) {
        const elType = (el.getAttribute('type') || 'text').toLowerCase();
        const textLike =
          elType === 'text' || elType === 'tel' || elType === 'number'
          || elType === 'password' || elType === '';
        if (!textLike) continue;
        const isVisible = Boolean(el.offsetWidth || el.offsetHeight);
        if (!isVisible || el.disabled || el.readOnly || el.value) continue;
        const idStr = (el.id || '') + ' ' + (el.getAttribute('name') || '');
        const isSearch =
          el.getAttribute('role') === 'searchbox'
          || /search|חיפוש/i.test(idStr);
        if (isSearch) continue;
        picked.push(el);
      }
    }
    for (let i = 0; i < picked.length; i += 1) {
      picked[i].setAttribute('data-hon-otp', String(i));
    }
    return picked.length;
  }, driver.fieldSelectors);

  if (boxes >= 2) {
    // Multi-box Angular OTP widgets (Hapoalim's 5-digit, Migdal's 6-digit)
    // bind each box to an ngModel via a native HTMLInputElement value
    // setter override. Plain Puppeteer keystrokes go through the browser's
    // input pipeline but don't always trigger Angular's change detection —
    // we ended up with the visible boxes empty and Hapoalim shouting "אנא
    // הקלד קוד זיהוי". The fix is to set each box's value through the
    // *native* setter (which the framework patched and listens to) and
    // dispatch a real `input` event so ngModel updates. This sidesteps
    // auto-advance focus mechanics entirely — we don't depend on focus
    // moving correctly between keystrokes.
    await page.evaluate((digitsStr: string) => {
      const inputs: any[] = Array.from(document.querySelectorAll('[data-hon-otp]'));
      if (!inputs.length) return;
      const proto = window.HTMLInputElement.prototype;
      const nativeSetter =
        Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      for (let i = 0; i < inputs.length && i < digitsStr.length; i += 1) {
        const el = inputs[i];
        el.focus();
        if (nativeSetter) nativeSetter.call(el, digitsStr[i]);
        else el.value = digitsStr[i];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Land focus on the last filled box so the submit button doesn't
      // see a stale "field still focused, code incomplete" state.
      const last = inputs[Math.min(inputs.length, digitsStr.length) - 1];
      if (last) last.blur();
    }, digits);
  } else if (boxes === 1) {
    // Single field — clear it (triple-click selects) and type the whole code.
    await page.click('[data-hon-otp="0"]', { clickCount: 3 }).catch(() => {});
    await page.type('[data-hon-otp="0"]', digits, { delay: 60 });
  }
  return boxes;
}

/**
 * Drives one bank's OTP page: optionally chooses a delivery method, sends
 * the code, asks the web app for it, enters it and submits.
 */
async function driveOtpPage(
  page: Page, driver: OtpDriver, getCode: OtpCallback,
): Promise<void> {
  // 1. Pick the delivery method, when the portal has a radio for it.
  if (driver.deliverySelectors && driver.deliverySelectors.length) {
    await clickSelector(page, driver.deliverySelectors);
    await delay(300);
  }

  // 2. Trigger the one-time code, when the bank needs a click to send it.
  // Hapoalim sends automatically on modal mount, so its driver leaves both
  // sendSelectors and sendLabels empty — we skip this step entirely
  // (clicking the visible "שלחו קוד חדש" would just trigger a second SMS
  // and invalidate the code the user already received).
  if (driver.sendSelectors.length || driver.sendLabels.length) {
    const sentBySelector = await clickSelector(page, driver.sendSelectors);
    const sent = sentBySelector || await clickByText(page, driver.sendLabels);
    log.info('otp.send', { driver: driver.name, clicked: sent });
    if (!sent && driver.name === 'fibi') {
      throw new Error('Could not find the "send code" button on the OTP page');
    }
  } else {
    log.info('otp.send.skipped', { driver: driver.name, reason: 'auto-sent' });
  }

  // 3. Ask the web app (which asks the user) for the code while the SMS arrives.
  const code = await getCode();

  // Give the post-send page (with the code field) a moment to render.
  await delay(1500);

  // 4. Enter the code — handles single-field and split-digit-box layouts.
  const boxes = await typeOtpCode(page, driver, code.trim());
  if (boxes === 0) {
    // Last-ditch: focus any visible empty input and type the whole code.
    if (await focusOtpField(page)) {
      await page.keyboard.type(code.trim(), { delay: 60 });
    } else {
      log.warn('otp.fieldNotFound', { driver: driver.name });
    }
  } else {
    log.info('otp.typed', { driver: driver.name, boxes });
  }
  await delay(500);

  // 5. Submit it.
  const submitted =
    (await clickSelector(page, driver.submitSelectors)) ||
    (await clickByText(page, driver.submitLabels));
  if (!submitted) {
    // Last resort: submit the form the field belongs to.
    await page.keyboard.press('Enter');
  }
  log.info('otp.submit', { driver: driver.name, clicked: submitted });
}

/**
 * Runs alongside the scraper: watches the shared page and, if the bank shows
 * its 2FA page, completes it. Resolves once 2FA is handled, login already
 * succeeded, or the scrape finished (signal aborted).
 *
 * `companyId` selects the per-bank driver. Pass any id not in the supported
 * set and the watcher exits immediately — the underlying library's scrape
 * runs without OTP help.
 */
export async function watchForOtp(
  page: Page,
  getCode: OtpCallback,
  signal: AbortSignal,
  companyId: string,
): Promise<void> {
  const driver = driverFor(companyId);
  if (!driver) {
    log.info('watcher.skipped', { companyId, reason: 'no driver' });
    return;
  }
  log.info('watcher.armed', { driver: driver.name, companyId });
  while (!signal.aborted) {
    await delay(1500);
    if (signal.aborted) return;

    const state = await classifyPage(page, driver);
    if (state === 'otp') {
      log.info('otp.detected', { driver: driver.name, url: page.url() });
      try {
        await driveOtpPage(page, driver, getCode);
      } catch (err) {
        log.warn('otp.driveFailed', {
          driver: driver.name,
          message: err instanceof Error ? err.message : String(err),
        });
        // Rethrow so the caller (runInteractiveScrape) can unwind the awaited
        // scrape path and close the browser. The common case is `getCode()`
        // rejecting with `otp.timeout` after the user walked away from the 2FA
        // prompt: if we swallowed it here the watcher would resolve normally and
        // the bank page would sit on the OTP screen until the library's own
        // 240s defaultTimeout, pinning an open Chrome the whole time (H-5).
        throw err;
      }
      return;
    }
    if (state === 'loggedIn') {
      log.info('watcher.loggedIn', { driver: driver.name });
      return; // logged in without a 2FA step
    }
  }
}
