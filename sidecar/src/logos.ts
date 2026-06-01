import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Resolves and caches an institution's logo. israeli-bank-scrapers ships no
// logos and public favicon services barely cover Israeli banks, so Hon fetches
// each bank's favicon straight from its own website and caches it on disk.
// Nothing goes through a third-party logo service.

export interface CachedLogo {
  contentType: string;
  body: Buffer;
}

/**
 * Validates a companyId before it is interpolated into a logo cache filename
 * (`<dataDir>/logos/<companyId>.img`). Without this an id like
 * `../../etc/passwd` would escape the logos directory (path traversal) and a
 * crafted id could poison the on-disk cache.
 *
 * The charset intentionally allows dots and hyphens because legitimate ids
 * include `brk-<domain>` (e.g. `brk-interactivebrokers.ca`) and `voucher-<id>`.
 * To stay safe while allowing dots, any `..` sequence is rejected outright —
 * that is the only way a dot can be used to climb directories. Slashes and
 * backslashes are excluded by the charset, so a single isolated dot is inert.
 */
export function isSafeCompanyId(companyId: string): boolean {
  if (companyId.includes('..')) return false;
  return /^[A-Za-z0-9._-]{1,60}$/.test(companyId);
}

/**
 * Returns true only for a public, brand-style hostname that is safe to fetch a
 * logo from. The caller's hostname regex (`^[a-z0-9-]+(\.[a-z0-9-]+)+$`) still
 * lets through raw IPs and internal names — `127.0.0.1`, `169.254.169.254`
 * (cloud metadata), `192.168.x.x` / `10.x` / `172.16-31.x` (RFC-1918),
 * `localhost`, `*.local`. A malicious local browser tab could pass any of those
 * as `?domain=` and make Hon fetch an internal/link-local host (SSRF, H-1).
 *
 * Logo domains are ALWAYS real brand hostnames with an alphabetic TLD
 * (`interactivebrokers.ca`, `max.co.il`) and never IP literals, so the rule is:
 *   - the final label must be alphabetic (`\.[a-z]{2,}$`). This rejects every
 *     IPv4 literal outright (the last octet is digits) including link-local and
 *     loopback addresses, and anything with a numeric TLD.
 *   - reject loopback / mDNS names explicitly: `localhost`, `*.local`,
 *     `*.localdomain` (these have an alpha "TLD" so the rule above misses them).
 * IPv6 literals can't reach here — they contain `:` which the caller's regex
 * already rejects — but the alpha-TLD test would also block a bare hex form.
 */
export function isPublicLogoDomain(domain: string): boolean {
  const host = domain.trim().toLowerCase();
  if (!host) return false;
  // Final label must be an alphabetic TLD — blocks all raw IPv4 (last octet is
  // numeric) and numeric-TLD junk.
  if (!/\.[a-z]{2,}$/.test(host)) return false;
  // Explicit loopback / mDNS names that survive the alpha-TLD test.
  if (host === 'localhost' || host === 'localhost.localdomain') return false;
  if (host.endsWith('.local') || host.endsWith('.localdomain')) return false;
  if (host.endsWith('.localhost')) return false;
  // Private/cloud internal TLD (e.g. metadata.google.internal).
  if (host.endsWith('.internal')) return false;
  return true;
}

/**
 * True for a resolved IP that must never be fetched: loopback, link-local
 * (incl. the cloud metadata endpoint `169.254.169.254`), RFC-1918 private,
 * CGNAT, the unspecified address, and their IPv6 equivalents (`::1`, `fe80::/10`
 * link-local, `fc00::/7` unique-local, the unspecified `::`, and IPv4-mapped
 * `::ffff:a.b.c.d` which is unwrapped to its embedded IPv4). This is the
 * DNS-rebinding backstop: `isPublicLogoDomain` only inspects the *name*, so a
 * public-looking host whose A/AAAA record points inward is caught here, after
 * resolution (M7/M8).
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) {
    const v6 = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded IPv4.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
    if (v6.startsWith('fe8') || v6.startsWith('fe9') ||
        v6.startsWith('fea') || v6.startsWith('feb')) return true; // fe80::/10 link-local
    // fc00::/7 unique-local (fc00–fdff).
    if (/^f[cd]/.test(v6)) return true;
    return false;
  }
  // Not a recognisable IP literal — treat as unsafe (fail closed).
  return true;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed — fail closed
  }
  const [a, b] = parts;
  if (a === 0 || a === 127) return true; // 0.0.0.0/8 unspecified, 127/8 loopback
  if (a === 10) return true; // 10/8 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

/**
 * Gate every outbound logo hop on a *resolved* host. Throws (fail closed) when
 * the host is an IP literal (logo domains are always brand hostnames — an IP
 * `?domain=` or a redirect to one is the SSRF signal), when it fails the
 * public-hostname rule, or when ANY of its resolved addresses is private/
 * loopback/link-local. Resolving every address (not just the first) defeats a
 * rebinding record that mixes a public and a private answer.
 */
async function assertPublicHost(host: string): Promise<void> {
  const h = host.trim().toLowerCase();
  // Reject IP literals outright — covers a raw-IP redirect/href the name-based
  // rule below would otherwise let through (an IPv4 literal fails the alpha-TLD
  // test, but an IPv6 literal or a bare `0x`-style host might not).
  if (isIP(h) !== 0) throw new Error('host is an IP literal');
  if (!isPublicLogoDomain(h)) throw new Error('host is not a public logo domain');
  const resolved = await lookup(h, { all: true });
  if (resolved.length === 0) throw new Error('host did not resolve');
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) {
      throw new Error('host resolves to a private address');
    }
  }
}

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
const TIMEOUT_MS = 8000;
// A validated logo fetch follows at most this many redirects, re-validating the
// destination host on every hop. Bounds redirect loops and keeps the favicon
// resolution snappy.
const MAX_REDIRECTS = 5;

