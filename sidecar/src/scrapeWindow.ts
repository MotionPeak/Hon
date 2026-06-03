// Decides how far back a sync fetches. Pure + dependency-free (no scraper/DB
// imports) so the logic is unit-tested directly. The runner supplies the live
// inputs (last success, watermark, card flag) and feeds the result to the
// scraper as its start date.

/**
 * Days of overlap an *incremental* sync re-fetches, by institution kind.
 *
 * Banks post within a day or two, so a short overlap catches the odd backdated
 * row. Cards need a wider floor: a card's reported "balance" is the next-bill
 * total summed from every still-unbilled charge, and the earliest of those can
 * be ~6 weeks old — start any later and the bill is undercounted. (That
 * undercount is exactly why the original `lastSuccess − 14d` shortcut was
 * pulled; the floor fixes it instead of dropping incrementality.)
 */
export const BANK_OVERLAP_DAYS = 14;
export const CARD_OVERLAP_DAYS = 75;

/** `months` calendar months before `now` (local-time arithmetic, matching the
 *  rest of Hon's cycle math). */
export function startDateMonthsAgo(months: number, now: Date = new Date()): Date {
  const date = new Date(now.getTime());
  date.setMonth(date.getMonth() - months);
  return date;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export interface ScrapeWindowInputs {
  /** Reference "today". */
  now: Date;
  /** Per-connection history window, in months (1–24). */
  monthsBack: number;
  /** `finished_at` of the last successful scrape, or null if never. */
  lastSuccess: string | null;
  /** Watermark: the earliest date a successful sync has already fetched from
   *  for this connection, or null if unrecorded. */
  fetchedSince: string | null;
  /** True for credit cards — widens the incremental overlap (see constants). */
  isCard: boolean;
}

/**
 * Picks a scrape start date: incremental once the full `monthsBack` window is
 * already covered, a full backfill otherwise.
 *
 * - No prior success → full window (first sync).
 * - No watermark, or the window now reaches earlier than the watermark (the
 *   user raised `historyMonths`) → full window, to backfill the missing history.
 *   The success path then records the watermark, so it only happens once.
 * - Otherwise → re-pull only since the last success minus an overlap, clamped
 *   so it never starts earlier than the window itself.
 */
export function pickScrapeStartDate(i: ScrapeWindowInputs): Date {
  const desired = startDateMonthsAgo(i.monthsBack, i.now);
  if (!i.lastSuccess) return desired;
  if (!i.fetchedSince || i.fetchedSince > isoDate(desired)) return desired;
  const overlapDays = i.isCard ? CARD_OVERLAP_DAYS : BANK_OVERLAP_DAYS;
  const incremental = new Date(i.lastSuccess);
  incremental.setDate(incremental.getDate() - overlapDays);
  return incremental < desired ? desired : incremental;
}
