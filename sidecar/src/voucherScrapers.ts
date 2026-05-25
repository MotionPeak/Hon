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
import { writeFileSync } from 'node:fs';
import { makeLog } from './log.js';

declare const document: any;
declare const window: any;

const log = makeLog('vouchers:shufersal');

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
