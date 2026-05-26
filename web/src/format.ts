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
  const abs = Math.abs(amount);
  const fractional = Math.round(abs * 100) % 100 !== 0;
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: fractional ? 2 : 0,
    maximumFractionDigits: fractional ? 2 : 0,
  });
  const symbol = SYMBOLS[currency] || currency + ' ';
  const sign = amount < 0 ? '−' : '';
  return `${sign}${symbol}${formatted}`;
}
