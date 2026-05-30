import { describe, expect, it } from 'vitest';
import { isFeatureDisabled, normalizePosition } from '../src/snaptrade.js';
import type { Position } from 'snaptrade-typescript-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid Position fixture. All optional SDK fields omitted. */
function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    symbol: {
      symbol: {
        symbol: 'AAPL',
        description: 'Apple Inc.',
        currency: { code: 'USD' },
      },
    } as Position['symbol'],
    units: 10,
    price: 180,
    currency: { code: 'USD' } as Position['currency'],
    average_purchase_price: 150,
    open_pnl: 300,
    cash_equivalent: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('normalizePosition', () => {
  it('maps a plain stock position correctly', () => {
    const result = normalizePosition(makePosition());
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('AAPL');
    expect(result!.description).toBe('Apple Inc.');
    expect(result!.units).toBe(10);
    expect(result!.price).toBe(180);
    expect(result!.currency).toBe('USD');
    expect(result!.costBasis).toBe(150);
    expect(result!.openPnl).toBe(300);
  });

  it('returns null when cash_equivalent is true (avoid double-counting cash balance)', () => {
    const result = normalizePosition(makePosition({ cash_equivalent: true }));
    expect(result).toBeNull();
  });

  it('passes through when cash_equivalent is false', () => {
    const result = normalizePosition(makePosition({ cash_equivalent: false }));
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('AAPL');
  });

  it('passes through when cash_equivalent is undefined', () => {
    const p = makePosition();
    delete (p as Partial<Position>).cash_equivalent;
    const result = normalizePosition(p);
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('AAPL');
  });

  it('passes through when cash_equivalent is null', () => {
    const result = normalizePosition(makePosition({ cash_equivalent: null }));
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('AAPL');
  });

  it('maps with null price (price becomes undefined, not a number)', () => {
    const result = normalizePosition(makePosition({ price: null }));
    expect(result).not.toBeNull();
    expect(result!.price).toBeUndefined();
  });

  it('maps with missing average_purchase_price (costBasis becomes undefined)', () => {
    const result = normalizePosition(makePosition({ average_purchase_price: null }));
    expect(result).not.toBeNull();
    expect(result!.costBasis).toBeUndefined();
  });

  it('maps with missing open_pnl (openPnl becomes undefined)', () => {
    const result = normalizePosition(makePosition({ open_pnl: null }));
    expect(result).not.toBeNull();
    expect(result!.openPnl).toBeUndefined();
  });

  it('returns null when units is null (position cannot be sized)', () => {
    const result = normalizePosition(makePosition({ units: null }));
    expect(result).toBeNull();
  });

  it('returns null when units is undefined (position cannot be sized)', () => {
    const p = makePosition();
    delete (p as Partial<Position>).units;
    const result = normalizePosition(p);
    expect(result).toBeNull();
  });

  it('falls back to fractional_units when units is null', () => {
    const result = normalizePosition(
      makePosition({ units: null, fractional_units: 0.5 }),
    );
    expect(result).not.toBeNull();
    expect(result!.units).toBe(0.5);
  });

  it('falls back to raw_symbol when symbol is missing', () => {
    const result = normalizePosition(
      makePosition({
        symbol: {
          symbol: {
            raw_symbol: 'AAPL.RAW',
            currency: { code: 'USD' },
          },
        } as Position['symbol'],
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('AAPL.RAW');
  });

  it('falls back to position-level currency when inner currency is absent', () => {
    const result = normalizePosition(
      makePosition({
        symbol: {
          symbol: {
            symbol: 'AAPL',
            // no currency on inner
          },
        } as Position['symbol'],
        currency: { code: 'ILS' } as Position['currency'],
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.currency).toBe('ILS');
  });

  it('defaults currency to USD when no currency info is present', () => {
    const result = normalizePosition(
      makePosition({
        symbol: {
          symbol: {
            symbol: 'AAPL',
          },
        } as Position['symbol'],
        currency: undefined,
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.currency).toBe('USD');
  });
});

describe('isFeatureDisabled', () => {
  it('is true for SnapTrade code 1141', () => {
    expect(isFeatureDisabled({ responseBody: { code: '1141', detail: 'x' } })).toBe(true);
  });
  it('is true when the detail mentions the feature is not enabled', () => {
    expect(isFeatureDisabled({ responseBody: JSON.stringify({
      detail: 'Feature is not enabled for this customer or this connection',
    }) })).toBe(true);
  });
  it('is false for other errors', () => {
    expect(isFeatureDisabled({ responseBody: { code: '1012', detail: 'nope' } })).toBe(false);
    expect(isFeatureDisabled(new Error('network'))).toBe(false);
  });
});
