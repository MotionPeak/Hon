import { describe, expect, it } from 'vitest';
import { isFeatureDisabled, normalizePosition, normalizeSnapTradeAccount } from '../src/snaptrade.js';
import type { Account, Position } from 'snaptrade-typescript-sdk';
import type { NormalizedHolding } from '../src/scrapers.js';

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

/** Build a NormalizedHolding fixture (a priced AAPL position in USD by default). */
function makeHolding(over: Partial<NormalizedHolding> = {}): NormalizedHolding {
  return { symbol: 'AAPL', units: 10, price: 100, currency: 'USD', ...over };
}

/**
 * Build a minimal SnapTrade Account fixture. `noBalanceTotal: true` drops
 * balance.total entirely (the brokerage-doesn't-report-a-total case); otherwise
 * amount/currency default to 1000/USD. Uses `in` checks so an explicit `null`
 * or `''` override is honoured rather than replaced by the default.
 */
function makeAccount(opts: {
  id?: string; number?: string; name?: string | null; institution_name?: string;
  amount?: number | null; currency?: string | null; noBalanceTotal?: boolean;
} = {}): Account {
  const total = opts.noBalanceTotal
    ? undefined
    : {
        amount: 'amount' in opts ? opts.amount : 1000,
        currency: 'currency' in opts ? opts.currency : 'USD',
      };
  return {
    id: opts.id ?? 'acc-uuid-1',
    number: 'number' in opts ? opts.number : '999-12345',
    name: 'name' in opts ? opts.name : 'Margin',
    institution_name: 'institution_name' in opts ? opts.institution_name : 'Interactive Brokers',
    balance: { total },
  } as unknown as Account;
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

// normalizeSnapTradeAccount is the pure heart of the per-account map in
// runSnapTradeSync: given a SnapTrade Account + its already-fetched holdings, it
// produces a NormalizedAccount. These cases pin the balance-derivation logic
// exactly — reported total wins, otherwise a single-currency priced sum is
// derived (0/negative kept), and a reported 0 is never overridden.
describe('normalizeSnapTradeAccount', () => {
  it('uses the brokerage-reported total balance and currency directly', () => {
    const result = normalizeSnapTradeAccount(makeAccount({ amount: 1234.5, currency: 'USD' }), [], undefined);
    expect(result.balance).toBe(1234.5);
    expect(result.currency).toBe('USD');
    expect(result.transactions).toEqual([]);
  });

  it('maps accountNumber, label, holdings and inceptionDate through', () => {
    const holdings = [makeHolding()];
    const acct = makeAccount({ number: '111-222', name: 'Roth', institution_name: 'Wealthsimple' });
    const result = normalizeSnapTradeAccount(acct, holdings, '2021-03-01');
    expect(result.accountNumber).toBe('111-222');
    expect(result.label).toBe('Wealthsimple · Roth');
    expect(result.holdings).toBe(holdings);
    expect(result.inceptionDate).toBe('2021-03-01');
  });

  it('falls back to the account id when the number is empty', () => {
    const acct = makeAccount({ number: '', id: 'uuid-xyz' });
    expect(normalizeSnapTradeAccount(acct, [], undefined).accountNumber).toBe('uuid-xyz');
  });

  it('labels with name-only, institution-only, or a default when fields are missing', () => {
    expect(normalizeSnapTradeAccount(makeAccount({ name: 'Solo', institution_name: '' }), [], undefined).label)
      .toBe('Solo');
    expect(normalizeSnapTradeAccount(makeAccount({ name: null, institution_name: 'IBKR' }), [], undefined).label)
      .toBe('IBKR');
    expect(normalizeSnapTradeAccount(makeAccount({ name: null, institution_name: '' }), [], undefined).label)
      .toBe('Brokerage account');
  });

  it('derives a balance from single-currency priced holdings when no total is reported', () => {
    const holdings = [
      makeHolding({ units: 10, price: 100, currency: 'USD' }),
      makeHolding({ units: 5, price: 20, currency: 'USD' }),
    ];
    const result = normalizeSnapTradeAccount(makeAccount({ noBalanceTotal: true }), holdings, undefined);
    expect(result.balance).toBe(1100);
    expect(result.currency).toBe('USD');
  });

  it('does not derive a balance when holdings span multiple currencies', () => {
    const holdings = [makeHolding({ currency: 'USD' }), makeHolding({ currency: 'EUR' })];
    const result = normalizeSnapTradeAccount(makeAccount({ noBalanceTotal: true }), holdings, undefined);
    expect(result.balance).toBeUndefined();
    expect(result.currency).toBe('USD');
  });

  it('does not derive a balance when no position is priced', () => {
    const holdings = [makeHolding({ price: undefined }), makeHolding({ price: undefined })];
    const result = normalizeSnapTradeAccount(makeAccount({ noBalanceTotal: true }), holdings, undefined);
    expect(result.balance).toBeUndefined();
  });

  it('keeps a derived balance of 0 or negative (fully closed / net short / margin debit)', () => {
    const zero = [makeHolding({ units: 0, price: 100, currency: 'USD' })];
    expect(normalizeSnapTradeAccount(makeAccount({ noBalanceTotal: true }), zero, undefined).balance).toBe(0);
    const short = [makeHolding({ units: -10, price: 5, currency: 'USD' })];
    expect(normalizeSnapTradeAccount(makeAccount({ noBalanceTotal: true }), short, undefined).balance).toBe(-50);
  });

  it('treats a reported balance of 0 as real and does not derive over it', () => {
    const holdings = [makeHolding({ units: 10, price: 100, currency: 'USD' })]; // would derive 1000
    const result = normalizeSnapTradeAccount(makeAccount({ amount: 0, currency: 'USD' }), holdings, undefined);
    expect(result.balance).toBe(0);
  });

  it('treats a null total amount as missing and derives instead', () => {
    const holdings = [makeHolding({ units: 2, price: 50, currency: 'USD' })];
    expect(normalizeSnapTradeAccount(makeAccount({ amount: null }), holdings, undefined).balance).toBe(100);
  });

  it('uses the reported total currency when present', () => {
    expect(normalizeSnapTradeAccount(makeAccount({ amount: 500, currency: 'CAD' }), [], undefined).currency)
      .toBe('CAD');
  });
});
