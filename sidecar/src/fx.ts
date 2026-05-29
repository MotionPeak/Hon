// Currency conversion to ILS using the free Frankfurter API. Rates are cached
// in-process for several hours; callers fall back to ILS-only totals when the
// network is unavailable.

interface CachedRates {
  fetchedAt: number;
  ilsPerUnit: Record<string, number>;
}

const TTL_MS = 6 * 60 * 60 * 1000;
let cache: CachedRates | null = null;

function normalizeCurrency(currency: string): string {
  const code = currency.toUpperCase();
  return code === 'NIS' ? 'ILS' : code;
}

async function loadRates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.ilsPerUnit;

  // Frankfurter migrated api.frankfurter.app → api.frankfurter.dev/v1 in
  // 2026; the old host now only 301-redirects. Hit the canonical endpoint
  // directly so FX doesn't silently die if that redirect ever stops. Same
  // response shape: { rates: { <code>: <units per 1 base> } }.
  const res = await fetch('https://api.frankfurter.dev/v1/latest?base=ILS');
  if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
  const data = (await res.json()) as { rates: Record<string, number> };

  // data.rates[X] = units of X per 1 ILS — invert to get ILS per 1 unit of X.
  const ilsPerUnit: Record<string, number> = { ILS: 1 };
  for (const [code, perIls] of Object.entries(data.rates)) {
    if (perIls > 0) ilsPerUnit[code] = 1 / perIls;
  }
  cache = { fetchedAt: Date.now(), ilsPerUnit };
  return ilsPerUnit;
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
    const rate = rates[normalizeCurrency(currency)];
    if (rate == null) return null;
    sum += total * rate;
  }
  return sum;
}
