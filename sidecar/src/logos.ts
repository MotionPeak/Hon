import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
const TIMEOUT_MS = 8000;

// Resolved logos, including misses (null), so a domain is fetched only once.
const memCache = new Map<string, CachedLogo | null>();

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
  try {
    const res = await fetch(url, {
      headers: UA,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
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
      const res = await fetch(`${host}/`, {
        headers: UA,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) continue;
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

  const logo = await resolveFromWeb(domain);
  memCache.set(companyId, logo);
  // Only successes are cached to disk, so a failed fetch is retried next launch.
  if (logo) {
    writeFileSync(imgPath, logo.body);
    writeFileSync(typePath, logo.contentType);
  }
  return logo;
}
