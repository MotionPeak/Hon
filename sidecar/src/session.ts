import type { Browser, Cookie } from 'puppeteer';
import type { Vault } from './vault.js';
import { makeLog } from './log.js';

const log = makeLog('session');

// A saved browser session goes stale once the institution expires it. Past
// this age the bundle is dropped unused: replaying long-dead cookies only
// wastes a navigation, and the cap bounds how long a leaked bundle is useful.
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface SessionBundle {
  savedAt: number;
  cookies: Cookie[];
}

/**
 * A per-connection browser session: the cookies captured at the end of a
 * successful sync, stored encrypted in the vault so a later sync can resume
 * without repeating the whole sign-in. When the vault is locked a no-op handle
 * is returned (no cookies, `save` ignored) — session reuse is best-effort and
 * never blocks a sync.
 */
export interface SessionHandle {
  /** Cookies from the last successful sync, when a fresh bundle exists. */
  readonly cookies: Cookie[] | undefined;
  /** Persists the cookies captured at the end of a successful sync. */
  save(cookies: Cookie[]): void;
}

/** Loads a connection's saved session (if any) and returns a handle to it. */
export function openSession(vault: Vault, connectionId: string): SessionHandle {
  const key = `session:${connectionId}`;
  let cookies: Cookie[] | undefined;
  if (!vault.unlocked) {
    log.debug('open.vault-locked', { connectionId });
  } else {
    try {
      const blob = vault.loadSecret(key);
      if (blob) {
        const bundle = JSON.parse(blob) as SessionBundle;
        const ageMs = Date.now() - bundle.savedAt;
        if (
          Array.isArray(bundle.cookies) &&
          bundle.cookies.length > 0 &&
          ageMs < SESSION_MAX_AGE_MS
        ) {
          cookies = bundle.cookies;
          log.info('open.hit', {
            connectionId,
            cookieCount: cookies.length,
            ageHours: Math.round(ageMs / 3_600_000),
          });
        } else {
          log.info('open.stale', {
            connectionId,
            cookieCount: bundle.cookies?.length ?? 0,
            ageHours: Math.round(ageMs / 3_600_000),
            maxAgeHours: SESSION_MAX_AGE_MS / 3_600_000,
          });
        }
      } else {
        log.debug('open.miss', { connectionId });
      }
    } catch (err) {
      log.warn('open.corrupt', {
        connectionId,
        message: err instanceof Error ? err.message : String(err),
      });
      cookies = undefined; // a corrupt or unreadable bundle just means "no session"
    }
  }
  return {
    cookies,
    save(next: Cookie[]): void {
      if (!vault.unlocked) {
        log.debug('save.vault-locked', { connectionId });
        return;
      }
      if (next.length === 0) {
        log.debug('save.empty', { connectionId });
        return;
      }
      try {
        const bundle: SessionBundle = { savedAt: Date.now(), cookies: next };
        vault.saveSecret(key, JSON.stringify(bundle));
        log.info('save.ok', { connectionId, cookieCount: next.length });
      } catch (err) {
        log.warn('save.failed', {
          connectionId,
          message: err instanceof Error ? err.message : String(err),
        });
        /* best effort — a failed save just means the next sync signs in fresh */
      }
    },
  };
}

/**
 * Replays a saved session's cookies into a freshly launched browser, before
 * any navigation. Returns true when cookies were applied. Safe to call with no
 * session — it simply does nothing.
 */
export async function restoreSession(
  browser: Browser,
  session?: SessionHandle,
): Promise<boolean> {
  const cookies = session?.cookies;
  if (!cookies || cookies.length === 0) {
    log.debug('restore.skip', { reason: !session ? 'no-handle' : 'no-cookies' });
    return false;
  }
  // Drop cookies that already expired (each carries its own `expires`, often
  // shorter than the 7-day bundle TTL). Replaying a dead auth cookie leaves the
  // bank half-authenticated — the failure mode the 'max' denylist works around.
  const nowSec = Date.now() / 1000;
  const live = cookies.filter(
    (c) => !(typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec),
  );
  if (live.length === 0) {
    log.debug('restore.skip', { reason: 'all-expired' });
    return false;
  }
  try {
    await browser.setCookie(...live);
    log.info('restore.ok', { cookieCount: live.length });
    return true;
  } catch (err) {
    log.warn('restore.failed', {
      cookieCount: cookies.length,
      message: err instanceof Error ? err.message : String(err),
    });
    return false; // an unusable cookie set just falls back to a fresh sign-in
  }
}

/**
 * Captures the browser's current cookies into the session after a successful
 * sync, so the next one can resume. Best-effort: a failure is swallowed.
 */
export async function persistSession(
  browser: Browser,
  session?: SessionHandle,
): Promise<void> {
  if (!session) {
    log.debug('persist.skip', { reason: 'no-handle' });
    return;
  }
  try {
    session.save(await browser.cookies());
  } catch (err) {
    log.warn('persist.failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    /* best effort */
  }
}
