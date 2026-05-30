// Cycle math — Hon groups activity and budgets by a billing cycle the user
// can customise via settings.monthStartDay. Lifted from sidecar/public/app.html
// so multiple tabs can share the same boundary logic.

/**
 * The cycle (YYYY-MM) a date belongs to, given the user's monthStartDay.
 * A `monthStartDay > 1` shifts the boundary — a date earlier in its month
 * counts toward the previous cycle.
 */
export function cycleKey(dateStr: string, monthStartDay: number): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return (dateStr || '').slice(0, 7);
  let y = d.getFullYear();
  let m = d.getMonth();
  if (monthStartDay > 1 && d.getDate() < monthStartDay) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return `${y}-${String(m + 1).padStart(2, '0')}`;
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

/** The cycle key for today. */
export function currentCycleKey(monthStartDay: number): string {
  return cycleKey(new Date().toISOString().slice(0, 10), monthStartDay);
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
  const day = Math.min(Math.max(1, Math.floor(monthStartDay) || 1), 28);
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
  const [yStr, mStr] = key.split('-');
  let y = Number(yStr);
  let m = Number(mStr) - 1; // 0-based
  m -= 1;
  if (m < 0) { m = 11; y -= 1; }
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}
