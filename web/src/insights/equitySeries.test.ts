import { describe, expect, it } from 'vitest';
import {
  buildEquitySeries,
  sliceRange,
  stitchSeries,
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
  it('uses performance.totalEquity, summed across connections, then stitches the newer snapshot tail', () => {
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
      // Snapshot dated AFTER the broker's last point (2025-02-01) now stitches
      // in as the live tail — a stale broker feed no longer freezes the chart.
      snapshots: [{ accountId: 'ibkr', date: '2025-03-01', value: 999, currency: 'USD' }],
    }));
    expect(out).toEqual([
      { date: '2025-01-01', value: 110 }, // 100 USD + 40 ILS/4
      // c-mt reports only on 01-01; forward-filled at its last value (10) so the
      // 02-01 total is c-st(110) + c-mt(10) rather than dropping the silent
      // connection — the combined line, not a sawtooth (M13).
      { date: '2025-02-01', value: 120 },
      { date: '2025-03-01', value: 999 }, // snapshot tail past broker's last point
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

describe('stitchSeries', () => {
  const P = (date: string, value: number) => ({ date, value });

  it('uses broker points up to its last date, then snapshot points after', () => {
    const broker = [P('2024-01-01', 100), P('2024-06-01', 120)];
    const snap = [P('2024-05-01', 999), P('2024-07-01', 130), P('2024-08-01', 140)];
    expect(stitchSeries(broker, snap)).toEqual([
      P('2024-01-01', 100),
      P('2024-06-01', 120),
      P('2024-07-01', 130),
      P('2024-08-01', 140),
    ]);
  });

  it('returns the snapshot series unchanged when broker is empty', () => {
    const snap = [P('2024-07-01', 130)];
    expect(stitchSeries([], snap)).toEqual(snap);
  });

  it('returns the broker series unchanged when there is nothing newer', () => {
    const broker = [P('2024-01-01', 100), P('2024-06-01', 120)];
    const snap = [P('2024-03-01', 110)];
    expect(stitchSeries(broker, snap)).toEqual(broker);
  });

  it('returns broker as-is when snapshot is empty', () => {
    const broker = [P('2024-01-01', 100)];
    expect(stitchSeries(broker, [])).toEqual(broker);
  });
});

describe('buildEquitySeries stitches broker history with newer snapshots', () => {
  const convert = (v: number) => v;
  const accounts = [{ id: 'a1', connectionId: 'c1', inceptionDate: null }];

  it('extends the broker curve with account snapshots past its last point', () => {
    const out = buildEquitySeries({
      performance: [{
        connectionId: 'c1',
        data: { totalEquity: [
          { date: '2024-01-01', value: 100 },
          { date: '2024-06-01', value: 120 },
        ], currency: 'USD' },
      }],
      snapshots: [
        { accountId: 'a1', date: '2024-06-01', value: 120, currency: 'USD' },
        { accountId: 'a1', date: '2024-07-01', value: 150, currency: 'USD' },
      ],
      holdingSnapshots: [],
      accounts,
      acctFilter: 'all',
      convert,
    });
    expect(out).toEqual([
      { date: '2024-01-01', value: 100 },
      { date: '2024-06-01', value: 120 },
      { date: '2024-07-01', value: 150 },
    ]);
  });
});

describe('buildEquitySeries — tier 1 forward-fill across connection cadences (M13)', () => {
  it('carries each connection forward instead of dropping the silent one (no sawtooth)', () => {
    // Daily IBKR vs monthly Meitav. Pre-fix this produced a sawtooth — each
    // date held only the connection that reported that exact day. Now every
    // connection is forward-filled at its last value, so the total is the
    // smooth sum (~110) rather than alternating between ~100 and ~10.
    const out = buildEquitySeries(base({
      performance: [
        { connectionId: 'c-st', data: { currency: 'USD', totalEquity: [
          { date: '2025-01-01', value: 100 },
          { date: '2025-01-02', value: 101 },
          { date: '2025-01-03', value: 105 },
        ] } },
        { connectionId: 'c-mt', data: { currency: 'USD', totalEquity: [
          { date: '2025-01-01', value: 10 }, // reports only on day 1
        ] } },
      ],
    }));
    expect(out).toEqual([
      { date: '2025-01-01', value: 110 }, // 100 + 10
      { date: '2025-01-02', value: 111 }, // 101 + 10 (Meitav forward-filled)
      { date: '2025-01-03', value: 115 }, // 105 + 10 (Meitav forward-filled)
    ]);
  });

  it('treats a not-yet-started connection as 0 until its first reported date', () => {
    const out = buildEquitySeries(base({
      performance: [
        { connectionId: 'c-st', data: { currency: 'USD', totalEquity: [
          { date: '2025-01-01', value: 100 },
          { date: '2025-02-01', value: 120 },
        ] } },
        { connectionId: 'c-mt', data: { currency: 'USD', totalEquity: [
          { date: '2025-02-01', value: 30 }, // joins later
        ] } },
      ],
    }));
    expect(out).toEqual([
      { date: '2025-01-01', value: 100 }, // c-mt not started yet → adds 0
      { date: '2025-02-01', value: 150 }, // 120 + 30
    ]);
  });
});
