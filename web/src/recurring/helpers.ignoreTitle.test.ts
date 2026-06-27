import { describe, it, expect } from 'vitest';
import { detectMerchants, type RecurringData } from './helpers';
import type { Category } from '../settings/CategoriesPanel';

const CATS = [{ name: 'Housing', catGroup: 'fixed', emoji: '🏠', color: '#fff' }] as unknown as Category[];
function ym(off: number): string {
  const d = new Date(); d.setMonth(d.getMonth() + off);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-03`;
}
function rent(date: string, customTitle: string | null) {
  return { id: date, accountId: 'b', date, amount: -7500, currency: 'ILS',
    description: 'LANDLORD', customTitle, notes: null, category: 'Housing', refundForId: null } as any;
}

describe('detectMerchants ignores customTitle', () => {
  it('groups by description even when each charge has a different custom title', () => {
    const data: RecurringData = {
      transactions: [rent(ym(-2), 'Rent Jan'), rent(ym(-1), 'Rent Feb'), rent(ym(0), 'Rent Mar')],
      categories: CATS, frequencies: {}, splits: {}, shareAmounts: {}, cancelled: {},
    };
    const { rows } = detectMerchants(data, 1);
    expect(rows.filter((r) => r.category === 'Housing')).toHaveLength(1);
  });
});
