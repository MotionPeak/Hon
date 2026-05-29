import { describe, expect, it } from 'vitest';
import {
  buildEquitySeries,
  sliceRange,
  type BuildEquityInput,
  type SeriesPoint,
} from './equitySeries';

// Identity-ish convert: USD passes through, ILS→USD at /4, unknown → null.
const convert = (v: number, cur: string): number | null => {
  if (cur === 'USD') return v;
  if (cur === 'ILS') return v / 4;
  return null;
};

const accounts = [
  { id: 'ibkr', connectionId: 'c-st', inceptionDate: null },
  { id: 'meitav', connectionId: 'c-mt', inceptionDate: null },
];

function base(over: Partial<BuildEquityInput>): BuildEquityInput {
  return {
    performance: [],
    snapshots: [],
    holdingSnapshots: [],
    accounts,
    acctFilter: 'all',
    convert,
    ...over,
  };
}

describe('buildEquitySeries — tier 1: performance', () => {
  it('prefers performance.totalEquity over snapshots, summed across connections', () => {
    const out = buildEquitySeries(base({
      performance: [
        { connectionId: 'c-st', data: { totalEquity: [
          { date: '2025-01-01', value: 100, currency: 'USD' },
          { date: '2025-02-01', value: 110, currency: 'USD' },
        ] } },
        { connectionId: 'c-mt', data: { totalEquity: [
          { date: '2025-01-01', value: 40, currency: 'ILS' }, // /4 = 10
        ] } },
      ],
      // snapshots present but must be IGNORED when performance exists.
      snapshots: [{ accountId: 'ibkr', date: '2025-03-01', value: 999, currency: 'USD' }],
    }));
    expect(out).toEqual([
      { date: '2025-01-01', value: 110 }, // 100 USD + 40 ILS/4
      { date: '2025-02-01', value: 110 },
    ]);
  });

  it('filters performance to the focused account\'s connection', () => {
    const out = buildEquitySeries(base({
      acctFilter: 'meitav',
      performance: [
        { connectionId: 'c-st', data: { totalEquity: [{ date: '2025-01-01', value: 100, currency: 'USD' }] } },
        { connectionId: 'c-mt', data: { totalEquity: [{ date: '2025-01-01', value: 40, currency: 'ILS' }] } },
      ],
    }));
    // Only c-mt (Meitav) contributes: 40 ILS / 4 = 10.
    expect(out).toEqual([{ date: '2025-01-01', value: 10 }]);
  });

  it('clips performance points before the focused account inception', () => {
    const out = buildEquitySeries(base({
      acctFilter: 'ibkr',
      accounts: [
        { id: 'ibkr', connectionId: 'c-st', inceptionDate: '2025-02-01' },
        { id: 'meitav', connectionId: 'c-mt', inceptionDate: null },
      ],
      performance: [
        { connectionId: 'c-st', data: { totalEquity: [
          { date: '2025-01-01', value: 100, currency: 'USD' }, // before inception → dropped
          { date: '2025-02-15', value: 120, currency: 'USD' },
        ] } },
      ],
    }));
    expect(out).toEqual([{ date: '2025-02-15', value: 120 }]);
  });
});

describe('buildEquitySeries — tier 2: holding snapshots', () => {
  it('forward-fills per (account,symbol) when no performance exists', () => {
    const out = buildEquitySeries(base({
      holdingSnapshots: [
        { accountId: 'ibkr', symbol: 'AAA', date: '2025-01-01', value: 100, currency: 'USD' },
        { accountId: 'ibkr', symbol: 'BBB', date: '2025-01-02', value: 50, currency: 'USD' },
        // AAA has no 01-02 point → forward-filled at 100.
      ],
    }));
    expect(out).toEqual([
      { date: '2025-01-01', value: 100 },        // only AAA known
      { date: '2025-01-02', value: 150 },        // AAA(100 ff) + BBB(50)
    ]);
  });

  it('is ignored when performance exists', () => {
    const out = buildEquitySeries(base({
      performance: [{ connectionId: 'c-st', data: { totalEquity: [{ date: '2025-01-01', value: 7, currency: 'USD' }] } }],
      holdingSnapshots: [{ accountId: 'ibkr', symbol: 'AAA', date: '2025-01-01', value: 100, currency: 'USD' }],
    }));
    expect(out).toEqual([{ date: '2025-01-01', value: 7 }]);
  });
});

