import { describe, expect, it } from 'vitest';
import { buildHoldingSeries } from './holdingSeries';
import type { HoldingSnapshot } from './equitySeries';

const id = (value: number) => value; // identity convert (no FX)

function snap(accountId: string, date: string, value: number): HoldingSnapshot {
  return { accountId, symbol: 'VT', date, value, currency: 'USD' };
}

describe('buildHoldingSeries', () => {
  it('sums a symbol across its accounts per day', () => {
    const snaps = [
      snap('a', '2026-01-01', 10), snap('b', '2026-01-01', 5),
      snap('a', '2026-01-02', 12),
    ];
    const out = buildHoldingSeries(snaps, 'VT', ['a', 'b'], (v) => id(v), 'USD', {});
    expect(out).toEqual([
      { date: '2026-01-01', value: 15 },
      { date: '2026-01-02', value: 12 },
    ]);
  });

  it('ignores other symbols and out-of-scope accounts', () => {
    const snaps = [
      snap('a', '2026-01-01', 10),
      { ...snap('a', '2026-01-01', 99), symbol: 'AAPL' },
      snap('z', '2026-01-01', 50),
    ];
    const out = buildHoldingSeries(snaps, 'VT', ['a'], (v) => id(v), 'USD', {});
    expect(out).toEqual([{ date: '2026-01-01', value: 10 }]);
  });

  it('clips points before an account inception date', () => {
    const snaps = [snap('a', '2026-01-01', 10), snap('a', '2026-02-01', 20)];
    const out = buildHoldingSeries(snaps, 'VT', ['a'], (v) => id(v), 'USD', { a: '2026-01-15' });
    expect(out).toEqual([{ date: '2026-02-01', value: 20 }]);
  });

  it('drops points the converter cannot price (null)', () => {
    const snaps = [snap('a', '2026-01-01', 10)];
    const out = buildHoldingSeries(snaps, 'VT', ['a'], () => null, 'USD', {});
    expect(out).toEqual([]);
  });
});
