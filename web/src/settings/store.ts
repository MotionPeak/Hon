export interface Settings {
  monthStartDay: number;
  projectRecurring: boolean;
  hideCardTotals: boolean;
  cardProviders: string[];
  spendingAvgMonths: number;
}

export const DEFAULT_SETTINGS: Settings = {
  monthStartDay: 1,
  projectRecurring: true,
  hideCardTotals: true,
  cardProviders: [
    'מקס', 'ישראכרט', 'כאל', 'ויזה כאל', 'אמריקן אקספרס',
    'לאומי קארד', 'דיינרס', 'max', 'isracard', 'cal', 'american express',
    'leumi card', 'diners',
  ],
  spendingAvgMonths: 12,
};

export function loadSettings(): Settings {
  const base: Settings = {
    ...DEFAULT_SETTINGS,
    cardProviders: [...DEFAULT_SETTINGS.cardProviders],
  };
  try {
    const raw = JSON.parse(localStorage.getItem('honSettings') ?? '{}');
    if (raw && typeof raw === 'object') Object.assign(base, raw);
  } catch {
    // Malformed JSON — keep defaults.
  }
  // Must be an array of strings — a non-array, or array with non-string
  // elements (hand-edited/corrupted), would break the card-bill exclusion
  // filter that compares provider names. Reset wholesale on any violation.
  if (
    !Array.isArray(base.cardProviders)
    || !base.cardProviders.every((p) => typeof p === 'string')
  ) {
    base.cardProviders = [...DEFAULT_SETTINGS.cardProviders];
  }
  if (
    typeof base.spendingAvgMonths !== 'number'
    || base.spendingAvgMonths < 1
    || base.spendingAvgMonths > 120
  ) {
    base.spendingAvgMonths = DEFAULT_SETTINGS.spendingAvgMonths;
  }
  // monthStartDay drives every cycle boundary — a corrupted/hand-edited value
  // (31, 0, NaN, a string) would misbucket transactions. Clamp to a valid day.
  if (
    typeof base.monthStartDay !== 'number'
    || !Number.isInteger(base.monthStartDay)
    || base.monthStartDay < 1
    || base.monthStartDay > 28
  ) {
    base.monthStartDay = DEFAULT_SETTINGS.monthStartDay;
  }
  return base;
}

export function saveSettings(s: Settings): void {
  localStorage.setItem('honSettings', JSON.stringify(s));
}
