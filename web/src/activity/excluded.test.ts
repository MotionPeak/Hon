import { describe, expect, it } from 'vitest';
import {
  isExcludedFromCycle,
  isManuallyExcluded,
  matchesCardProviderRule,
  ruleMatches,
} from './excluded';
import type { Transaction } from './types';

function txn(over: Partial<Transaction>): Transaction {
  return {
    id: 't', accountId: 'a', externalId: 'x',
    date: '2026-05-01', processedDate: null,
    amount: -100, currency: 'ILS',
    description: '', memo: null, kind: null, status: null,
    category: null, createdAt: '2026-05-01',
    ...over,
  };
}

describe('matchesCardProviderRule', () => {
  it('matches a Hebrew substring case-insensitively', () => {
    expect(matchesCardProviderRule('מקס איט פיננסים', ['מקס'])).toBe(true);
  });

  it('matches an English brand the user typed in lowercase', () => {
    expect(matchesCardProviderRule('CAL Visa Charge', ['cal'])).toBe(true);
  });

  it('does not match when no provider substring appears', () => {
    expect(matchesCardProviderRule('Shufersal', ['max', 'cal'])).toBe(false);
  });

  it('ignores empty/whitespace provider entries (does not match every row)', () => {
    expect(matchesCardProviderRule('Anything at all', ['', '   '])).toBe(false);
  });
});

describe('ruleMatches', () => {
  it('returns false when hideCardTotals is off, even if a provider matches', () => {
    expect(ruleMatches(
      txn({ description: 'מקס איט פיננסים' }),
      { hideCardTotals: false, cardProviders: ['מקס'] },
    )).toBe(false);
  });

  it('returns true when hideCardTotals is on and a provider matches', () => {
    expect(ruleMatches(
      txn({ description: 'מקס איט פיננסים' }),
      { hideCardTotals: true, cardProviders: ['מקס'] },
    )).toBe(true);
  });
});

describe('isExcludedFromCycle', () => {
  const settings = { hideCardTotals: true, cardProviders: ['מקס'] };

  it('rule-matched rows are excluded by default', () => {
    expect(isExcludedFromCycle(
      txn({ description: 'מקס איט פיננסים' }), settings,
    )).toBe(true);
  });

  it('non-matching rows are included', () => {
    expect(isExcludedFromCycle(txn({ description: 'Shufersal' }), settings))
      .toBe(false);
  });

  it('excludedManual=true forces excluded (overrides rule, even when off)', () => {
    expect(isExcludedFromCycle(
      txn({ description: 'Shufersal', excludedManual: true }),
      { hideCardTotals: false, cardProviders: [] },
    )).toBe(true);
  });

  it('excludedManual=false forces included (rescue rule-matched row)', () => {
    expect(isExcludedFromCycle(
      txn({ description: 'מקס איט פיננסים', excludedManual: false }), settings,
    )).toBe(false);
  });

  it('excludedManual=null defers to the rule', () => {
    expect(isExcludedFromCycle(
      txn({ description: 'מקס איט פיננסים', excludedManual: null }), settings,
    )).toBe(true);
  });
});

describe('isExcludedFromCycle — savings', () => {
  it('treats a savings row as out of cycle', () => {
    expect(isExcludedFromCycle({ ...txn({}), savings: true }, { hideCardTotals: true, cardProviders: [] })).toBe(true);
  });
  it('a normal row is not out of cycle', () => {
    expect(isExcludedFromCycle({ ...txn({}), savings: false }, { hideCardTotals: true, cardProviders: [] })).toBe(false);
  });
});

describe('isManuallyExcluded — savings-agnostic (drives the Exclude checkbox)', () => {
  const settings = { hideCardTotals: true, cardProviders: [] };

  it('is FALSE for a savings row (so the Exclude checkbox is not co-lit)', () => {
    expect(isManuallyExcluded({ ...txn({}), savings: true }, settings)).toBe(false);
  });

  it('is TRUE when excludedManual is true (boolean from the coerced repo read)', () => {
    expect(isManuallyExcluded(txn({ excludedManual: true }), settings)).toBe(true);
  });

  it('defers to the card-bill rule when excludedManual is null', () => {
    expect(isManuallyExcluded(
      txn({ description: 'מקס איט', excludedManual: null }),
      { hideCardTotals: true, cardProviders: ['מקס'] },
    )).toBe(true);
  });
});
