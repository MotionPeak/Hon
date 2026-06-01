// Currency conversion to ILS using the free Frankfurter API. Rates are cached
// in-process for several hours; callers fall back to ILS-only totals when the
// network is unavailable.

interface CachedRates {
  fetchedAt: number;
  ilsPerUnit: Record<string, number>;
}

const TTL_MS = 6 * 60 * 60 * 1000;
let cache: CachedRates | null = null;

// In-flight fetch dedup (H-9): when several callers ask for rates before the
// first network request resolves, they all await this single promise instead
// of each firing their own fetch (wasteful + races the cache write). Cleared
// in `finally` so a failed fetch doesn't pin a rejected promise forever.
let inflight: Promise<Record<string, number>> | null = null;

function normalizeCurrency(currency: string): string {
  const code = currency.toUpperCase();
  return code === 'NIS' ? 'ILS' : code;
}

async function loadRates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.ilsPerUnit;

  // A request is already on the wire — share it rather than racing a second.
  if (inflight) return inflight;

  inflight = (async () => {
    // Frankfurter migrated api.frankfurter.app → api.frankfurter.dev/v1 in
    // 2026; the old host now only 301-redirects. Hit the canonical endpoint
    // directly so FX doesn't silently die if that redirect ever stops. Same
    // response shape: { rates: { <code>: <units per 1 base> } }.
    // Bound the socket: without a timeout a stalled Frankfurter hangs the
    // inline-awaited /summary and /brokerage routes instead of degrading. The
    // catch below already maps a rejection (abort included) to a null fallback.
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=ILS', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
    const data = (await res.json()) as { rates: Record<string, number> };

    // data.rates[X] = units of X per 1 ILS — invert to get ILS per 1 unit of X.
    const ilsPerUnit: Record<string, number> = { ILS: 1 };
    for (const [code, perIls] of Object.entries(data.rates)) {
      if (perIls > 0) ilsPerUnit[code] = 1 / perIls;
    }
    cache = { fetchedAt: Date.now(), ilsPerUnit };
    return ilsPerUnit;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Test-only: clears the in-process rate cache and any in-flight fetch so each
 * test starts cold. Not referenced by production code paths.
 */
export function __resetFxCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Returns the current ILS-per-unit rate map (cache or fresh). Returns null
 * when the network is unavailable so callers can fall back to native-currency
 * totals. The web app uses this to convert brokerage holdings and equity
 * series to ILS without hard-coding rates.
 */
export async function getIlsRates(): Promise<Record<string, number> | null> {
  try {
    return await loadRates();
  } catch {
    return null;
  }
}

export { normalizeCurrency };

/**
 * Sums per-currency totals into a single ILS figure. Returns null when a rate
 * for a non-ILS currency is unavailable, so the caller can fall back cleanly.
 */
export async function totalInILS(
  byCurrency: { currency: string; total: number }[],
): Promise<number | null> {
  if (byCurrency.length === 0) return 0;

  let rates: Record<string, number>;
  try {
    rates = await loadRates();
  } catch {
    return null;
  }

  let sum = 0;
  for (const { currency, total } of byCurrency) {
    // Some brokerages report sub-unit codes (GBp/GBX = UK pence, ZAc = SA
    // cents). Frankfurter only quotes the major unit, so convert to it before
    // lookup — otherwise a perfectly convertible GBP holding would read as an
    // unknown currency and null out the entire portfolio sum.
    const sub = SUBUNIT_CURRENCIES[currency];
    const code = sub ? sub.major : currency;
    const amount = sub ? total * sub.factor : total;
    const rate = rates[normalizeCurrency(code)];
    if (rate == null) return null;
    sum += amount * rate;
  }
  return sum;
}

/** Sub-unit currency codes mapped to their major unit + conversion factor.
 *  Case-sensitive (GBp ≠ GBP), so this must run before any upper-casing. */
const SUBUNIT_CURRENCIES: Record<string, { major: string; factor: number }> = {
  GBp: { major: 'GBP', factor: 0.01 },
  GBX: { major: 'GBP', factor: 0.01 },
  ZAc: { major: 'ZAR', factor: 0.01 },
  ILA: { major: 'ILS', factor: 0.01 },
};
