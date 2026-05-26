// Voucher / gift-card scrapers. Unlike the bank scrapers, these are not
// connections in Hon — they run as one-off "Sync from X" actions on the
// Vouchers tab. Each scraper logs in fresh, completes whatever 2FA the
// portal asks for, parses the dashboard, and hands back ScrapedVoucher
// rows for the caller (the sync runner) to upsert.
//
// Today only Shufersal Tav Hazahav (https://giftcard.shufersal.co.il/giftcard/)
// is supported. The flow:
//   1. Open the landing page
//   2. Click "אולי יש לך תו?" — opens the phone-entry modal
//   3. Fill the phone number + check the terms checkbox
//   4. Click "שליחת קוד" — the portal sends an SMS code
//   5. Wait for the OTP input to mount, then ask the caller for the code
//   6. Submit the code and wait for the dashboard ("כרטיסים פעילים")
//   7. Parse each visible card tile (brand, balance, last-4, expiry)

import puppeteer, { type Browser, type Page } from 'puppeteer';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLog } from './log.js';

declare const document: any;
declare const window: any;
declare const location: any;

const log = makeLog('vouchers:shufersal');
const buymeLog = makeLog('vouchers:buyme');

const SHUFERSAL_URL = 'https://giftcard.shufersal.co.il/giftcard/';

// Hebrew anchors used to find UI elements. They appear verbatim on the page;
// matching on text is more robust than the Angular-hashed CSS class names.
const TEXT = {
  haveCardCta: 'אולי יש לך תו',         // landing CTA that opens the phone modal
  termsLink: 'תנאי השימוש',              // adjacent to the consent checkbox
  sendCode: 'שליחת קוד',                  // submit on the phone modal
  otpSubmit: 'אפשר להתחיל',              // submit on the OTP modal
  activeCardsHeader: 'כרטיסים פעילים',    // post-login summary line ("X active cards")
  validUntilPrefix: 'בתוקף עד',           // appears before each card's expiry
};

export type OtpCallback = () => Promise<string>;

export interface ScrapedVoucher {
  /** Stable id for upsert: `shufersal-{last4}` when present, else hash of brand+expiry. */
  externalId: string;
  /** Display label, e.g. "תו הזהב". */
  brand: string;
  /** Last four digits of the card number (e.g. "6375"); empty when not shown. */
  last4: string;
  balance: number;
  currency: string;
  /** YYYY-MM-DD derived from the bank's "MM/YY" expiry; null when unknown. */
  expiresOn: string | null;
}

export interface ShufersalScrapeOptions {
  /** Optional path to dump the dashboard HTML for offline parser tuning. */
  debugDumpPath?: string;
  /** Override the default headless puppeteer launch (useful for debugging). */
  headless?: boolean;
}

/**
 * Drives a full Shufersal Tav Hazahav scrape and returns the list of cards
 * visible on the post-login dashboard. Throws on login failure or timeout;
 * the caller decides whether to surface that to the UI as an error.
 */
