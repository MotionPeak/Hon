// Recurring-bill helpers. Lifted from sidecar/public/app.html so both the
// Recurring (Fixed bills) and Subscriptions tabs can share the same merchant-
// detection logic. The engine's budget endpoint computes the same things
// server-side, but the rich per-merchant view is client-only — the engine
// only returns aggregated totals.

import { cycleKey, currentCycleKey } from '../cycle';
import type { Category } from '../settings/CategoriesPanel';
import type { Transaction } from '../activity/types';

export type Frequency = 'monthly' | 'bimonthly' | 'yearly';

/** Divisor that turns one charge into a monthly equivalent. */
export const RECURRENCE_DIV: Record<Frequency, number> = {
  monthly: 1, bimonthly: 2, yearly: 12,
};

/** How long since the last charge counts as "still active" — a yearly bill
 *  lapses far slower than a monthly one. */
export const RECURRENCE_ACTIVE_DAYS: Record<Frequency, number> = {
  monthly: 40, bimonthly: 75, yearly: 400,
};

function merchantWords(description: string): string[] {
  return (description || '').split(/\s+/).filter((w) => w && !/\d/.test(w));
}

/** Stable identity for a merchant: the description with digit-bearing words
 *  dropped (scrapers append varying per-charge codes that would otherwise
 *  split one merchant into N). Lowercased so case differences don't matter.
 *  Falls back to the raw description when every word contains a digit. */
export function merchantKey(description: string): string {
  return merchantWords(description).join(' ').toLowerCase() || (description || '');
}

/** Display name for a merchant: same word-strip as the key, but preserves
 *  the original casing of the words that survived. */
export function merchantName(description: string): string {
  const words = merchantWords(description);
  return words.length ? words.join(' ') : description;
}

/** A charge of `amount` billing at `freq` becomes this much per month. */
export function monthlyEquivalent(amount: number, freq: Frequency): number {
  return amount / RECURRENCE_DIV[freq];
}

/** The frequency choices the transaction editor offers for a given category —
 *  null when the category is not a recurring bill. Mirrors the legacy SPA's
 *  recurrenceChoices(): Subscriptions → monthly|yearly, any fixed-group
 *  category → monthly|bimonthly. */
export function recurrenceChoices(
  cat: { name: string; catGroup: string } | null | undefined,
): Array<readonly [Frequency, string]> | null {
  if (!cat) return null;
  if (cat.name === 'Subscriptions') {
    return [['monthly', 'Monthly'], ['yearly', 'Yearly']];
  }
  if (cat.catGroup === 'fixed') {
    return [['monthly', 'Monthly'], ['bimonthly', 'Bimonthly']];
  }
  return null;
}

export type FreqOrIgnore = Frequency | 'ignore';

export interface MerchantRow {
  key: string;
  desc: string;
  category: string;
  count: number;
  freq: Frequency;
  cycles: Set<string>;
  lastTxnDate: string | null;
  lastChargeAbs: number;
  monthly: number;
  /** Split divisor — share among N people for the category. */
  split: number;
  /** This user's share of the monthly equivalent. */
  monthlyShare: number;
  /** This cycle's full per-charge amount for the user — the share override if
   *  set, else lastChargeAbs / split. Used by the due-this-cycle totals and the
   *  bank projection. */
  cycleCharge: number;
}

export interface RecurringData {
  transactions: Transaction[];
  categories: Category[];
  frequencies: Record<string, FreqOrIgnore>;
  splits: Record<string, number>;
  /** Absolute "my share" override per category (overrides the ÷split divisor). */
  shareAmounts: Record<string, number>;
  cancelled: Record<string, string>;
}

/** The synthetic merchant key every loan-repayment line collapses into. */
export const LOAN_GROUP_KEY = '__loan__';
const LOAN_GROUP_DESC = 'Loan';

/** True when a charge's description names a loan (Hebrew הלוואה / הלואה). Banks
 *  post one instalment as separate principal / interest / fee lines that all
 *  carry this word, so detectMerchants merges them into a single row. */
function isLoanCharge(description: string): boolean {
  return /הלוואה|הלואה/.test(description || '');
}

/**
 * Groups fixed-category ILS charges by merchant and classifies each as a
 * monthly/bimonthly/yearly recurring bill. A user-set frequency wins; otherwise
 * a merchant needs to appear in ≥2 calendar cycles to count. Returns the rows
 * plus the category→group map so callers can reuse the lookup.
 */
