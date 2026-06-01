// Loans: Israeli-style amortization (Spitzer / לוח שפיצר), with rate sources
// for the prime-linked and CPI-linked tracks. The fetchers are best-effort —
// every loan can be computed off a cached rate or the user's manual override,
// so a network blip does not break the assets view.

import type { Repo, RateType } from './repo.js';

// Israel's prime rate is fixed at 1.5pp above the Bank of Israel base rate
// by convention; banks quote loan margins against prime, not against base.
export const PRIME_MARGIN_OVER_BOI = 1.5;

// Last-known sane defaults — only used when both the live fetch and the cache
// miss, so the loans view still shows a meaningful figure on first run.
const DEFAULT_BOI_BASE = 4.5;
const DEFAULT_PRIME = DEFAULT_BOI_BASE + PRIME_MARGIN_OVER_BOI; // 6.0
const DEFAULT_CPI = 100;

// Rate cache expiries. Prime moves a handful of times per year so a day is
// plenty; CPI updates monthly mid-month, so a week of caching is safe.
const PRIME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CPI_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PRIME_SERIES = 'boi-prime';
const CPI_SERIES = 'cbs-cpi';

export interface Loan {
  id: string;
  name: string;
  /** Original principal in `currency` (positive number). */
  principal: number;
  /** Loan-start date, YYYY-MM-DD. */
  startDate: string;
  termMonths: number;
  /** True for a prime+margin track — `rateValue` is the margin (can be negative). */
  isPrime: boolean;
  /** True if the principal is linked to the consumer price index (צמוד למדד). */
  isCpiLinked: boolean;
  /** Annual %: the fixed rate, or the margin over prime when isPrime is true. */
  rateValue: number;
  /** CPI value snapshotted at the loan's start date (so linkage is fixed). */
  cpiStart: number | null;
  currency: string;
  /** When true, the loan is left out of the net-worth total. */
  excluded: boolean;
  notes: string | null;
  /** Set when the loan was pulled from a bank scrape; null for hand-entered. */
  connectionId: string | null;
  /** Bank-side stable id when scraped (e.g. FIBI's "108-416"); null otherwise. */
  externalId: string | null;
  /**
   * True once the user has renamed the loan in Hon's UI; the next bank-loan
   * upsert will preserve `name` instead of clobbering it with the bank's
   * (often truncated) label. Always false for hand-entered loans.
   */
  nameOverridden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoanState {
  /** Months elapsed (fractional — partial months count). */
  monthsElapsed: number;
  monthsRemaining: number;
  /** The effective annual rate currently applied: rateValue, or prime+margin. */
  annualRate: number;
  /** This month's payment (in current shekels, CPI-linked when applicable). */
  monthlyPayment: number;
  /** Current outstanding, in current shekels (CPI-linked when applicable). */
  outstanding: number;
  /** Sum of payments made so far (approximation: monthlyPayment × monthsElapsed). */
  totalPaid: number;
  /** 0..1, how far through the term. */
  progress: number;
  /** CPI ratio current/start, when the loan is linked; else 1. */
  cpiRatio: number;
}

// --- Spitzer amortization ---------------------------------------------------
// The standard Israeli equal-payment schedule: each month pays the same
// nominal amount, split between interest (on the remaining principal) and
// principal. M = P·r·(1+r)^n / ((1+r)^n − 1).

function monthlyPayment(principal: number, monthlyRate: number, n: number): number {
  if (n <= 0 || principal <= 0) return 0;
  if (monthlyRate === 0) return principal / n;
  const factor = Math.pow(1 + monthlyRate, n);
  return (principal * monthlyRate * factor) / (factor - 1);
}

function balanceAfter(
  principal: number,
  monthlyRate: number,
  n: number,
  k: number,
): number {
  if (k <= 0) return principal;
  if (k >= n) return 0;
  if (monthlyRate === 0) return principal * (1 - k / n);
  const factor = Math.pow(1 + monthlyRate, k);
  const M = monthlyPayment(principal, monthlyRate, n);
  return Math.max(0, principal * factor - (M * (factor - 1)) / monthlyRate);
}

// Months between two ISO dates, counting partial months as a fraction of 30
// days. Cheap and good enough for a balance estimate — banks round to the
// next billing day, which is itself within ±a few days for any given loan.
function monthsBetween(fromIso: string, toIso: string): number {
  // Parse YYYY-MM-DD components directly. `new Date(iso)` parses as UTC midnight
  // but the getters read local time, so in a negative-UTC zone the day could
  // shift — drifting monthsElapsed by ~1/30 right at a billing boundary.
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(fromIso);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(toIso);
  if (!a || !b) return 0;
  const years = Number(b[1]) - Number(a[1]);
  const months = Number(b[2]) - Number(a[2]);
  const days = Number(b[3]) - Number(a[3]);
  return Math.max(0, years * 12 + months + days / 30);
}

/**
 * Computes the current state of a loan: outstanding balance, monthly payment,
 * progress, and so on. Pulls live rates for prime / linked loans; a missing
 * rate falls back to a default so the figure stays sensible.
 */
export function computeLoanState(
  loan: Loan,
  prime: number,
  cpiNow: number | null,
): LoanState {
  const today = new Date().toISOString().slice(0, 10);
  const monthsElapsedRaw = monthsBetween(loan.startDate, today);
  const monthsElapsed = Math.min(loan.termMonths, monthsElapsedRaw);
  const monthsRemaining = Math.max(0, loan.termMonths - monthsElapsed);
  const annualRate = loan.isPrime ? prime + loan.rateValue : loan.rateValue;
  const monthlyRate = annualRate / 100 / 12;

  // Nominal Spitzer figures (the loan in its own start-day shekels).
  const nominalPayment = monthlyPayment(loan.principal, monthlyRate, loan.termMonths);
  const nominalBalance = balanceAfter(
    loan.principal,
    monthlyRate,
    loan.termMonths,
    monthsElapsed,
  );

  // For CPI-linked tracks both the outstanding principal and the monthly
  // payment scale up with the index. ratio = 1 when not linked or unknown.
  const cpiRatio =
    loan.isCpiLinked && loan.cpiStart && cpiNow && loan.cpiStart > 0
      ? cpiNow / loan.cpiStart
      : 1;

  const outstanding = nominalBalance * cpiRatio;
  const payment = nominalPayment * cpiRatio;
  const progress = loan.termMonths === 0 ? 1 : monthsElapsed / loan.termMonths;

  return {
    monthsElapsed,
    monthsRemaining,
    annualRate,
    monthlyPayment: payment,
    outstanding,
    totalPaid: payment * monthsElapsed,
    progress,
    cpiRatio,
  };
}

// --- Rate fetchers ----------------------------------------------------------
// Both Israeli sources publish public JSON APIs but their endpoints have
// shifted over the years; the fetchers below try the documented URL, fall
// back to the cached value, and finally to a sensible constant. Caching is
// in `rate_cache` (keyed by series + period), so repeated UI hits do not
// flood the upstream.

interface RatesPort {
  getCachedRate(series: string, period: string): { value: number; fetchedAt: string } | undefined;
  cacheRate(series: string, period: string, value: number): void;
}

async function safeFetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Current Israeli prime rate (= BOI base + 1.5pp). Tries the Bank of Israel
 * public API for the latest base rate; if that fails, returns the most
 * recent cached value (regardless of TTL), and only as a last resort the
 * built-in default. The returned rate is annual percent (e.g. 6.0).
 */
export async function fetchCurrentPrime(repo: RatesPort): Promise<number> {
  const period = 'current';
  const cached = repo.getCachedRate(PRIME_SERIES, period);
  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
    if (ageMs < PRIME_CACHE_TTL_MS) return cached.value;
  }

