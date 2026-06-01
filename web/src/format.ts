// Small formatting helpers, lifted (and trimmed) from sidecar/public/app.html.
// The old app's money() honours currency symbols and Israeli locale conventions.

const SYMBOLS: Record<string, string> = {
  ILS: '₪', USD: '$', EUR: '€', GBP: '£',
};

/**
 * Format a number as a currency amount with the appropriate symbol.
 * Uses 0 decimal places for whole numbers, 2 otherwise — matches the
 * old app's behaviour where balances round to the nearest unit unless
 * fractional precision is meaningful.
 */
export function money(amount: number | null | undefined, currency: string = 'ILS'): string {
  if (amount == null) return '—';
  // Derive sign + magnitude from the rounded value so a sub-cent residual that
  // rounds to 0 never renders as "−₪0".
  const rounded = Math.round(amount * 100) / 100;
  const abs = Math.abs(rounded);
  const fractional = Math.round(abs * 100) % 100 !== 0;
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: fractional ? 2 : 0,
    maximumFractionDigits: fractional ? 2 : 0,
  });
  const symbol = SYMBOLS[(currency || '').toUpperCase()] || currency + ' ';
  const sign = rounded < 0 ? '−' : '';
  return `${sign}${symbol}${formatted}`;
}

/**
 * Compact currency for tight spots like the donut centre: ₪12.3k, ₪840.
 * Amounts ≥ 10k drop the decimal (₪23k); 1k–10k keep one (₪1.4k); under 1k
 * round to whole units. Ported from the legacy SPA's `moneyShort`.
 */
export function moneyShort(value: number, currency: string = 'ILS'): string {
  const sym = SYMBOLS[(currency || '').toUpperCase()] || '';
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1000) return sign + sym + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + 'k';
  return sign + sym + Math.round(abs);
}