/**
 * Fetches `url` with redirects handled MANUALLY so every hop is re-validated:
 * the scheme must be https, and the (possibly redirected) host must pass
 * `assertPublicHost` — resolved-IP check included — before a single byte is
 * read. This is the redirect-bypass half of the SSRF fix (M7/M8): a validated
 * public domain that 30x-redirects to `169.254.169.254`/loopback/RFC-1918 is
 * caught at the hop instead of being followed blindly. Returns null on any
 * validation failure or network error (logo fetches are best-effort).
 */
async function safeFetch(url: string): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null; // unparseable
    }
    // Only https — rejects file:, data:, http:, ftp:, gopher:, etc.
    if (parsed.protocol !== 'https:') return null;
    try {
      await assertPublicHost(parsed.hostname);
    } catch {
      return null; // IP literal / non-public / private-resolving host
    }
    let res: Response;
    try {
      res = await fetch(current, {
        headers: UA,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    // Follow 3xx ourselves so the next iteration re-validates the new host.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      try {
        current = new URL(location, current).href; // resolve relative redirects
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  return null; // too many redirects
}

// Resolved logos, including misses (null), so a domain is fetched only once.
const memCache = new Map<string, CachedLogo | null>();
// In-flight web resolutions, so concurrent first-time requests for the same id
// share one fetch (and one disk write) instead of racing.
const inFlightWeb = new Map<string, Promise<CachedLogo | null>>();

function logosDir(dataDir: string): string {
  const dir = join(dataDir, 'logos');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Identifies an image by its magic bytes — content-type headers often lie. */
function sniffType(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return 'image/x-icon';
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    return 'image/webp';
  }
  const head = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  return null;
}

async function fetchImage(url: string): Promise<CachedLogo | null> {
  // safeFetch re-validates the (https, public, non-private-resolving) host on
  // every redirect hop, so a favicon href can never be used to reach an
  // internal address (M7).
  const res = await safeFetch(url);
  if (!res || !res.ok) return null;
  try {
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < 64) return null; // blank / tracking-pixel junk
    const contentType = sniffType(body);
    if (!contentType) return null;
    return { contentType, body };
  } catch {
    return null;
  }
}

/** Fetches an institution's homepage and pulls its favicon out of the markup. */
async function resolveFromWeb(domain: string): Promise<CachedLogo | null> {
  for (const host of [`https://www.${domain}`, `https://${domain}`]) {
    try {
      // safeFetch validates the host (https + public + non-private resolution)
      // and re-validates every redirect hop, so the homepage fetch can't be
      // rebounded to an internal address (M7/M8).
      const res = await safeFetch(`${host}/`);
      if (!res || !res.ok) continue;
      const base = res.url || `${host}/`;
      const html = await res.text();

      // Prefer declared <link rel="...icon...">, largest first (apple-touch
      // icons tend to be high-resolution); always try /favicon.ico last.
      const candidates: string[] = [];
      for (const tag of html.match(/<link[^>]+>/gi) ?? []) {
        if (!/rel=["'][^"']*icon/i.test(tag)) continue;
        const href = tag.match(/href=["']([^"']+)["']/i);
        if (href) {
          try {
            candidates.push(new URL(href[1], base).href);
          } catch {
            // ignore unparseable href
          }
        }
      }
      candidates.push(new URL('/favicon.ico', base).href);

      // Every candidate is re-validated inside fetchImage/safeFetch (https-only,
      // public host, non-private resolved IP), so an absolute href to an
      // arbitrary host/scheme is rejected rather than fetched verbatim (M7).
      for (const url of candidates) {
        const img = await fetchImage(url);
        if (img) return img;
      }
    } catch {
      // try the next host candidate
    }
  }
  return null;
}

/**
 * Returns the institution's logo, fetching it from the institution's website
 * on first use and caching it in `<dataDir>/logos/` thereafter.
 */
export async function getLogo(
  dataDir: string,
  companyId: string,
  domain: string,
): Promise<CachedLogo | null> {
  // Fail closed: never let an unvalidated id reach the filesystem path below.
  if (!isSafeCompanyId(companyId)) return null;

  if (memCache.has(companyId)) return memCache.get(companyId) ?? null;

  const dir = logosDir(dataDir);
  const imgPath = join(dir, `${companyId}.img`);
  const typePath = join(dir, `${companyId}.type`);
  if (existsSync(imgPath) && existsSync(typePath)) {
    const logo = {
      contentType: readFileSync(typePath, 'utf8'),
      body: readFileSync(imgPath),
    };
    memCache.set(companyId, logo);
    return logo;
  }

  const existing = inFlightWeb.get(companyId);
  if (existing) return existing;
  const fetchPromise = (async () => {
    const logo = await resolveFromWeb(domain);
    memCache.set(companyId, logo);
    // Only successes are cached to disk, so a failed fetch is retried next launch.
    if (logo) {
      writeFileSync(imgPath, logo.body);
      writeFileSync(typePath, logo.contentType);
    }
    return logo;
  })();
  inFlightWeb.set(companyId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightWeb.delete(companyId);
  }
}
