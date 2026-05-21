import { writeFileSync } from 'node:fs';
import type { Page } from 'puppeteer';

// DOM globals — these exist in the browser context that page.evaluate runs in.
declare const document: any;
declare const location: any;

export type OtpCallback = () => Promise<string>;

// Phrases that identify Beinleumi's one-time-password page.
const OTP_HINTS = [
  'סיסמה חד פעמית',
  'סיסמה חד-פעמית',
  'קוד חד פעמי',
  'הודעה קולית',
  'one-time password',
  'one time password',
];

// Selectors / URL fragments that mean login already succeeded.
const LOGGED_IN_SELECTORS = ['#card-header', '#account_num', '#matafLogoutLink'];

type PageState = 'login' | 'otp' | 'loggedIn' | 'unknown';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort classification of the bank page currently shown. */
async function classifyPage(page: Page): Promise<PageState> {
  try {
    return (await page.evaluate(
      (hints: string[], loggedInSelectors: string[]) => {
        for (const selector of loggedInSelectors) {
          if (document.querySelector(selector)) return 'loggedIn';
        }
        if (/accountSummary|PortalNG\/shell|FibiMenu\/Online/.test(location.href)) {
          return 'loggedIn';
        }
        const text = document.body ? document.body.innerText : '';
        if (hints.some((hint: string) => text.includes(hint))) return 'otp';
        if (document.querySelector('#username') || document.querySelector('#password')) {
          return 'login';
        }
        return 'unknown';
      },
      OTP_HINTS,
      LOGGED_IN_SELECTORS,
    )) as PageState;
  } catch {
    return 'unknown';
  }
}

/** Saves the current page's HTML for diagnosing selector mismatches. */
async function dumpPageHtml(page: Page, path: string): Promise<void> {
  try {
    writeFileSync(path, await page.content(), 'utf8');
  } catch {
    // non-fatal
  }
}

/** Clicks an element by CSS selector if present, visible and enabled. */
async function clickSelector(page: Page, selectors: string[]): Promise<boolean> {
  try {
    return await page.evaluate((wanted: string[]) => {
      for (const selector of wanted) {
        const el: any = document.querySelector(selector);
        if (el && !el.disabled) {
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

/** Derives a sibling debug path: foo-otp.html -> foo-otp-<suffix>.html */
function siblingDumpPath(htmlDumpPath: string, suffix: string): string {
  return htmlDumpPath.replace(/\.html$/i, `-${suffix}.html`) || `${htmlDumpPath}.${suffix}`;
}

/**
 * Drives Beinleumi's OTP page: sends the SMS, asks the app for the code,
 * enters it and submits. The send button (#sendSms) carries only a `title`
 * attribute, so it is clicked by concrete selector first, text-match second.
 */
async function driveOtpPage(page: Page, getCode: OtpCallback, htmlDumpPath: string): Promise<void> {
  // 1. Make sure the SMS delivery method is selected (it usually is by default).
  await clickSelector(page, ['#type2']);
  await delay(300);

  // 2. Trigger the one-time code to be sent.
  const sent =
    (await clickSelector(page, ['#sendSms', '#sendOtp', '#btnSend'])) ||
    (await clickByText(page, ['שלח', 'שליחה', 'Send']));
  if (!sent) {
    throw new Error('Could not find the "send code" button on the OTP page');
  }

  // 3. Ask the Hon app (which asks the user) for the code while the SMS arrives.
  const code = await getCode();

  // Give the post-send page (with the code field) a moment to render, then
  // capture it so the entry/submit selectors can be confirmed after a real run.
  await delay(1500);
  await dumpPageHtml(page, siblingDumpPath(htmlDumpPath, 'sent'));

  // 4. Enter the code — prefer a known field id, fall back to first empty input.
  const typedIntoField = await page.evaluate((otp: string) => {
    const ids = ['#otpCode', '#otp', '#smsCode', '#code', '#inputCode'];
    for (const id of ids) {
      const el: any = document.querySelector(id);
      if (el) {
        el.focus();
        el.value = '';
        return true;
      }
    }
    return false;
  }, code);
  if (typedIntoField) {
    await page.keyboard.type(code.trim(), { delay: 60 });
  } else if (await focusOtpField(page)) {
    await page.keyboard.type(code.trim(), { delay: 60 });
  }
  await delay(500);

  // 5. Submit it.
  const submitted =
    (await clickSelector(page, ['#sendOtpCode', '#btnContinue', '#continue', '#submitOtp'])) ||
    (await clickByText(page, [
      'המשך',
      'כניסה',
      'אישור',
      'התחברות',
      'שלח',
      'Continue',
      'Submit',
    ]));
  if (!submitted) {
    // Last resort: submit the form the field belongs to.
    await page.keyboard.press('Enter');
  }
}

/**
 * Runs alongside the scraper: watches the shared page and, if Beinleumi shows
 * its 2FA page, completes it. Resolves once 2FA is handled, login already
 * succeeded, or the scrape finished (signal aborted).
 */
export async function watchForOtp(
  page: Page,
  getCode: OtpCallback,
  htmlDumpPath: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await delay(1500);
    if (signal.aborted) return;

    const state = await classifyPage(page);
    if (state === 'otp') {
      await dumpPageHtml(page, htmlDumpPath);
      try {
        await driveOtpPage(page, getCode, htmlDumpPath);
      } catch {
        // leave it — the scraper will time out and report the failure
      }
      return;
    }
    if (state === 'loggedIn') {
      return; // logged in without a 2FA step
    }
  }
}
