import { describe, expect, it } from 'vitest';
import { cycleKey, cycleLabel, currentCycleKey } from './cycle';

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
