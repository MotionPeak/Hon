// Cycle math — Hon groups activity and budgets by a billing cycle the user
// can customise via settings.monthStartDay. Lifted from sidecar/public/app.html
// so multiple tabs can share the same boundary logic.

/**
 * Clamp a user-supplied start day to the 1..28 range so the derived bounds are
 * valid in every month (no Feb-30) and so cycleKey + cycleRange agree on the
 * boundary for any stored value.
 */
function clampStartDay(monthStartDay: number): number {
  return Math.min(Math.max(1, Math.floor(monthStartDay) || 1), 28);
}

/**
 * The cycle (YYYY-MM) a date belongs to, given the user's monthStartDay.
 * A `monthStartDay > 1` shifts the boundary — a date earlier in its month
 * counts toward the previous cycle.
 *
 * Parses the YYYY-MM-DD components directly rather than via `new Date(str)`,
 * which would parse as UTC midnight and then be read through local-time
 * getters — drifting a full cycle in negative-UTC timezones. Transaction dates
 * are stored as plain Israel-time calendar strings, so they must be treated as
 * calendar dates with no timezone conversion.
 */
export function cycleKey(dateStr: string, monthStartDay: number): string {
  const m0 = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
  if (!m0) return (dateStr || '').slice(0, 7);
  let y = Number(m0[1]);
  let mon = Number(m0[2]); // 1-based
  const day = Number(m0[3]);
  const startDay = clampStartDay(monthStartDay);
  if (startDay > 1 && day < startDay) {
    mon -= 1;
    if (mon < 1) { mon = 12; y -= 1; }
  }
  return `${y}-${String(mon).padStart(2, '0')}`;
}

/** "May 2026" / "December 2025" — long-month + year label of a YYYY-MM key. */
export function cycleLabel(key: string): string {
  const [yStr, mStr] = key.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: 'long', year: 'numeric',
  });
}

/** The cycle key for today (in the user's local time, matching stored dates). */
export function currentCycleKey(monthStartDay: number): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return cycleKey(`${y}-${m}-${d}`, monthStartDay);
}

/**
 * ISO `[start, end)` date bounds of the cycle `key` ("YYYY-MM"), honoring the
 * user's monthStartDay. With day 1 these are the calendar-month bounds; a
 * custom start day shifts both ends to that day. The start day is clamped to
 * 28 so the bounds are valid in every month (no Feb-30). Suitable for the
 * engine's `/budget?start=&end=` window, which filters `date >= start AND
 * date < end`.
 */
export function cycleRange(
  key: string, monthStartDay: number,
): { start: string; end: string } {
  const day = clampStartDay(monthStartDay);
  const [yStr, mStr] = key.split('-');
  const y = Number(yStr);
  const m = Number(mStr); // 1-based
  const pad = (n: number): string => String(n).padStart(2, '0');
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return {
    start: `${y}-${pad(m)}-${pad(day)}`,
    end: `${ny}-${pad(nm)}-${pad(day)}`,
  };
}

/** ISO `[start, end)` bounds of the cycle that contains today. */
export function currentCycleRange(monthStartDay: number): { start: string; end: string } {
  return cycleRange(currentCycleKey(monthStartDay), monthStartDay);
}

/** The cycle that comes one calendar month before this one. */
export function prevCycleKey(key: string): string {
  const m0 = /^(\d{4})-(\d{2})/.exec(key || '');
  if (!m0) return key;
  let y = Number(m0[1]);
  let m = Number(m0[2]) - 1; // step back one month (1-based)
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
