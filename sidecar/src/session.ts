import type { Browser, Cookie } from 'puppeteer';
import type { Vault } from './vault.js';

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
  if (vault.unlocked) {
    try {
      const blob = vault.loadSecret(key);
      if (blob) {
        const bundle = JSON.parse(blob) as SessionBundle;
        if (
          Array.isArray(bundle.cookies) &&
          bundle.cookies.length > 0 &&
          Date.now() - bundle.savedAt < SESSION_MAX_AGE_MS
        ) {
          cookies = bundle.cookies;
        }
      }
    } catch {
      cookies = undefined; // a corrupt or unreadable bundle just means "no session"
    }
  }
  return {
    cookies,
    save(next: Cookie[]): void {
      if (!vault.unlocked || next.length === 0) return;
      try {
        const bundle: SessionBundle = { savedAt: Date.now(), cookies: next };
        vault.saveSecret(key, JSON.stringify(bundle));
      } catch {
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
  if (!cookies || cookies.length === 0) return false;
  try {
    await browser.setCookie(...cookies);
    return true;
  } catch {
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
  if (!session) return;
  try {
    session.save(await browser.cookies());
  } catch {
    /* best effort */
  }
}
