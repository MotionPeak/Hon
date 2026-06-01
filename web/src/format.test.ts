import { describe, expect, it } from 'vitest';
import { moneyShort } from './format';

describe('moneyShort', () => {
  it('does not render a misleading "−₪0" for tiny negatives that round to 0', () => {
    expect(moneyShort(-0.3)).toBe('₪0');
    expect(moneyShort(-0.49)).toBe('₪0');
    expect(moneyShort(0)).toBe('₪0');
  });

  it('keeps the minus sign once the rounded magnitude is non-zero', () => {
    expect(moneyShort(-0.6)).toBe('−₪1');
    expect(moneyShort(-12)).toBe('−₪12');
  });

  it('rounds sub-1k values to whole units', () => {
    expect(moneyShort(840)).toBe('₪840');
    expect(moneyShort(12.4)).toBe('₪12');
  });

  it('compacts thousands with one decimal under 10k and none at/above', () => {
    expect(moneyShort(1400)).toBe('₪1.4k');
    expect(moneyShort(23000)).toBe('₪23k');
    expect(moneyShort(-1500)).toBe('−₪1.5k');
  });

  it('honours the currency symbol', () => {
    expect(moneyShort(50, 'USD')).toBe('$50');
    expect(moneyShort(-25000, 'USD')).toBe('−$25k');
  });
});
