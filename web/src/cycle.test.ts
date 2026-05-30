import { describe, expect, it } from 'vitest';
import {
  cycleKey, cycleLabel, currentCycleKey, prevCycleKey,
  cycleRange, currentCycleRange,
} from './cycle';

describe('cycleKey', () => {
  it('returns the calendar YYYY-MM when monthStartDay is 1', () => {
    expect(cycleKey('2026-05-15', 1)).toBe('2026-05');
    expect(cycleKey('2026-05-01', 1)).toBe('2026-05');
    expect(cycleKey('2026-05-31', 1)).toBe('2026-05');
  });

  it('returns the previous month when the day is before the start day', () => {
    // Custom cycle starts on day 20 — May 15 belongs to the April cycle.
    expect(cycleKey('2026-05-15', 20)).toBe('2026-04');
  });

  it('returns the current month when the day is on or after the start day', () => {
    expect(cycleKey('2026-05-20', 20)).toBe('2026-05');
    expect(cycleKey('2026-05-25', 20)).toBe('2026-05');
  });

  it('wraps year boundary when needed', () => {
    expect(cycleKey('2026-01-05', 20)).toBe('2025-12');
  });

  it('falls back to date prefix for unparseable input', () => {
    expect(cycleKey('not-a-date', 1)).toBe('not-a-d'); // first 7 chars
  });
});

describe('cycleLabel', () => {
  it('formats YYYY-MM as a long month + year', () => {
    expect(cycleLabel('2026-05')).toMatch(/May 2026/);
    expect(cycleLabel('2025-12')).toMatch(/December 2025/);
  });
});

describe('prevCycleKey', () => {
  it('subtracts one calendar month within a year', () => {
    expect(prevCycleKey('2026-05')).toBe('2026-04');
    expect(prevCycleKey('2026-12')).toBe('2026-11');
  });

  it('wraps across the year boundary', () => {
    expect(prevCycleKey('2026-01')).toBe('2025-12');
  });
});

describe('cycleRange', () => {
  it('returns the calendar-month bounds when monthStartDay is 1', () => {
    expect(cycleRange('2026-05', 1)).toEqual({ start: '2026-05-01', end: '2026-06-01' });
  });

  it('shifts the bounds to the start day for a custom cycle', () => {
    expect(cycleRange('2026-05', 20)).toEqual({ start: '2026-05-20', end: '2026-06-20' });
  });

  it('wraps the end across the year boundary', () => {
    expect(cycleRange('2026-12', 1)).toEqual({ start: '2026-12-01', end: '2027-01-01' });
    expect(cycleRange('2026-12', 20)).toEqual({ start: '2026-12-20', end: '2027-01-20' });
  });

  it('clamps the start day to 28 so every month is valid', () => {
    expect(cycleRange('2026-02', 31)).toEqual({ start: '2026-02-28', end: '2026-03-28' });
  });
});

describe('currentCycleRange', () => {
  it('bounds the cycle that contains today (calendar month at start day 1)', () => {
    const r = currentCycleRange(1);
    const today = new Date();
    const start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    expect(r.start).toBe(start);
    // end is the first day of the following month
    expect(r.start < r.end).toBe(true);
    expect(r.start <= today.toISOString().slice(0, 10)).toBe(true);
    expect(today.toISOString().slice(0, 10) < r.end).toBe(true);
  });
});

describe('currentCycleKey', () => {
  it('returns the cycle the current date belongs to', () => {
    const key = currentCycleKey(1);
    // YYYY-MM shape
    expect(key).toMatch(/^\d{4}-\d{2}$/);
    const today = new Date();
    expect(key).toBe(
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`,
    );
  });
});