  // BOI's public-data endpoint for the current monetary rate. The shape has
  // shifted between revisions, so we accept any field that parses as a number.
  const raw = await safeFetchJson('https://boi.org.il/PublicApi/GetInterest');
  const base = pickNumber(raw, [
    'currentInterest',
    'interestRate',
    'rate',
    'value',
    'CurrentInterest',
  ]);
  if (base != null && Number.isFinite(base) && base > 0 && base < 30) {
    const prime = base + PRIME_MARGIN_OVER_BOI;
    repo.cacheRate(PRIME_SERIES, period, prime);
    return prime;
  }

  if (cached) return cached.value; // stale-but-cached beats a hardcoded number
  return DEFAULT_PRIME;
}

/**
 * CBS general consumer price index for a given YYYY-MM. The CBS calculator
 * API returns the index value for a date; we cache once per month. The
 * fallback chain is identical to the prime fetcher.
 */
export async function fetchCpiForMonth(repo: RatesPort, yyyyMm: string): Promise<number> {
  const cached = repo.getCachedRate(CPI_SERIES, yyyyMm);
  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
    if (ageMs < CPI_CACHE_TTL_MS) return cached.value;
  }

  // The CBS Index API exposes a series-data endpoint for the general CPI
  // (series id 120010). The response is `{ DataSet: { Series: [{ obs: [...] }] } }`
  // or similar — we walk it tolerantly so a schema tweak does not break us.
  const url =
    `https://api.cbs.gov.il/index/data/price?id=120010&format=json` +
    `&startPeriod=${yyyyMm}&endPeriod=${yyyyMm}`;
  const raw = await safeFetchJson(url);
  const value = extractCpiValue(raw);
  if (value != null && Number.isFinite(value) && value > 0) {
    repo.cacheRate(CPI_SERIES, yyyyMm, value);
    return value;
  }

  if (cached) return cached.value;
  // Without any signal, default to 100 — the CPI ratio collapses to 1 and the
  // loan is treated as nominal until the user supplies a real value or a
  // future fetch succeeds.
  return DEFAULT_CPI;
}

