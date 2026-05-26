import { describe, expect, it } from 'vitest';
import { israelDate, normalizeTransaction, type RawTransaction } from '../src/scrapers.js';

// Tests for the date/amount normalization that runs on EVERY scraped
// transaction. israeli-bank-scrapers reports dates as UTC midnight, so
// naive use would file every transaction one calendar day early (in
// Asia/Jerusalem time). The chargedAmount fallback handles Max's
// pending rows that ship with chargedAmount=0 until the bill finalises.

describe('israelDate', () => {
  it('shifts a UTC midnight to the next Israeli calendar day', () => {
    // UTC midnight on May 26 → 03:00 May 26 in Israel (IDT, UTC+3)
    // Both end up as 2026-05-26 — already past midnight in Israel.
    expect(israelDate('2026-05-26T00:00:00.000Z')).toBe('2026-05-26');
  });

  it('keeps a UTC late-evening on the SAME local date', () => {
    // UTC 22:00 May 26 → 01:00 May 27 in Israel (UTC+3). Should
    // record as May 27 — the transaction happened "tomorrow" locally.
    expect(israelDate('2026-05-26T22:00:00.000Z')).toBe('2026-05-27');
  });

  it('returns the input unchanged for an unparseable string', () => {
    expect(israelDate('not-a-date')).toBe('not-a-date');
  });

  it('handles YYYY-MM-DD bare dates by parsing as UTC midnight', () => {
    // Without time component, JS Date parses as UTC midnight.
    // In Israel that's 03:00 same day during IDT, 02:00 during IST —
    // still the same calendar date.
    expect(israelDate('2026-05-26')).toBe('2026-05-26');
  });
});

describe('normalizeTransaction', () => {
  // Helper — minimal raw txn, callers override what they care about.
  const raw = (overrides: Partial<RawTransaction>): RawTransaction => ({
    date: '2026-05-26T00:00:00.000Z',
    originalAmount: -100,
    chargedAmount: -100,
    description: 'Test merchant',
    ...overrides,
  });

  describe('externalId construction', () => {
    it('combines bank identifier with the date so a reused ref# stays distinct', () => {
      // Banks reuse a single reference number across recurring deposits;
      // pairing with the date keeps each one a separate row.
      const t = normalizeTransaction(raw({ identifier: '42', date: '2026-05-26T00:00:00.000Z' }));
      expect(t.externalId).toBe('42:2026-05-26');
    });

    it('uses a fingerprint when no identifier is provided', () => {
      const t = normalizeTransaction(raw({ identifier: undefined }));
      // 16-char sha1 prefix + ':' + date
      expect(t.externalId).toMatch(/^[a-f0-9]{16}:\d{4}-\d{2}-\d{2}$/);
    });

    it('treats numeric NaN identifier as "no identifier"', () => {
      const t = normalizeTransaction(raw({ identifier: Number('xyz') }));
      // Falls through to fingerprint path
      expect(t.externalId).toMatch(/^[a-f0-9]{16}:\d{4}-\d{2}-\d{2}$/);
    });

    it('treats empty-string identifier as "no identifier"', () => {
      const t = normalizeTransaction(raw({ identifier: '' }));
      expect(t.externalId).toMatch(/^[a-f0-9]{16}:\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('amount selection (chargedAmount vs originalAmount fallback)', () => {
    it('uses chargedAmount when non-zero', () => {
      const t = normalizeTransaction(raw({ chargedAmount: -250, originalAmount: -300 }));
      expect(t.amount).toBe(-250);
    });

    it('falls back to originalAmount when chargedAmount is 0 (Max pending row)', () => {
      // Max ships pending charges with chargedAmount=0 until the bill
      // finalises. The fallback keeps the row from rendering as ₪0.
      const t = normalizeTransaction(raw({
        chargedAmount: 0,
        originalAmount: -125,
        chargedCurrency: 'ILS',
        originalCurrency: 'ILS',
      }));
      expect(t.amount).toBe(-125);
    });

    it('does NOT fall back when currencies differ (would need FX conversion)', () => {
      // A USD foreign purchase: originalAmount is in USD, chargedAmount
      // will be in ILS once converted. Falling back would put a USD
      // figure into an ILS field. Leave at 0 until the next sync brings
      // the converted value.
      const t = normalizeTransaction(raw({
        chargedAmount: 0,
        originalAmount: -50,
        chargedCurrency: 'ILS',
        originalCurrency: 'USD',
      }));
      expect(t.amount).toBe(0);
    });

    it('does fall back when chargedCurrency is missing (assume same)', () => {
      const t = normalizeTransaction(raw({
        chargedAmount: 0,
        originalAmount: -75,
        originalCurrency: 'ILS',
        // chargedCurrency intentionally undefined
      }));
      expect(t.amount).toBe(-75);
    });
  });

  describe('currency selection', () => {
    it('prefers chargedCurrency', () => {
      const t = normalizeTransaction(raw({
        chargedCurrency: 'ILS',
        originalCurrency: 'USD',
      }));
      expect(t.currency).toBe('ILS');
    });

    it('falls back to originalCurrency', () => {
      const t = normalizeTransaction(raw({ originalCurrency: 'EUR' }));
      expect(t.currency).toBe('EUR');
    });

    it('defaults to ILS when both are missing', () => {
      const t = normalizeTransaction(raw({}));
      expect(t.currency).toBe('ILS');
    });
  });

  describe('processed date', () => {
    it('runs through israelDate when provided', () => {
      const t = normalizeTransaction(raw({
        processedDate: '2026-05-26T22:00:00.000Z',
      }));
      expect(t.processedDate).toBe('2026-05-27');
    });

    it('is undefined when not provided', () => {
      const t = normalizeTransaction(raw({}));
      expect(t.processedDate).toBeUndefined();
    });
  });
});