describe('buildEquitySeries — tier 3: account snapshots', () => {
  it('falls back to account snapshots, summed by date', () => {
    const out = buildEquitySeries(base({
      snapshots: [
        { accountId: 'ibkr', date: '2025-01-01', value: 100, currency: 'USD' },
        { accountId: 'meitav', date: '2025-01-01', value: 80, currency: 'ILS' }, // /4 = 20
        { accountId: 'ibkr', date: '2025-01-02', value: 110, currency: 'USD' },
      ],
    }));
    expect(out).toEqual([
      { date: '2025-01-01', value: 120 },
      { date: '2025-01-02', value: 110 },
    ]);
  });

  it('scopes snapshots to the focused account', () => {
    const out = buildEquitySeries(base({
      acctFilter: 'ibkr',
      snapshots: [
        { accountId: 'ibkr', date: '2025-01-01', value: 100, currency: 'USD' },
        { accountId: 'meitav', date: '2025-01-01', value: 80, currency: 'ILS' },
      ],
    }));
    expect(out).toEqual([{ date: '2025-01-01', value: 100 }]);
  });

  it('clips snapshots before a focused account inception', () => {
    const out = buildEquitySeries(base({
      acctFilter: 'ibkr',
      accounts: [{ id: 'ibkr', connectionId: 'c-st', inceptionDate: '2025-01-02' }],
      snapshots: [
        { accountId: 'ibkr', date: '2025-01-01', value: 100, currency: 'USD' }, // dropped
        { accountId: 'ibkr', date: '2025-01-02', value: 110, currency: 'USD' },
      ],
    }));
    expect(out).toEqual([{ date: '2025-01-02', value: 110 }]);
  });

  it('returns empty for no data', () => {
    expect(buildEquitySeries(base({}))).toEqual([]);
  });
});

describe('sliceRange', () => {
  const NOW = new Date('2026-05-28T12:00:00Z');
  const series: SeriesPoint[] = [
    { date: '2024-06-01', value: 10 },
    { date: '2025-01-01', value: 20 },
    { date: '2026-03-01', value: 30 },
    { date: '2026-05-01', value: 40 },
    { date: '2026-05-20', value: 50 },
  ];

  it('ALL returns the whole series', () => {
    expect(sliceRange(series, 'ALL', NOW)).toHaveLength(5);
  });

  it('1Y keeps points within the last 12 months', () => {
    const out = sliceRange(series, '1Y', NOW);
    expect(out.map((p) => p.date)).toEqual(['2026-03-01', '2026-05-01', '2026-05-20']);
  });

  it('YTD keeps points since Jan 1 of this year', () => {
    const out = sliceRange(series, 'YTD', NOW);
    expect(out.map((p) => p.date)).toEqual(['2026-03-01', '2026-05-01', '2026-05-20']);
  });

  it('anchors to the last point before the window when the slice has <2 points', () => {
    // 1M window from 2026-05-28 → cutoff 2026-04-28. Only 2026-05-01 and
    // 2026-05-20 are inside (2 points) — so to exercise the anchor, use a
    // series with a single in-window point.
    const sparse: SeriesPoint[] = [
      { date: '2026-01-01', value: 10 },
      { date: '2026-05-20', value: 50 },
    ];
    const out = sliceRange(sparse, '1M', NOW);
    // Only 2026-05-20 is inside the 1M window; anchor 2026-01-01 prepended.
    expect(out.map((p) => p.date)).toEqual(['2026-01-01', '2026-05-20']);
  });

  it('empty series stays empty', () => {
    expect(sliceRange([], '1Y', NOW)).toEqual([]);
  });
});
