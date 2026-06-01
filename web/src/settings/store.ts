import { z } from 'zod';

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

// Each field validates against its own rule and `.catch(default)`s back to the
// default when the stored value is missing or corrupt (hand-edited localStorage,
// an old shape, a stray string). monthStartDay is clamped to 1..28 because it
// drives every cycle boundary; spendingAvgMonths to 1..120; cardProviders must
// be an array of strings (z.array(z.string()) enforces both). Unknown keys are
// dropped. This replaces the old imperative validate-after-the-fact ladder.
const settingsSchema = z.object({
  monthStartDay: z.number().int().min(1).max(28).catch(DEFAULT_SETTINGS.monthStartDay),
  projectRecurring: z.boolean().catch(DEFAULT_SETTINGS.projectRecurring),
  hideCardTotals: z.boolean().catch(DEFAULT_SETTINGS.hideCardTotals),
  cardProviders: z.array(z.string()).catch(() => [...DEFAULT_SETTINGS.cardProviders]),
  spendingAvgMonths: z.number().min(1).max(120).catch(DEFAULT_SETTINGS.spendingAvgMonths),
});

export function loadSettings(): Settings {
  let raw: unknown = {};
  try {
    const parsed = JSON.parse(localStorage.getItem('honSettings') ?? '{}');
    if (parsed && typeof parsed === 'object') raw = parsed;
  } catch {
    // Malformed JSON — parse {} so every field falls back to its default.
  }
  return settingsSchema.parse(raw);
}

export function saveSettings(s: Settings): void {
  localStorage.setItem('honSettings', JSON.stringify(s));
}
