export type IncomeAvgMonths = 1 | 2 | 3 | 6;

export interface Settings {
  monthStartDay: number;
  projectRecurring: boolean;
  incomeAvgMonths: IncomeAvgMonths;
  hideCardTotals: boolean;
  cardProviders: string[];
  spendingAvgMonths: number;
}

export const DEFAULT_SETTINGS: Settings = {
  monthStartDay: 1,
  projectRecurring: true,
  incomeAvgMonths: 3,
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
  if (!Array.isArray(base.cardProviders)) {
    base.cardProviders = [...DEFAULT_SETTINGS.cardProviders];
  }
  if (typeof base.spendingAvgMonths !== 'number' || base.spendingAvgMonths < 1) {
    base.spendingAvgMonths = DEFAULT_SETTINGS.spendingAvgMonths;
  }
  return base;
}

export function saveSettings(s: Settings): void {
  localStorage.setItem('honSettings', JSON.stringify(s));
}