export async function scrapeShufersalGiftCards(
  phoneNumber: string,
  onOtpNeeded: OtpCallback,
  options: ShufersalScrapeOptions = {},
): Promise<ScrapedVoucher[]> {
  const done = log.timer('scrape', { url: SHUFERSAL_URL });
  const phone = normalisePhone(phoneNumber);
  if (!phone) {
    done({ result: 'invalid-phone' });
    throw new Error('A 10-digit Israeli mobile number is required (e.g. 0501234567).');
  }

  const browser: Browser = await puppeteer.launch({
    headless: options.headless ?? true,
    args: process.env.HON_BROWSER_NO_SANDBOX === '1'
      ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  });
  let page: Page | undefined;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // tsx / esbuild transpile nested arrow functions inside `page.evaluate`
    // callbacks with `__name(fn, "name")` calls so DevTools shows useful
    // function names. The browser doesn't define __name though, so every
    // such evaluate throws "__name is not defined" before our code runs.
    // Polyfill once per page so all later evaluates work transparently.
    await page.evaluateOnNewDocument(() => {
      // @ts-expect-error — defined in the page, not in Node's types
      if (typeof globalThis.__name === 'undefined') {
        // @ts-expect-error — runtime polyfill
        globalThis.__name = (fn: unknown) => fn;
      }
    });

    log.info('navigate', { url: SHUFERSAL_URL });
    // networkidle2 waits for the SPA bundle's initial XHRs to settle so
    // Angular's NgZone has wired its (click) listeners by the time we
    // click the CTA. domcontentloaded fires too early — the button is in
    // the DOM but its handler may not be attached yet, so a real-mouse
    // click silently goes nowhere.
    await page.goto(SHUFERSAL_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    log.info('navigate.done', { landedUrl: page.url() });

    // Click-and-verify: click the CTA, then briefly wait for the modal's
    // marker text to appear. If Angular still hadn't wired the click
    // handler the first time, a second click on the now-live button does
    // the trick. Up to 3 tries (≈ 5s total) before we give up and dump.
    let modalOpened = false;
    for (let attempt = 1; attempt <= 3 && !modalOpened; attempt += 1) {
      try {
        await clickByText(page, TEXT.haveCardCta, 30_000);
      } catch (err) {
        log.error('cta.missing', {
          attempt,
          landedUrl: page.url(),
          message: err instanceof Error ? err.message : String(err),
        });
        if (options.debugDumpPath) {
          try {
            writeFileSync(options.debugDumpPath, await page.content(), 'utf8');
          } catch {/* best effort */}
        }
        throw new Error(
          'Could not find the "אולי יש לך תו?" button on the Shufersal landing page. '
          + 'Their layout may have changed — see debug HTML dump.',
        );
      }
      try {
        await page.waitForFunction(
          (link: string) => (document.body?.innerText || '').includes(link),
          { timeout: 1500 },
          TEXT.termsLink,
        );
        modalOpened = true;
        log.info('modal.opened', { attempt });
      } catch {
        log.warn('modal.not.yet.open.retrying', { attempt });
      }
    }
    if (!modalOpened) {
      log.error('modal.never.mounted', { landedUrl: page.url() });
      if (options.debugDumpPath) {
        try {
          writeFileSync(options.debugDumpPath, await page.content(), 'utf8');
          log.info('debug.dump', { path: options.debugDumpPath });
        } catch {/* best effort */}
      }
      throw new Error(
        'Clicked the "אולי יש לך תו?" CTA but the phone-entry modal never opened. '
        + 'The page layout may have changed — see debug HTML dump.',
      );
    }

    // Fill the phone input. The modal renders a single tel/text input visible
    // to the user; the most-recently-shown one is reliable.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('input'))
        .some((el: any) => el.offsetParent !== null && el.type !== 'checkbox'),
      { timeout: 20_000 },
    );
    log.info('phone.input.ready');
    await fillVisibleInput(page, phone);
    log.info('phone.filled', { digits: phone.length });

    // Tick the "אישור תנאי השימוש ומדיניות פרטיות" checkbox so "שליחת קוד" enables.
    await tickConsentCheckbox(page);
    log.info('consent.ticked');

    // Send-code is `disabled="true"` until the form is fully valid (phone
    // typed + terms ticked AND ng-touched). Wait for it to enable so we
    // don't click through to a no-op state. If it stays disabled past the
    // wait, that's almost always Shufersal's anti-abuse rate-limit kicking
    // in after many OTPs to the same number — surface that to the user as
    // a real error instead of letting the next step time out cryptically.
    let sendEnabled = false;
    try {
      await page.waitForFunction(
        (label: string) => {
          const btns: any[] = Array.from(document.querySelectorAll('button'));
          return btns.some((b: any) => {
            if (b.disabled) return false;
            if (b.getAttribute && b.getAttribute('aria-disabled') === 'true') return false;
            const t = (b.innerText || b.textContent || '').trim();
            return t.includes(label) && b.offsetParent !== null;
          });
        },
        { timeout: 10_000 },
        TEXT.sendCode,
      );
      sendEnabled = true;
      log.info('sms.send.enabled');
    } catch (err) {
      log.warn('sms.send.still.disabled', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (!sendEnabled) {
      if (options.debugDumpPath) {
        try {
          writeFileSync(options.debugDumpPath, await page.content(), 'utf8');
          log.info('debug.dump', { path: options.debugDumpPath });
        } catch {/* best effort */}
      }
      throw new Error(
        "Shufersal's \"שליחת קוד\" button never enabled. The most likely "
        + 'cause is that Shufersal is rate-limiting your phone number after '
        + 'too many OTP requests today — try again in 30–60 minutes. If it '
        + 'persists, the form layout may have changed (see debug HTML dump).',
      );
    }

    await clickByText(page, TEXT.sendCode, 15_000);
    log.info('sms.send.clicked');

    // The OTP screen replaces the modal contents with a code input (numeric).
    // Wait for a fresh visible input that wasn't there a moment ago.
    await page.waitForFunction(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      // The phone input we filled before is now usually hidden / detached.
      // A new visible input with maxlength <= 6 is the OTP field.
      return inputs.some((el: any) =>
        el.offsetParent !== null
        && el.type !== 'checkbox'
        && (!el.value || /^\d*$/.test(el.value))
        && (el.maxLength === -1 || el.maxLength <= 8),
      );
    }, { timeout: 30_000 });

    const code = await onOtpNeeded();
    if (!code) throw new Error('OTP entry was cancelled.');
    log.info('otp.received', { length: code.length });

    await fillVisibleInput(page, code.replace(/\D/g, ''));
    log.info('otp.filled');

    // Wait for the "אפשר להתחיל" submit button to enable, then click it via
    // a real mouse event so Angular's (click) handler fires. The button is
    // disabled until the OTP input is ng-touched AND ng-valid, which is
    // why fillVisibleInput now dispatches blur explicitly.
    try {
      await page.waitForFunction(
        (label: string) => {
          const btns: any[] = Array.from(document.querySelectorAll('button'));
          return btns.some((b: any) => {
            if (b.disabled) return false;
            if (b.getAttribute && b.getAttribute('aria-disabled') === 'true') return false;
            const t = (b.innerText || b.textContent || '').trim();
            return t.includes(label) && b.offsetParent !== null;
          });
        },
        { timeout: 10_000 },
        TEXT.otpSubmit,
      );
      log.info('otp.submit.enabled');
    } catch (err) {
      log.warn('otp.submit.still.disabled', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await clickByText(page, TEXT.otpSubmit, 10_000);
      log.info('otp.submit.clicked');
    } catch (err) {
      // Fallback: a few portals do auto-submit on the last digit. Try
      // pressing Enter so we don't hang if the button never enabled.
      log.warn('otp.submit.click.failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      await pressEnter(page);
    }

    // Once login completes the modal closes and the dashboard shows
    // "יש לך N כרטיסים פעילים בשווי X". Anchor on that line.
    await page.waitForFunction(
      (needle: string) => (document.body?.innerText || '').includes(needle),
      { timeout: 45_000 },
      TEXT.activeCardsHeader,
    );
    log.info('dashboard.ready');

    if (options.debugDumpPath) {
      try {
        const html = await page.content();
        writeFileSync(options.debugDumpPath, html, 'utf8');
        log.info('debug.dump', { path: options.debugDumpPath, bytes: html.length });
      } catch (err) {
        log.warn('debug.dump.failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const cards = await extractCards(page);
    log.info('cards.extracted', { count: cards.length });
    done({ result: 'ok', cards: cards.length });
    return cards;
  } catch (err) {
    log.error('scrape.threw', {
      message: err instanceof Error ? err.message : String(err),
    });
    if (page && options.debugDumpPath) {
      try {
        const html = await page.content();
        writeFileSync(options.debugDumpPath, html, 'utf8');
      } catch {/* best effort */}
    }
    done({ result: 'exception' });
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

// --- DOM helpers -----------------------------------------------------------

// Israeli mobile numbers come as 10 digits starting with 05 (e.g. 0501234567).
// Strip everything non-numeric; accept either 05X… or international +9725X…
// and normalise to the local 05X form the Shufersal form expects.
function normalisePhone(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('972')) {
    const rest = digits.slice(3);
    return rest.length === 9 ? '0' + rest : null;
  }
  if (/^05\d{8}$/.test(digits)) return digits;
  return null;
}

// Clicks the first visible, enabled button/anchor whose text contains
// `needle`, dispatching a real mouse-event sequence via puppeteer's CDP
// so Angular's (click) listeners fire (DOM .click() often gets ignored
// by NgZone-bound handlers). Will wait up to `timeoutMs` for the element
// to appear AND become enabled — disabled buttons are skipped, never
// "clicked through" their inner span.
async function clickByText(page: Page, needle: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (n: string) => {
      const els: any[] = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      return els.some((el: any) => {
        if (!el.offsetParent) return false;
        if (el.disabled) return false;
        if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
        const txt = (el.innerText || el.textContent || '').trim();
        return txt.includes(n);
      });
    },
    { timeout: timeoutMs },
    needle,
  );

  // Tag the target so we can grab a real ElementHandle for it; that's
  // robust across Angular re-renders and re-attachments.
  const tag = '__hon_click_target_' + Math.random().toString(36).slice(2, 10);
  const tagged = await page.evaluate(
    ({ n, tag }: { n: string; tag: string }) => {
      const els: any[] = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      let best: any = null;
      let bestDepth = -1;
      for (const el of els) {
        if (!el.offsetParent) continue;
        if (el.disabled) continue;
        if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') continue;
        const txt = (el.innerText || el.textContent || '').trim();
        if (!txt.includes(n)) continue;
        let d = 0;
        for (let p = el; p; p = p.parentElement) d += 1;
        if (d > bestDepth) { best = el; bestDepth = d; }
      }
      if (!best) return false;
      try { best.scrollIntoView({ block: 'center', inline: 'center' }); } catch {/* ignore */}
      best.setAttribute(tag, '1');
      return true;
    },
    { n: needle, tag },
  );
  if (!tagged) throw new Error(`Could not find an enabled clickable element matching "${needle}".`);

  // Real mouse click via CDP — dispatches mousedown, mouseup, click with
  // proper isTrusted flow, which Angular's (click) listeners react to.
  try {
    const handle = await page.$(`[${tag}]`);
    if (handle) {
      await handle.click({ delay: 30 });
      await handle.evaluate((el: any, t: string) => el.removeAttribute(t), tag);
      await handle.dispose();
      return;
    }
  } catch (err) {
    // Fall through to the JS-click fallback below.
  }
  await page.evaluate((tag: string) => {
    const el: any = document.querySelector(`[${tag}]`);
    if (el) { el.click(); el.removeAttribute(tag); }
  }, tag);
}

async function clickByTextIfPresent(page: Page, needle: string): Promise<void> {
  try {
    const ok = await page.evaluate((n: string) => {
      const all: any[] = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const el of all) {
        if (!el.offsetParent) continue;
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt.includes(n)) { el.click(); return true; }
      }
      return false;
    }, needle);
    if (ok) log.info('clicked.optional', { needle });
  } catch {/* best effort */}
}

async function pressEnter(page: Page): Promise<void> {
  try { await page.keyboard.press('Enter'); } catch {/* best effort */}
}

// Types `value` into the most-recently-visible text/tel/number input that
// isn't a checkbox. Clears prior contents first, dispatches input/change,
// then blurs so Angular's ng-touched flag flips — without that, dependent
// [disabled] bindings on submit buttons stay stuck disabled.
async function fillVisibleInput(page: Page, value: string): Promise<void> {
  const handle = await page.evaluateHandle(() => {
    const inputs: any[] = Array.from(document.querySelectorAll('input'));
    let best: any = null;
    for (const el of inputs) {
      if (!el.offsetParent) continue;
      if (el.type === 'checkbox' || el.type === 'radio') continue;
      if (el.readOnly || el.disabled) continue;
      // Prefer focused; otherwise the last one mounted.
      if (document.activeElement === el) return el;
      best = el;
    }
    return best;
  });
  const elem = handle.asElement();
  if (!elem) throw new Error('No visible text input to fill.');
  await elem.evaluate((el: any) => {
    if ('value' in el) el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await elem.focus();
  await elem.type(value, { delay: 25 });
  await elem.evaluate((el: any) => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });
}

// Finds the consent checkbox sitting next to the "תנאי השימוש" link and
// ticks it via puppeteer's real mouse-click so Angular's (click) listener
// fires AND ng-touched flips. Without ng-touched the modal's submit
// button stays disabled, so a JS-only .click() isn't enough.
async function tickConsentCheckbox(page: Page): Promise<void> {
  const tag = '__hon_consent_' + Math.random().toString(36).slice(2, 8);
  const located = await page.evaluate(
    ({ linkText, tag }: { linkText: string; tag: string }) => {
      const links: any[] = Array.from(document.querySelectorAll('a, span, button, label'));
      for (const link of links) {
        if (!link.offsetParent) continue;
        if (!(link.innerText || link.textContent || '').includes(linkText)) continue;
        let scope: any = link.closest('div, label, form') || link.parentElement;
        for (let i = 0; i < 6 && scope; i += 1) {
          const cb = scope.querySelector('input[type="checkbox"]');
          if (cb) {
            if (cb.checked) return 'already-checked';
            try { cb.scrollIntoView({ block: 'center' }); } catch {/* ignore */}
            cb.setAttribute(tag, '1');
            return 'tagged';
          }
          scope = scope.parentElement;
        }
      }
      return null;
    },
    { linkText: TEXT.termsLink, tag },
  );
  if (!located) { log.warn('consent.checkbox.missing'); return; }
  if (located === 'already-checked') return;

  try {
    const handle = await page.$(`[${tag}]`);
    if (handle) {
      // Focus, click, blur — flips both ng-dirty AND ng-touched, so the
      // form-valid binding on the submit button updates correctly.
      await handle.focus();
      await handle.click({ delay: 25 });
      await handle.evaluate((el: any) => el.dispatchEvent(new Event('blur', { bubbles: true })));
      await handle.evaluate((el: any, t: string) => el.removeAttribute(t), tag);
      await handle.dispose();
    }
  } catch (err) {
    log.warn('consent.click.failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Parses every visible card tile on the dashboard. The tiles render as a
// stack of small images with overlay text — we walk the body innerText for
// `בתוקף עד ה-MM/YY` blocks, then look for the matching balance / brand
// strings nearby. Tolerant: a tile missing one of last4/expiry/balance is
// emitted with whatever fields we did find.
async function extractCards(page: Page): Promise<ScrapedVoucher[]> {
  return page.evaluate(() => {
    // Each card tile lives inside a wrapper that contains both the image
    // (with overlayed balance + last-4) and the "בתוקף עד" caption beneath.
    // Walk every element that contains the validity caption and treat its
    // closest figure/article/section ancestor as one tile.
    const seen = new Set<any>();
    const tiles: any[] = [];
    const all: any[] = Array.from(document.querySelectorAll('div, section, article, figure, li'));
    for (const el of all) {
      const t = (el.innerText || el.textContent || '').trim();
      if (!t.includes('בתוקף עד')) continue;
      // Climb until the tile-sized container — pick the first ancestor that
      // also contains a digit pattern looking like a balance (a "₪" or a
      // 3+ digit number) plus the validity caption.
      let node: any = el;
      let host: any = null;
      for (let i = 0; i < 6 && node; i += 1) {
        const inner = (node.innerText || node.textContent || '').trim();
        if (/בתוקף עד/.test(inner) && /\d{2,}/.test(inner)) {
          host = node;
        }
        node = node.parentElement;
      }
      const target = host || el;
      if (seen.has(target)) continue;
      seen.add(target);
      tiles.push(target);
    }

    const cards: any[] = [];
    for (const tile of tiles) {
      const text = (tile.innerText || tile.textContent || '')
        .replace(/[‎‏]/g, '')          // strip Hebrew/LTR marks
        .replace(/[ \t]+/g, ' ')
        .trim();

      // Last four digits of the card number — printed as "**** **** **** 6375"
      // beneath the balance. Take the LAST 4-digit token to avoid mistaking
      // an expiry's MM/YY (which is only 2 digits each) for the card number.
      let last4 = '';
      const last4Match = text.match(/(?:\*+\s*)+(\d{3,4})/);
      if (last4Match) last4 = last4Match[1].padStart(4, '0');
      else {
        const longMatch = text.match(/\b(\d{4})\b(?!\s*\/)/);
        if (longMatch) last4 = longMatch[1];
      }

      // Expiry "MM/YY" (the bank shows them in DD/MM/YY only on transaction
      // history; the card itself is MM/YY).
      let expiresOn: string | null = null;
      const expMatch = text.match(/\b(\d{2})\s*\/\s*(\d{2})\b/);
      if (expMatch) {
        const mm = parseInt(expMatch[1], 10);
        const yy = parseInt(expMatch[2], 10);
        if (mm >= 1 && mm <= 12) {
          const fullYear = (yy >= 70 ? 1900 : 2000) + yy;
          // Last day of the expiry month — the card is valid up to and
          // including this date.
          const last = new Date(fullYear, mm, 0).getDate();
          expiresOn = `${fullYear}-${String(mm).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
        }
      }

      // Balance: pick the largest plausible NIS amount on the tile.
      let balance = 0;
      const amounts = (text.match(/\d{1,3}(?:,\d{3})*(?:\.\d+)?/g) || [])
        .map((s: string) => parseFloat(s.replace(/,/g, '')))
        .filter((n: number) => Number.isFinite(n) && n > 0 && n < 1_000_000);
      if (amounts.length) balance = Math.max(...amounts);

      // Brand: look for the alt/title of an image inside the tile first;
      // fall back to a short text token before the balance.
      let brand = '';
      const img = tile.querySelector('img');
      if (img) brand = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
      if (!brand) {
        // The card shows "תו הזהב" as overlay text near the top of the tile.
        const overlay = text.match(/תו\s*הזהב|GiftCard|תו\s*הקנייה|DeltaCard/i);
        if (overlay) brand = overlay[0].replace(/\s+/g, ' ').trim();
      }
      if (!brand) brand = 'Shufersal Gift Card';

      const externalId = last4 ? `shufersal-${last4}` : `shufersal-${brand.replace(/\s+/g, '-')}-${expiresOn || 'no-expiry'}`;

      cards.push({
        externalId,
        brand,
        last4,
        balance,
        currency: 'ILS',
        expiresOn,
      });
    }

    // De-dupe by externalId — multiple ancestor matches can yield the same
    // tile twice. Keep the row with the most-complete data.
    const byId = new Map<string, any>();
    for (const c of cards) {
      const prev = byId.get(c.externalId);
      const score = (x: any) => (x.last4 ? 1 : 0) + (x.expiresOn ? 1 : 0) + (x.balance > 0 ? 1 : 0);
      if (!prev || score(c) > score(prev)) byId.set(c.externalId, c);
    }
    return Array.from(byId.values());
  });
}

// ============================================================================
// BuyMe — https://buyme.co.il
// ============================================================================
// Login flow is email-based (no SMS): click "כניסה / הרשמה" → enter email →
// click "כניסה" → BuyMe emails a 6-digit code → enter code → click "אימות
// מייל" → land logged in → navigate to "המתנות שלי" → parse cards.

const BUYME_URL = 'https://buyme.co.il/';

const BUYME_TEXT = {
  emailLoginButton: 'כניסה',           // submit on the email step
  otpSubmitButton: 'אימות מייל',        // submit on the OTP step ("Verify email")
  myGiftsHeader: 'מתנות שאפשר לממש',   // "N gifts you can redeem" — anchor for parse
  redeemBalance: 'יתרה למימוש',        // appears once per active card
};

// BuyMe routes the login modal off the home URL; we jump straight there so
// the click-the-CTA dance is unnecessary.
const BUYME_LOGIN_URL = 'https://buyme.co.il/?modal=login';

// The wallet page is the only thing we actually need post-login. Going to
// it directly bypasses BuyMe's first-device "phone verification" prompt
// (which we can't complete from inside a puppeteer flow).
const BUYME_WALLET_URL = 'https://buyme.co.il/myAccount/wallet?status=1';

export interface BuyMeScrapeOptions {
  debugDumpPath?: string;
  headless?: boolean;
  /**
   * Path to a directory puppeteer should use as the Chrome user-data-dir.
   * When set, cookies and localStorage survive across syncs, so the next
   * scrape can skip the email-OTP flow entirely (and BuyMe stops asking
   * for phone verification on every "new device"). The caller is
   * responsible for picking a stable directory — typically
   * `<dataDir>/browser-profiles/buyme`.
   */
  userDataDir?: string;
  /** Fired once Puppeteer's browser has launched, so the caller can
   *  retain a handle for cancellation. Calling `browser.close()` from
   *  the caller is the signal that aborts the scrape — every Puppeteer
   *  op after that throws and the function returns through its catch.
   *  Mirrors HitechZoneScrapeOptions.onBrowserReady. */
  onBrowserReady?: (browser: Browser) => void;
}

export async function scrapeBuyMeGiftCards(
  email: string,
  onOtpNeeded: OtpCallback,
  options: BuyMeScrapeOptions = {},
): Promise<ScrapedVoucher[]> {
  const done = buymeLog.timer('scrape', { url: BUYME_URL });
  const normalisedEmail = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
    done({ result: 'invalid-email' });
    throw new Error('A valid email address is required.');
  }

  // When the caller supplies a `userDataDir`, sweep stale lock files Chrome
  // leaves behind on a crash so the launch isn't blocked, then make sure
  // the dir exists.
  if (options.userDataDir) {
    try { mkdirSync(options.userDataDir, { recursive: true }); } catch {/* best effort */}
    sweepStaleProfileLocks(options.userDataDir);
  }
  const browser: Browser = await puppeteer.launch({
    headless: options.headless ?? true,
    userDataDir: options.userDataDir,
    args: process.env.HON_BROWSER_NO_SANDBOX === '1'
      ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  });
  // See HitechZoneScrapeOptions.onBrowserReady — closing the browser is
  // the cancellation signal; every Puppeteer op then throws and the
  // scrape's catch returns cleanly.
  try { options.onBrowserReady?.(browser); } catch { /* never let a caller's bookkeeping break the scrape */ }
  let page: Page | undefined;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Same __name polyfill the Shufersal scraper needs — tsx wraps nested
    // arrow functions with __name(fn, "...") calls that the browser doesn't
    // define, so any evaluate with nested arrows throws.
    await page.evaluateOnNewDocument(() => {
      // @ts-expect-error — defined in the page, not in Node's types
      if (typeof globalThis.__name === 'undefined') {
        // @ts-expect-error — runtime polyfill
        globalThis.__name = (fn: unknown) => fn;
      }
    });

    // Fast path: when the profile already has a valid BuyMe session,
    // navigating to the wallet renders the gifts table directly. We try
    // that first; if we land on a logged-out state (no table within a few
    // seconds), fall through to the full email + OTP flow.
    if (options.userDataDir) {
      buymeLog.info('fastpath.try', { url: BUYME_WALLET_URL });
      try {
        await page.goto(BUYME_WALLET_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
      } catch (err) {
        buymeLog.warn('fastpath.navigate.failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      const loggedIn = await page.evaluate(() => {
        const url = location.href;
        // The wallet URL stays at /myAccount/wallet when authenticated; a
        // logged-out request gets bounced to / or shows the login modal.
        if (!url.includes('/myAccount/wallet')) return false;
        if (document.querySelector('tr.gifts-table__row')) return true;
        // No gifts is OK too — the "מתנות שאפשר לממש" header is still
        // there as long as the user is signed in.
        const t = document.body?.innerText || '';
        return t.includes('מתנות שאפשר לממש');
      }).catch(() => false);
      if (loggedIn) {
        buymeLog.info('fastpath.success');
        return await harvestCardsAndFinish(page, options, done);
      }
      buymeLog.info('fastpath.miss', { landedUrl: page.url() });
    }

    // Jump straight to BuyMe's login modal URL — bypasses the variable
    // header CTA ("כניסה \ הרשמה" with a backslash, plus shortcut links).
    buymeLog.info('navigate', { url: BUYME_LOGIN_URL });
    await page.goto(BUYME_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    buymeLog.info('navigate.done', { landedUrl: page.url() });

    // The "כניסה עם מייל" method picker mounts in the modal — click it to
    // expose the email-entry step. The same text also appears in a mobile
    // hamburger accordion outside the modal, so we MUST scope the lookup
    // to the modal's container (`.login-popup__content`) — clicking the
    // accordion variant opens the menu but doesn't transition the modal.
    try {
      await clickInsideContainer(
        page,
        '.login-popup__content',
        'button.login-method-button',
        'כניסה עם מייל',
        15_000,
      );
      buymeLog.info('login.method.clicked');
    } catch (err) {
      if (options.debugDumpPath) {
        try { writeFileSync(options.debugDumpPath, await page.content(), 'utf8'); }
        catch {/* best effort */}
      }
      throw new Error(
        'Could not find the "כניסה עם מייל" button inside the BuyMe login modal '
        + '— the layout may have changed. See debug HTML dump.',
      );
    }

    // Fill the email input. BuyMe's footer newsletter also has
    // `input[name="email"]`, so scope to the modal container. The modal's
    // email field is the first input under `.login-popup__content`
    // regardless of placeholder language (the placeholder varies between
    // locales / A-B variants).
    const MODAL_EMAIL_SELECTOR = '.login-popup__content input[name="email"]';
    await page.waitForFunction(
      (sel: string) => {
        const el: any = document.querySelector(sel);
        return !!el && el.offsetParent !== null;
      },
      { timeout: 20_000 },
      MODAL_EMAIL_SELECTOR,
    );
    buymeLog.info('email.input.ready');
    await fillBySelector(page, MODAL_EMAIL_SELECTOR, normalisedEmail);
    buymeLog.info('email.filled');

    // Wait for the modal's "כניסה" submit to enable, then click it via the
    // scoped helper. Critical to scope: the header accordion has a "כניסה
    // \ הרשמה" link whose innerText also contains "כניסה", and a global
    // text search would click that instead of the modal's button.
    try {
      await page.waitForFunction(
        () => {
          const container = document.querySelector('.login-popup__content');
          if (!container) return false;
          const btns: any[] = Array.from(container.querySelectorAll('button'));
          return btns.some((b: any) => {
            if (b.disabled) return false;
            if (b.getAttribute && b.getAttribute('aria-disabled') === 'true') return false;
            const t = (b.innerText || b.textContent || '').trim();
            return t === 'כניסה' && b.offsetParent !== null;
          });
        },
        { timeout: 10_000 },
      );
    } catch {
      buymeLog.warn('email.submit.still.disabled');
    }
    await clickInsideContainer(
      page,
      '.login-popup__content',
      'button',
      'כניסה',
      15_000,
    );
    buymeLog.info('email.submit.clicked');

    // BuyMe emails a 6-digit code and swaps the modal to an OTP screen with
    // `input[name="code"]` (placeholder "------"). Wait for that input
    // specifically AND require it to be visible — input[name="code"] is
    // not present until the email step succeeds, so this signal also
    // confirms the email actually went through.
    try {
      await page.waitForFunction(
        () => {
          const el: any = document.querySelector('input[name="code"]');
          return !!el && el.offsetParent !== null;
        },
        { timeout: 30_000 },
      );
      buymeLog.info('otp.input.ready');
    } catch (err) {
      if (options.debugDumpPath) {
        try { writeFileSync(options.debugDumpPath, await page.content(), 'utf8'); }
        catch {/* best effort */}
      }
      throw new Error(
        'BuyMe did not move to the email-code step. The email might be '
        + 'unrecognised, or the layout changed. See debug HTML dump.',
      );
    }

    const code = await onOtpNeeded();
    if (!code) throw new Error('OTP entry was cancelled.');
    buymeLog.info('otp.received', { length: code.length });

    await fillBySelector(page, 'input[name="code"]', code.replace(/\D/g, ''));
    buymeLog.info('otp.filled');

    try {
      await clickInsideContainer(
        page,
        '.login-popup__content',
        'button',
        BUYME_TEXT.otpSubmitButton,
        10_000,
      );
      buymeLog.info('otp.submit.clicked');
    } catch (err) {
      buymeLog.warn('otp.submit.click.failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      await pressEnter(page);
    }

    // BuyMe lands on either the home page OR a "phone verification" modal
    // (?modal=phoneOtp) — for first-device logins they force a phone-OTP
    // step. We can't complete a phone OTP from inside puppeteer (no SMS
    // back-channel), but the wallet page is reachable while that modal is
    // still showing, so jump straight there instead of waiting on it.
    try {
      await page.waitForFunction(
        () => (document.body?.innerText || '').includes('החשבון שלי'),
        { timeout: 30_000 },
      );
      buymeLog.info('logged.in', { landedUrl: page.url() });
    } catch (err) {
      if (options.debugDumpPath) {
        try { writeFileSync(options.debugDumpPath, await page.content(), 'utf8'); }
        catch {/* best effort */}
      }
      throw new Error(
        'BuyMe did not accept the verification code — make sure you typed '
        + 'the exact 6-digit code from the email and try again.',
      );
    }

    buymeLog.info('wallet.navigate', { url: BUYME_WALLET_URL });
    await page.goto(BUYME_WALLET_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    // The wallet page renders even when the phone-OTP modal is technically
    // still "active" — wait specifically for the gifts-table rows or the
    // "מתנות שאפשר לממש" header. When the user has zero active gifts the
    // header is still present ("0 מתנות"), so anchor on it instead of the
    // table.
    try {
      await page.waitForFunction(
        (needle: string) =>
          !!document.querySelector('tr.gifts-table__row')
          || (document.body?.innerText || '').includes(needle),
        { timeout: 30_000 },
        BUYME_TEXT.myGiftsHeader,
      );
      buymeLog.info('wallet.ready');
    } catch {
      buymeLog.warn('wallet.header.missing');
    }

    return await harvestCardsAndFinish(page, options, done);
  } catch (err) {
    buymeLog.error('scrape.threw', {
      message: err instanceof Error ? err.message : String(err),
    });
    if (page && options.debugDumpPath) {
      try { writeFileSync(options.debugDumpPath, await page.content(), 'utf8'); }
      catch {/* best effort */}
    }
    done({ result: 'exception' });
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Shared tail used by both the fast-path (we're already logged in via the
// persistent profile) and the full login flow. Dumps the wallet HTML for
// offline parser tuning, runs the per-row parser, and reports the timer.
async function harvestCardsAndFinish(
  page: Page,
  options: BuyMeScrapeOptions,
  done: (fields?: Record<string, unknown>) => void,
): Promise<ScrapedVoucher[]> {
  if (options.debugDumpPath) {
    try {
      writeFileSync(options.debugDumpPath, await page.content(), 'utf8');
      buymeLog.info('debug.dump', { path: options.debugDumpPath });
    } catch {/* best effort */}
  }
  const cards = await extractBuyMeCards(page);
  buymeLog.info('cards.extracted', { count: cards.length });
  done({ result: 'ok', cards: cards.length });
  return cards;
}

// Chrome writes lock files in the profile dir on launch and removes them on
// clean shutdown. A crashed/killed previous run leaves them behind and the
// next launch errors with "browser is already running for <dir>". Sweep
// unconditionally — if Chrome IS still running it'll recreate them.
function sweepStaleProfileLocks(profileDir: string): void {
  const targets = [
    'DevToolsActivePort',
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'Default/LOCK',
  ];
  for (const rel of targets) {
    try { unlinkSync(join(profileDir, rel)); }
    catch (err: any) { if (err?.code !== 'ENOENT') {/* best effort */} }
  }
}

// Fills `input[name="<name>"]` via the native setter so React's onChange
// handler picks up the new value. fillVisibleInput picks "any visible
// input" which is too loose for BuyMe (the page hosts hidden search +
// marketing email inputs alongside the modal field).
async function fillNamedInput(page: Page, name: string, value: string): Promise<void> {
  await fillBySelector(page, `input[name="${name}"]`, value);
}

// Click the first visible, enabled element matching `childSelector` whose
// trimmed innerText matches `text`, scoped to descendants of an element
// matching `containerSelector`. Solves the BuyMe duplicate-button problem
// where the same label exists inside a mobile accordion and inside the
// login modal — and a global clickByText was clicking the wrong one.
async function clickInsideContainer(
  page: Page,
  containerSelector: string,
  childSelector: string,
  text: string,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    ({ container, child, needle }: { container: string; child: string; needle: string }) => {
      const containers: any[] = Array.from(document.querySelectorAll(container));
      for (const c of containers) {
        if (!c.offsetParent) continue;
        const cands: any[] = Array.from(c.querySelectorAll(child));
        if (cands.some((el: any) =>
          el.offsetParent !== null
          && !el.disabled
          && el.getAttribute('aria-disabled') !== 'true'
          && (el.innerText || el.textContent || '').trim().includes(needle))) {
          return true;
        }
      }
      return false;
    },
    { timeout: timeoutMs },
    { container: containerSelector, child: childSelector, needle: text },
  );
  const tag = '__hon_scoped_click_' + Math.random().toString(36).slice(2, 10);
  const tagged = await page.evaluate(
    ({ container, child, needle, tag }: { container: string; child: string; needle: string; tag: string }) => {
      const containers: any[] = Array.from(document.querySelectorAll(container));
      for (const c of containers) {
        if (!c.offsetParent) continue;
        const cands: any[] = Array.from(c.querySelectorAll(child));
        for (const el of cands) {
          if (!el.offsetParent) continue;
          if (el.disabled) continue;
          if (el.getAttribute('aria-disabled') === 'true') continue;
          const txt = (el.innerText || el.textContent || '').trim();
          if (!txt.includes(needle)) continue;
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {/* ignore */}
          el.setAttribute(tag, '1');
          return true;
        }
      }
      return false;
    },
    { container: containerSelector, child: childSelector, needle: text, tag },
  );
  if (!tagged) throw new Error(`No enabled "${text}" inside ${containerSelector}.`);
  try {
    const handle = await page.$(`[${tag}]`);
    if (handle) {
      await handle.click({ delay: 30 });
      await handle.evaluate((el: any, t: string) => el.removeAttribute(t), tag);
      await handle.dispose();
      return;
    }
  } catch {/* fall through */}
  await page.evaluate((tag: string) => {
    const el: any = document.querySelector(`[${tag}]`);
    if (el) { el.click(); el.removeAttribute(tag); }
  }, tag);
}

// Fills the first input matching `selector`, using the React-aware native
// setter so the form's onChange picks the value up. Prefer this over
// fillNamedInput when an input attribute is ambiguous between the modal
// and other parts of the page (e.g. BuyMe's footer newsletter form).
async function fillBySelector(page: Page, selector: string, value: string): Promise<void> {
  await page.evaluate(
    ({ selector, value }: { selector: string; value: string }) => {
      const el: any = document.querySelector(selector);
      if (!el) throw new Error(`No element matches ${selector}`);
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (proto && proto.set) proto.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    },
    { selector, value },
  );
}

// Parses each gift-card row on BuyMe's wallet page. Cards render as
// `<tr class="gifts-table__row">` with five cells; we drive directly off
// that schema (verified against the real DOM via chrome-devtools-mcp).
//   • cell[1] .gifts-table__cell--title:
//       <span class="gifts-table__text">BUYME ALL - מגוון אדיר ...</span>   ← title
//       <p><span class="gifts-table__text gifts-table__text--gray">
//                                 יתרה למימוש:</span><b> ₪120</b>
//                  <span class="gifts-table__original-text">/₪120</span></p> ← balance
//   • cell[2] .gifts-table__cell--recipient: "לשחר סולומונס" + "מiDigital"
//   • cell[4] .gifts-table__cell--actions:
//       <a href="https://buyme.co.il/giftcard/{stable-id}?source=wallet"> ← stable id
//   • brand also exposed as alt= on the cell[0] gift image.
async function extractBuyMeCards(page: Page): Promise<ScrapedVoucher[]> {
  return page.evaluate(() => {
    // Best-effort balance parse: BuyMe formats it as "₪120/₪120" — first
    // number is current, second is total. We always take the first.
    const parseBalance = (text: string): number => {
      const m = text.match(/₪\s*([\d,]+(?:\.\d+)?)/);
      if (m) return parseFloat(m[1].replace(/,/g, ''));
      const fallback = text.match(/[\d,]+(?:\.\d+)?/);
      return fallback ? parseFloat(fallback[0].replace(/,/g, '')) : 0;
    };
    // The gift link is the stable id source — its URL has a slug like
    // `/giftcard/47hmjm427crpv?source=wallet`. We use that slug as the
    // externalId so a re-sync upserts the same row in place.
    const extractId = (row: any): string | null => {
      const link = row.querySelector('a[href*="/giftcard/"]');
      if (!link) return null;
      const m = link.getAttribute('href').match(/\/giftcard\/([A-Za-z0-9\-_]+)/);
      return m ? m[1] : null;
    };

    const rows: any[] = Array.from(document.querySelectorAll('tr.gifts-table__row'));
    const out: any[] = [];
    rows.forEach((row, i) => {
      const titleCell = row.querySelector('.gifts-table__cell--title');
      const titleText = ((titleCell && titleCell.querySelector('.gifts-table__text')?.textContent) || '').trim();
      const balanceText = (titleCell?.querySelector('p')?.textContent || '').trim();
      const balance = parseBalance(balanceText);
      const brandImg = row.querySelector('.gifts-table__image, .gifts-table__cell--image img');
      const brandAlt = (brandImg && brandImg.getAttribute('alt')) || '';
      const stableId = extractId(row);

      // BuyMe's title is the full marketing line ("BUYME ALL - מגוון אדיר
      // במתנה אחת"). We use it verbatim as the display name; the brand
      // (e.g. "BUYME ALL") is the alt-text on the gift image, which is
      // shorter but less informative on its own. Prefer the title.
      const displayName = titleText || brandAlt || 'BuyMe gift';
      const externalId = stableId
        ? `buyme-${stableId}`
        : `buyme-row-${i}-${displayName.slice(0, 30).replace(/[^A-Za-z0-9]+/g, '-')}`;

      out.push({
        externalId,
        brand: displayName,
        last4: '',
        balance,
        currency: 'ILS',
        expiresOn: null as string | null,
      });
    });
    return out;
  });
}

// ============================================================================
// Hi-Tech Zone — https://htz.mltp.co.il/Getballance
// ============================================================================
// Different shape from the others: there's no account login, just a balance
// lookup page. The user enters their 8-9 digit "digital code" (the prefix
// of the physical card number), then solves a Google reCAPTCHA, then
// submits. The next page (/Ballance — note the typo) renders one line:
//   "הי <code> ,\nיתרתך: <balance> ₪\nנכון לתאריך : DD/MM/YYYY\n..."
//
// reCAPTCHA cannot be solved headlessly, so this scraper ALWAYS launches a
// visible browser window. The puppeteer step fills the digital code, then
// waits for the user to tick the CAPTCHA + click שלח themselves. The end
// signal is a URL change to /Ballance (or the balance text appearing).

const HTZ_GETBALANCE_URL = 'https://htz.mltp.co.il/Getballance';

const htzLog = makeLog('vouchers:htz');

export interface HitechZoneScrapeOptions {
  debugDumpPath?: string;
  userDataDir?: string;
  /** Override the post-submit wait window (default 180s — enough time
   *  for the user to comfortably solve the CAPTCHA). */
  userActionTimeoutMs?: number;
  /** Fired once Puppeteer's browser has launched, so the caller can
   *  retain a handle for cancellation. Calling `browser.close()` from
   *  the caller is the signal that aborts the scrape — every Puppeteer
   *  op after that throws and the function returns through its catch. */
  onBrowserReady?: (browser: Browser) => void;
}

export async function scrapeHitechZoneBalance(
  digitalCode: string,
  options: HitechZoneScrapeOptions = {},
): Promise<ScrapedVoucher[]> {
  const done = htzLog.timer('scrape', { url: HTZ_GETBALANCE_URL });
  const code = String(digitalCode || '').replace(/\D/g, '');
  if (!/^\d{8,9}$/.test(code)) {
    done({ result: 'invalid-code' });
    throw new Error('The htzone digital code must be 8 or 9 digits.');
  }

  if (options.userDataDir) {
    try { mkdirSync(options.userDataDir, { recursive: true }); } catch {/* best effort */}
    sweepStaleProfileLocks(options.userDataDir);
  }
  // CRITICAL: visible (non-headless). reCAPTCHA's bot-detection refuses to
  // present a checkbox in headless Chrome, and the user has to click it
  // themselves either way. ALSO prefer the real installed Chrome over the
  // bundled Chromium — reCAPTCHA fingerprints vanilla Chromium too and
  // can outright refuse the checkbox or auto-fail it. Mirrors the same
  // tradeoff pension.ts makes for Meitav/Menora's CAPTCHA flow.
  const launchArgs = [
    ...(process.env.HON_BROWSER_NO_SANDBOX === '1'
      ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    '--window-size=900,720',
    // Hide the "Chrome is being controlled by automated test software"
    // banner AND the navigator.webdriver=true signal that Cloudflare's
    // Turnstile checks. Without these, htz.mltp.co.il (now Cloudflare-
    // protected) parks the browser on the "Performing security
    // verification" interstitial indefinitely and #eightDigit never
    // renders. The flag has been in stable Chrome since 89.
    '--disable-blink-features=AutomationControlled',
  ];
  const launchOpts = {
    headless: false as const,
    defaultViewport: null,
    userDataDir: options.userDataDir,
    args: launchArgs,
    // Drop the default --enable-automation switch so the info bar and
    // the related JS flags (navigator.webdriver, window.cdc_*) are not
    // injected. Combined with the args flag above this matches what
    // most "stealth" plugins do as their first step.
    ignoreDefaultArgs: ['--enable-automation'],
  };
  let browser: Browser;
  try {
    browser = await puppeteer.launch({ ...launchOpts, channel: 'chrome' });
  } catch (err) {
    htzLog.warn('chrome.unavailable', {
      message: err instanceof Error ? err.message : String(err),
    });
    // Chrome isn't installed (or the channel doesn't exist on this OS).
    // Fall back to bundled Chromium — reCAPTCHA MAY still work, just
    // less reliably; surfacing the warning helps debug "checkbox never
    // appeared" reports.
    browser = await puppeteer.launch(launchOpts);
  }
  // Hand the browser to the caller so a cancel request can close it,
  // which makes every subsequent Puppeteer op throw — the scrape's
  // catch block then returns and the server's IIFE finishes cleanly
  // without writing a voucher the user cancelled.
  try { options.onBrowserReady?.(browser); } catch { /* never let a caller's bookkeeping break the scrape */ }
  let page: Page | undefined;
  try {
    page = await browser.newPage();
    // tsx __name polyfill for the same reason BuyMe needs it.
    await page.evaluateOnNewDocument(() => {
      // @ts-expect-error — defined in the page, not in Node's types
      if (typeof globalThis.__name === 'undefined') {
        // @ts-expect-error — runtime polyfill
        globalThis.__name = (fn: unknown) => fn;
      }
    });
    // Cloudflare's Turnstile reads navigator.webdriver before letting the
    // page render — the launch-args trick covers most Chrome builds but
    // some versions still expose the getter. Override it here too.
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: () => undefined, configurable: true,
        });
      } catch { /* property already shadowed */ }
    });

    htzLog.info('navigate', { url: HTZ_GETBALANCE_URL });
    await page.goto(HTZ_GETBALANCE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    htzLog.info('navigate.done', { landedUrl: page.url() });

    // Sometimes the persistent profile carries a session that lets us skip
    // straight to /Ballance — if so, harvest and return. Wait for the
    // balance LINE to be present first; landing on /Ballance only means
    // the route's HTML shell loaded, not that the SPA has finished
    // rendering the balance text. (Previously: harvest fired on
    // domcontentloaded, returned null, surfaced as "layout may have
    // changed" on a perfectly healthy session.)
    if (/\/Ballance/i.test(page.url())) {
      htzLog.info('fastpath.balance.already');
      await waitForHtzBalanceLine(page, 20_000).catch(() => {});
      return await harvestHtzAndFinish(page, options, done, code);
    }

    // Fill the digital-code input. The form has just one visible text
    // input (#eightDigit) — fill it via the React-aware setter.
    // The site has been put behind Cloudflare's "Performing security
    // verification" interstitial (Ray-ID page), which can keep the user
    // there for 30-60s before letting the real form HTML render. The
    // earlier 20s budget was tighter than Cloudflare's clear time and
    // caused "Waiting failed: 20000ms exceeded" on perfectly good
    // sessions; 90s leaves room for the challenge to settle.
    await page.waitForFunction(
      () => !!document.querySelector('#eightDigit'),
      { timeout: 90_000 },
    );
    await fillBySelector(page, '#eightDigit', code);
    htzLog.info('code.filled');

    // Now wait for the user to solve the CAPTCHA and click שלח themselves.
    // The condition matches the full balance LINE shape (יתרתך: <number> ₪)
    // rather than just the substring 'יתרתך' — a header/marketing/skeleton
    // mention of the word would otherwise satisfy the wait before the real
    // balance was computed, and the subsequent extract would return null.
    const wait = options.userActionTimeoutMs ?? 180_000;
    htzLog.info('awaiting.user.action', { timeoutMs: wait });
    try {
      await waitForHtzBalanceLine(page, wait);
    } catch {
      if (options.debugDumpPath) {
        try { writeFileSync(options.debugDumpPath, await page.content(), 'utf8'); }
        catch {/* best effort */}
      }
      throw new Error(
        'Hi-Tech Zone balance never loaded. Did you tick the reCAPTCHA '
        + 'and click שלח within ' + Math.round(wait / 1000) + 's?',
      );
    }
    htzLog.info('balance.page.ready', { landedUrl: page.url() });

    return await harvestHtzAndFinish(page, options, done, code);
  } catch (err) {
    htzLog.error('scrape.threw', {
      message: err instanceof Error ? err.message : String(err),
    });
    if (page && options.debugDumpPath) {
      try { writeFileSync(options.debugDumpPath, await page.content(), 'utf8'); }
      catch {/* best effort */}
    }
    done({ result: 'exception' });
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function harvestHtzAndFinish(
  page: Page,
  options: HitechZoneScrapeOptions,
  done: (fields?: Record<string, unknown>) => void,
  code: string,
): Promise<ScrapedVoucher[]> {
  if (options.debugDumpPath) {
    try {
      writeFileSync(options.debugDumpPath, await page.content(), 'utf8');
      htzLog.info('debug.dump', { path: options.debugDumpPath });
    } catch {/* best effort */}
  }
  // Retry the extract a few times with short delays. The fastpath path
  // hits this before the SPA has fully painted; the post-CAPTCHA path
  // can also race a navigation/repaint. A 3×500ms loop is enough for
  // any normal render without slowing successful runs noticeably.
  let parsed = await extractHtzBalance(page, code);
  for (let attempt = 0; attempt < 3 && !parsed; attempt += 1) {
    await new Promise((r) => setTimeout(r, 500));
    parsed = await extractHtzBalance(page, code);
  }
  htzLog.info('balance.extracted', {
    found: !!parsed,
    balance: parsed?.balance ?? null,
  });
  if (!parsed) {
    // Distinguish "wrong/expired code" from "layout actually changed"
    // by sniffing for HTZ's known error strings on the result page.
    // A user mistyping the code is by far the more common failure;
    // surfacing the right cause shortens the support loop.
    const errorHint = await detectHtzErrorMessage(page).catch(() => null);
    done({ result: 'no-balance', errorHint: errorHint ?? null });
    throw new Error(
      errorHint
        ? `Hi-Tech Zone rejected the lookup: ${errorHint}. Double-check the digital code.`
        : 'Could not read the Hi-Tech Zone balance from the result page. '
          + 'The layout may have changed — see debug HTML dump.',
    );
  }
  done({ result: 'ok', cards: 1 });
  return [parsed];
}

/**
 * Returns a short Hebrew error string when the /Ballance page shows
 * one of HTZ's known rejection messages (invalid code, expired, etc.)
 * rather than a balance. Null when no known error pattern matches —
 * which is the "we honestly don't know what's on the page" case.
 */
async function detectHtzErrorMessage(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
    // Known patterns observed live and reported in the wild. Order
    // matters only for which one we surface — all map to "the code
    // wasn't accepted, the layout is fine."
    const patterns: { re: RegExp; label: string }[] = [
      { re: /הקוד\s+אינו\s+תקין/, label: 'הקוד אינו תקין' },
      { re: /הקוד\s+לא\s+נמצא/, label: 'הקוד לא נמצא' },
      { re: /קוד\s+שגוי/, label: 'קוד שגוי' },
      { re: /(פג|פגה)\s+תוקף/, label: 'התוקף פג' },
      { re: /הכרטיס\s+אינו\s+פעיל/, label: 'הכרטיס אינו פעיל' },
    ];
    for (const { re, label } of patterns) {
      if (re.test(text)) return label;
    }
    return null;
  });
}

/**
 * Waits for the actual balance line to render in the page body. The
 * predicate matches the full shape `יתרתך: <number> ₪` rather than the
 * substring `יתרתך` alone — header/marketing/skeleton text containing
 * the word would otherwise satisfy the wait before the SPA had painted
 * the number, leading to a null read in extractHtzBalance and a
 * misleading "layout may have changed" error.
 *
 * Throws on timeout; callers wrap with `.catch(() => {})` when the wait
 * is best-effort (fastpath) and re-throw when the wait is required
 * (post-CAPTCHA).
 */
async function waitForHtzBalanceLine(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return /יתרתך\s*[:：]?\s*[\d,.]+\s*₪/.test(text);
    },
    { timeout: timeoutMs, polling: 1000 },
  );
}

// Parses the /Ballance text. The whole result is in body text, e.g.:
//   "הי 144678784 ,\nיתרתך: 350 ₪\nנכון לתאריך : 26/05/2026"
// We pull the balance amount (the number after יתרתך:) and the as-of
// date (after נכון לתאריך). Card identity is the digital code itself —
// it's both the lookup key and the only stable id we have.
async function extractHtzBalance(
  page: Page,
  code: string,
): Promise<ScrapedVoucher | null> {
  const data = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return { text };
  });
  const balanceMatch = data.text.match(/יתרתך\s*[:：]?\s*([\d,.]+)\s*₪/);
  if (!balanceMatch) return null;
  const balance = parseFloat(balanceMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(balance)) return null;
  // Trailing 4 digits of the code give us a "name" that hides the rest.
  const last4 = code.slice(-4);
  const name = `Hi-Tech Zone כרטיס ****${last4}`;
  return {
    externalId: `htz-${code}`,
    brand: name,
    last4,
    balance,
    currency: 'ILS',
    expiresOn: null,
  };
}
