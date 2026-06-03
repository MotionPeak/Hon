import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  pickScrapeStartDate, BANK_OVERLAP_DAYS, CARD_OVERLAP_DAYS,
} from '../src/scrapeWindow.js';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';

const NOW = new Date('2026-06-03T12:00:00.000Z');
const iso = (d: Date): string => d.toISOString().slice(0, 10);

describe('pickScrapeStartDate', () => {
  it('first-ever sync (no prior success) fetches the full window', () => {
    expect(iso(pickScrapeStartDate({
      now: NOW, monthsBack: 24, lastSuccess: null, fetchedSince: null, isCard: true,
    }))).toBe('2024-06-03');
  });

  it('first sync after the feature lands (no watermark yet) still backfills the full window', () => {
    // Synced before (lastSuccess set) but coverage unknown → full, so the
    // watermark it then records actually reflects fetched history.
    expect(iso(pickScrapeStartDate({
      now: NOW, monthsBack: 24, lastSuccess: '2026-06-02T12:00:00.000Z',
      fetchedSince: null, isCard: false,
    }))).toBe('2024-06-03');
  });

  it('bank with the window already covered re-pulls only a 14-day overlap since last success', () => {
    expect(BANK_OVERLAP_DAYS).toBe(14);
    expect(iso(pickScrapeStartDate({
      now: NOW, monthsBack: 24, lastSuccess: '2026-06-02T12:00:00.000Z',
      fetchedSince: '2024-06-01', isCard: false,
    }))).toBe('2026-05-19'); // 2026-06-02 − 14d
  });

  it('card uses a wider 75-day overlap so the next-bill balance is not undercounted', () => {
    expect(CARD_OVERLAP_DAYS).toBe(75);
    expect(iso(pickScrapeStartDate({
      now: NOW, monthsBack: 24, lastSuccess: '2026-06-02T12:00:00.000Z',
      fetchedSince: '2024-06-01', isCard: true,
    }))).toBe('2026-03-19'); // 2026-06-02 − 75d
  });

  it('backfills the full window when historyMonths was raised beyond current coverage', () => {
    // Covered only back to 2025-06 (12mo) but the window now wants 24mo.
    expect(iso(pickScrapeStartDate({
      now: NOW, monthsBack: 24, lastSuccess: '2026-06-02T12:00:00.000Z',
      fetchedSince: '2025-06-01', isCard: false,
    }))).toBe('2024-06-03');
  });

  it('clamps to the window when last success predates it (never starts earlier than monthsBack)', () => {
    expect(iso(pickScrapeStartDate({
      now: NOW, monthsBack: 12, lastSuccess: '2023-01-01T12:00:00.000Z',
      fetchedSince: '2022-01-01', isCard: false,
    }))).toBe('2025-06-03');
  });
});

function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'hon-watermark-'));
  const { db } = openDatabase(dir);
  return new Repo(db);
}

describe('scrape watermark (fetched_since)', () => {
  it('is unset before any sync, then records and only ever extends earlier', () => {
    const repo = makeRepo();
    const conn = repo.createConnection('hapoalim', 'Bank Hapoalim');
    expect(repo.getScrapeFetchedSince(conn.id)).toBeUndefined();

    repo.extendScrapeFetchedSince(conn.id, '2024-06-03');
    expect(repo.getScrapeFetchedSince(conn.id)).toBe('2024-06-03');

    // A later (more recent) incremental start must NOT shrink coverage.
    repo.extendScrapeFetchedSince(conn.id, '2026-05-19');
    expect(repo.getScrapeFetchedSince(conn.id)).toBe('2024-06-03');

    // An earlier start (a deeper backfill) extends it.
    repo.extendScrapeFetchedSince(conn.id, '2023-01-01');
    expect(repo.getScrapeFetchedSince(conn.id)).toBe('2023-01-01');
  });
});
