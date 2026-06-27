import { describe, expect, it } from 'vitest';
import {
  merchantKey, merchantName, monthlyEquivalent, type Frequency,
  expectedFixedThisCycle, type MerchantRow,
} from './helpers';
import { currentCycleKey, cycleKey } from '../cycle';

describe('merchantKey + merchantName', () => {
  it('drops digit-bearing words from the merchant key', () => {
    // The scraper often appends trailing numeric codes per charge — they
    // would otherwise make each charge look like a distinct merchant.
    expect(merchantKey('Shufersal 12345')).toBe('shufersal');
    expect(merchantName('Shufersal 12345')).toBe('Shufersal');
  });

  it('preserves order of non-digit words', () => {
    expect(merchantKey('Tel Aviv Light Rail')).toBe('tel aviv light rail');
    expect(merchantName('Tel Aviv Light Rail')).toBe('Tel Aviv Light Rail');
  });

  it('lowercases for the key but not the display name', () => {
    expect(merchantKey('NETFLIX')).toBe('netflix');
    expect(merchantName('NETFLIX')).toBe('NETFLIX');
  });

  it('falls back to the original description when only digits are present', () => {
    expect(merchantKey('1234')).toBe('1234');
    expect(merchantName('1234')).toBe('1234');
  });
});

describe('monthlyEquivalent', () => {
  it.each<[number, Frequency, number]>([
    [120, 'monthly',   120],
    [120, 'bimonthly', 60],
    [1200, 'yearly',   100],
  ])('converts %s @ %s to %s/mo', (amount, freq, expected) => {
    expect(monthlyEquivalent(amount, freq)).toBe(expected);
  });
});

// Build a MerchantRow with only the fields expectedFixedThisCycle reads.
function row(over: Partial<MerchantRow>): MerchantRow {
  const base = {
    key: 'k', desc: 'd', category: 'Housing', count: 1,
    freq: 'monthly' as const, cycles: new Set<string>(), lastTxnDate: null,
    lastChargeAbs: 0, monthly: 0, split: 1, monthlyShare: 0,
    ...over,
  };
  // Default cycleCharge to lastChargeAbs / split (the no-override path) unless
  // the caller explicitly overrides it via the `over` spread.
  return { cycleCharge: base.lastChargeAbs / base.split, ...base, ...over };
}

// A "YYYY-MM" that is `n` whole months before the current cycle (monthStartDay=1).
function cyclesAgo(n: number): string {
  const [y, m] = currentCycleKey(1).split('-').map(Number);
  const d = new Date(y, (m - 1) - n, 1);
  return cycleKey(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`, 1);
}

describe('expectedFixedThisCycle', () => {
  const cur = currentCycleKey(1);

  it('counts a monthly bill at its full charge', () => {
    const rows = [row({ freq: 'monthly', lastChargeAbs: 500, lastTxnDate: `${cyclesAgo(1)}-15` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(500);
  });

  it('counts a bill already billed this cycle (full charge)', () => {
    const rows = [row({ freq: 'monthly', lastChargeAbs: 500, cycles: new Set([cur]), lastTxnDate: `${cur}-03` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(500);
  });

  it('excludes a bimonthly bill that billed last cycle (off-cycle)', () => {
    const rows = [row({ freq: 'bimonthly', lastChargeAbs: 600, lastTxnDate: `${cyclesAgo(1)}-10` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(0);
  });

  it('counts a bimonthly bill due this cycle at full charge', () => {
    const rows = [row({ freq: 'bimonthly', lastChargeAbs: 600, lastTxnDate: `${cyclesAgo(2)}-10` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(600);
  });

  it('excludes a yearly bill that is between charges', () => {
    const rows = [row({ freq: 'yearly', lastChargeAbs: 1200, lastTxnDate: `${cyclesAgo(3)}-10` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(0);
  });

  it('counts a yearly bill due this cycle (gap >= 12)', () => {
    const rows = [row({ freq: 'yearly', lastChargeAbs: 1200, lastTxnDate: `${cyclesAgo(12)}-10` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(1200);
  });

  it('divides each row by its split divisor', () => {
    const rows = [row({ freq: 'monthly', lastChargeAbs: 600, split: 2, lastTxnDate: `${cyclesAgo(1)}-15` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(300);
  });

  it('sums multiple rows', () => {
    const rows = [
      row({ key: 'a', freq: 'monthly', lastChargeAbs: 500, lastTxnDate: `${cyclesAgo(1)}-15` }),
      row({ key: 'b', freq: 'bimonthly', lastChargeAbs: 600, lastTxnDate: `${cyclesAgo(1)}-10` }), // off-cycle → 0
      row({ key: 'c', freq: 'monthly', lastChargeAbs: 200, split: 2, lastTxnDate: `${cyclesAgo(1)}-15` }), // 100
    ];
    expect(expectedFixedThisCycle(rows, 1)).toBe(600);
  });

  it('returns 0 for an empty list', () => {
    expect(expectedFixedThisCycle([], 1)).toBe(0);
  });
});
