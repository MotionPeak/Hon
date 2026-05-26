import { describe, expect, it } from 'vitest';
import {
  merchantKey, merchantName, monthlyEquivalent, type Frequency,
} from './helpers';

describe('merchantKey + merchantName', () => {
  it('drops digit-bearing words from the merchant key', () => {
    // The scraper often appends trailing numeric codes per charge — they
    // would otherwise make each charge look like a distinct merchant.
    expect(merchantKey('Shufersal 12345')).toBe('shufersal');
    expect(merchantName('Shufersal 12345')).toBe('Shufersal');
  });

  it('preserves order of non-digit words', () => {
    expect(merchantKey('Tel Aviv Light Rail')).toBe('tel aviv light rail');
    expect(merchantName('Tel Aviv Light Rail')).toBe('Tel Aviv Light Rail');
  });

  it('lowercases for the key but not the display name', () => {
    expect(merchantKey('NETFLIX')).toBe('netflix');
    expect(merchantName('NETFLIX')).toBe('NETFLIX');
  });

  it('falls back to the original description when only digits are present', () => {
    expect(merchantKey('1234')).toBe('1234');
    expect(merchantName('1234')).toBe('1234');
  });
});

describe('monthlyEquivalent', () => {
  it.each<[number, Frequency, number]>([
    [120, 'monthly',   120],
    [120, 'bimonthly', 60],
    [1200, 'yearly',   100],
  ])('converts %s @ %s to %s/mo', (amount, freq, expected) => {
    expect(monthlyEquivalent(amount, freq)).toBe(expected);
  });
});