/** A loan's CPI ratio (current/start), with `start` captured at creation. */
export async function cpiRatioForLoan(
  repo: RatesPort,
  loan: Pick<Loan, 'isCpiLinked' | 'startDate' | 'cpiStart'>,
): Promise<number> {
  if (!loan.isCpiLinked) return 1;
  if (!loan.cpiStart || loan.cpiStart <= 0) return 1;
  const cpiNow = await fetchCpiForMonth(repo, currentYyyyMm());
  if (!cpiNow) return 1;
  return cpiNow / loan.cpiStart;
}

export function currentYyyyMm(): string {
  return new Date().toISOString().slice(0, 7);
}

// Walks an unknown JSON tree and returns the first numeric field whose key
// matches one of `keys`. Tolerant of the BOI's evolving response shapes.
function pickNumber(value: unknown, keys: string[]): number | null {
  if (value == null || typeof value !== 'object') return null;
  const seen = new Set<unknown>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (keys.includes(k)) {
        const n = typeof v === 'string' ? parseFloat(v) : (v as number);
        if (Number.isFinite(n)) return n as number;
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

// Pulls the most recent value out of a CBS-style price-index response. The
// response wraps observations differently across the catalog endpoints; we
// walk for the first array of `{ date, value }`-shaped items, or for an
// `IndexValue`-style field at any depth.
function extractCpiValue(raw: unknown): number | null {
  if (raw == null || typeof raw !== 'object') return null;
  const stack: unknown[] = [raw];
  const seen = new Set<unknown>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    // Common keys CBS has used: currIndex, value, IndexValue, indexValue, price.
    for (const k of ['currIndex', 'IndexValue', 'indexValue', 'value', 'price']) {
      const v = rec[k];
      const n = typeof v === 'string' ? parseFloat(v) : (v as number);
      if (Number.isFinite(n) && n > 0) return n as number;
    }
    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

// Convenience for the server route layer: validates a partial loan body, then
// hands it to repo. `rateType` is the string the UI uses ('fixed' | 'prime' |
// 'cpi-fixed' | 'cpi-prime'); decomposes it into the two flags the DB stores.
export function decomposeRateType(rateType: RateType): {
  isPrime: boolean;
  isCpiLinked: boolean;
} {
  return {
    isPrime: rateType === 'prime' || rateType === 'cpi-prime',
    isCpiLinked: rateType === 'cpi-fixed' || rateType === 'cpi-prime',
  };
}

export function composeRateType(loan: Pick<Loan, 'isPrime' | 'isCpiLinked'>): RateType {
  if (loan.isCpiLinked) return loan.isPrime ? 'cpi-prime' : 'cpi-fixed';
  return loan.isPrime ? 'prime' : 'fixed';
}
