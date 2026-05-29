import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './store';

describe('loadSettings', () => {
  it('returns defaults when localStorage is empty', () => {
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('merges saved values over defaults', () => {
    localStorage.setItem('honSettings', JSON.stringify({
      monthStartDay: 10,
      hideCardTotals: false,
    }));
    const s = loadSettings();
    expect(s.monthStartDay).toBe(10);
    expect(s.hideCardTotals).toBe(false);
    expect(s.projectRecurring).toBe(DEFAULT_SETTINGS.projectRecurring);
    expect(s.cardProviders).toEqual(DEFAULT_SETTINGS.cardProviders);
  });

  it('repairs cardProviders when stored value is not an array', () => {
    localStorage.setItem('honSettings', JSON.stringify({ cardProviders: 'oops' }));
    const s = loadSettings();
    expect(s.cardProviders).toEqual(DEFAULT_SETTINGS.cardProviders);
  });

  it('falls back to defaults when stored JSON is malformed', () => {
    localStorage.setItem('honSettings', '{not-json');
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults spendingAvgMonths to 12', () => {
    expect(loadSettings().spendingAvgMonths).toBe(12);
  });

  it('falls back to 12 when spendingAvgMonths is missing or non-positive', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 0 }));
    expect(loadSettings().spendingAvgMonths).toBe(12);
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: -4 }));
    expect(loadSettings().spendingAvgMonths).toBe(12);
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    expect(loadSettings().spendingAvgMonths).toBe(9);
  });
});

describe('saveSettings', () => {
  it('writes the full settings object to localStorage', () => {
    const next: typeof DEFAULT_SETTINGS = {
      ...DEFAULT_SETTINGS,
      monthStartDay: 15,
      hideCardTotals: false,
      cardProviders: ['custom'],
    };
    saveSettings(next);
    expect(JSON.parse(localStorage.getItem('honSettings')!)).toEqual(next);
  });

  it('round-trips via loadSettings', () => {
    const next = { ...DEFAULT_SETTINGS, monthStartDay: 20 };
    saveSettings(next);
    expect(loadSettings()).toEqual(next);
  });
});