export function detectMerchants(
  data: RecurringData, monthStartDay: number,
): { rows: MerchantRow[]; categoryGroups: Record<string, Category['catGroup']> } {
  const catGroupByName: Record<string, Category['catGroup']> = {};
  for (const c of data.categories) catGroupByName[c.name] = c.catGroup;
  const merch = new Map<string, {
    key: string; desc: string; category: string; count: number;
    cycles: Set<string>; lastTxnDate: string | null; lastTs: number;
    lastChargeAbs: number;
  }>();
  // Loan lines (principal / interest / fee) collapse into one group, summed PER
  // CYCLE so the row reflects the full instalment — not just one component.
  const loanByCycle = new Map<string, number>();
  let loanCount = 0;
  let loanLastDate: string | null = null;
  let loanLastTs = 0;
  let loanFixedCat: string | null = null;
  let loanFixedCatTs = -1;
  let loanAnyCat: string | null = null;
  for (const t of data.transactions) {
    if (t.currency !== 'ILS') continue;
    if (t.refundForId) continue;
    if (t.amount >= 0) continue;
    const ts = new Date(t.date).getTime();
    if (isLoanCharge(t.description)) {
      // Bypass the category filter: a loan repayment counts even when the bank
      // left the principal/interest lines uncategorised or in a non-fixed group.
      const cyc = cycleKey(t.date, monthStartDay);
      loanByCycle.set(cyc, (loanByCycle.get(cyc) ?? 0) + -t.amount);
      loanCount += 1;
      if (ts >= loanLastTs) { loanLastTs = ts; loanLastDate = t.date; }
      // File the merged row under the most recent fixed category seen (e.g. the
      // Fees line), so it lands in a real Fixed-bills section.
      if (t.category && catGroupByName[t.category] === 'fixed' && ts >= loanFixedCatTs) {
        loanFixedCatTs = ts; loanFixedCat = t.category;
      } else if (t.category && !loanAnyCat) {
        loanAnyCat = t.category;
      }
      continue;
    }
    if (!t.category) continue;
    if (catGroupByName[t.category] !== 'fixed') continue;
    const key = merchantKey(t.description);
    let r = merch.get(key);
    if (!r) {
      r = {
        key, desc: merchantName(t.description), category: t.category,
        count: 0, cycles: new Set(), lastTxnDate: null, lastTs: 0, lastChargeAbs: 0,
      };
      merch.set(key, r);
    }
    r.cycles.add(cycleKey(t.date, monthStartDay));
    r.count += 1;
    if (ts >= r.lastTs) {
      r.lastTs = ts;
      r.lastTxnDate = t.date;
      r.lastChargeAbs = -t.amount;
      r.desc = merchantName(t.description);
      r.category = t.category;
    }
  }
  const rows: MerchantRow[] = [];
  // Build a row, applying the same recurrence gate + split/share math whether it
  // came from a single merchant or the merged loan group.
  const pushRow = (
    key: string, desc: string, category: string, count: number,
    cycles: Set<string>, lastTxnDate: string | null, lastChargeAbs: number,
  ): void => {
    const userFreq = data.frequencies[key];
    if (userFreq === 'ignore') return;
    if (data.cancelled[key]) return;
    if (!userFreq && cycles.size < 2) return;
    const freq: Frequency =
      userFreq === 'monthly' || userFreq === 'bimonthly' || userFreq === 'yearly'
        ? userFreq : 'monthly';
    const split = data.splits[category] || 1;
    const override = data.shareAmounts?.[category];
    const fullMonthly = monthlyEquivalent(lastChargeAbs, freq);
    // The override is the user's share of EACH charge (e.g. rent ₪2,250).
    // It supersedes the split divisor — when both are set, the override wins.
    const cycleCharge = override != null ? override : lastChargeAbs / split;
    const monthlyShare = override != null ? override / RECURRENCE_DIV[freq] : fullMonthly / split;
    rows.push({
      key, desc, category, count, freq, cycles, lastTxnDate, lastChargeAbs,
      monthly: fullMonthly, split, monthlyShare, cycleCharge,
    });
  };
  for (const r of merch.values()) {
    pushRow(r.key, r.desc, r.category, r.count, r.cycles, r.lastTxnDate, r.lastChargeAbs);
  }
  if (loanByCycle.size > 0 && loanLastDate) {
    // The latest cycle's summed instalment is "this month's" loan cost.
    const latestSum = loanByCycle.get(cycleKey(loanLastDate, monthStartDay)) ?? 0;
    const loanCat = loanFixedCat ?? loanAnyCat ?? 'Fees';
    pushRow(
      LOAN_GROUP_KEY, LOAN_GROUP_DESC, loanCat, loanCount,
      new Set(loanByCycle.keys()), loanLastDate, latestSum,
    );
  }
  return { rows, categoryGroups: catGroupByName };
}

/** Whole calendar months from `from` to `to` (both "YYYY-MM"). */
export function cyclesBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * Whether a recurring row is expected to bill in the current cycle. Shared by
 * RecurringView's statusFor() badge and expectedFixedThisCycle() so the per-row
 * "Off-cycle" badges and the Overview headline can never disagree.
 *  - 'billed'    — a charge already landed in the current cycle.
 *  - 'off-cycle' — bimonthly billed last cycle, or yearly between charges.
 *  - 'due'       — expected this cycle, not yet seen.
 */
export function cycleStatus(
  row: MerchantRow, monthStartDay: number,
): 'billed' | 'off-cycle' | 'due' {
  const cur = currentCycleKey(monthStartDay);
  if (row.cycles.has(cur)) return 'billed';
  const lastCycle = row.lastTxnDate ? cycleKey(row.lastTxnDate, monthStartDay) : null;
  const gap = lastCycle ? cyclesBetween(lastCycle, cur) : 999;
  if (row.freq === 'bimonthly' && gap === 1) return 'off-cycle';
  if (row.freq === 'yearly' && gap >= 1 && gap < 12) return 'off-cycle';
  return 'due';
}

/**
 * Sum of the full per-row charges due this cycle. A bill counts at its full
 * `cycleCharge` the cycle it is due (billed or expected) and ₪0 when
 * off-cycle — mirroring cycleStatus(). This is the same "due this cycle" total
 * the Fixed bills tab shows, NOT the smoothed monthly-equivalent.
 */
export function expectedFixedThisCycle(rows: MerchantRow[], monthStartDay: number): number {
  let total = 0;
  for (const row of rows) {
    if (cycleStatus(row, monthStartDay) !== 'off-cycle') {
      total += row.cycleCharge;
    }
  }
  return total;
}

/**
 * Sum of fixed bills EXPECTED this cycle that have not yet posted (status
 * 'due'). Feeds the bank projection: these are commitments still to clear the
 * bank — distinct from billed bills (already in bankNow or on the card bill).
 */
export function fixedDueNotYetPosted(rows: MerchantRow[], monthStartDay: number): number {
  let total = 0;
  for (const row of rows) {
    if (cycleStatus(row, monthStartDay) === 'due') {
      total += row.cycleCharge;
    }
  }
  return total;
}
