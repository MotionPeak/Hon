import { describe, it, expect } from 'vitest';
import {
  detectMerchants, expectedFixedThisCycle, fixedDueNotYetPosted,
  type RecurringData,
} from './helpers';
import type { Category } from '../settings/CategoriesPanel';

const CATS = [
  { name: 'Housing', catGroup: 'fixed', emoji: '🏠', color: '#fff' },
] as unknown as Category[];

function rent(date: string, amount = -7500) {
  return {
    id: date, accountId: 'bankA', date, amount, currency: 'ILS',
    description: 'LANDLORD', category: 'Housing', refundForId: null,
  } as any;
}

// Build dates dynamically relative to the CURRENT cycle so the test is not
// month-dependent: charges in the current cycle and the two prior cycles.
function ym(offsetMonths: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 3);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-03`;
}

const baseData = (shareAmounts: Record<string, number> = {}): RecurringData => ({
  transactions: [rent(ym(-2)), rent(ym(-1)), rent(ym(0))],
  categories: CATS,
  frequencies: {},
  splits: {},
  shareAmounts,
  cancelled: {},
});

describe('share_amount override', () => {
  it('uses the override as the per-charge amount when set', () => {
    const { rows } = detectMerchants(baseData({ Housing: 2250 }), 1);
    const housing = rows.find((r) => r.category === 'Housing')!;
    expect(housing.cycleCharge).toBe(2250);
    expect(expectedFixedThisCycle(rows, 1)).toBe(2250);
  });

  it('falls back to lastChargeAbs / split when no override', () => {
    const data = baseData();
    data.splits = { Housing: 3 };
    const { rows } = detectMerchants(data, 1);
    expect(rows[0].cycleCharge).toBe(2500); // 7500 / 3
  });
});

describe('fixedDueNotYetPosted', () => {
  it('is 0 when the bill already billed this cycle', () => {
    const { rows } = detectMerchants(baseData({ Housing: 2250 }), 1);
    expect(fixedDueNotYetPosted(rows, 1)).toBe(0);
  });

  it('counts the override charge when the bill has not posted this cycle', () => {
    const data = baseData({ Housing: 2250 });
    data.transactions = [rent(ym(-2)), rent(ym(-1))]; // no current-cycle charge
    const { rows } = detectMerchants(data, 1);
    expect(fixedDueNotYetPosted(rows, 1)).toBe(2250);
  });

  it('uses lastChargeAbs / split when due and no override', () => {
    const data = baseData();
    data.splits = { Housing: 2 };
    data.transactions = [rent(ym(-2)), rent(ym(-1))]; // no current-cycle charge → due
    const { rows } = detectMerchants(data, 1);
    expect(fixedDueNotYetPosted(rows, 1)).toBe(3750); // 7500 / 2
  });
});
