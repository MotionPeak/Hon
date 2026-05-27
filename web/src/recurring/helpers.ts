// Recurring-bill helpers. Lifted from sidecar/public/app.html so both the
// Recurring (Fixed bills) and Subscriptions tabs can share the same merchant-
// detection logic. The engine's budget endpoint computes the same things
// server-side, but the rich per-merchant view is client-only — the engine
// only returns aggregated totals.

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
