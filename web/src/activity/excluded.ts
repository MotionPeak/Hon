// "Exclude from cycle" rules. A transaction is excluded from monthly totals,
// the cycle projection, and the categorised grouping when this helper
// returns true. Two inputs decide:
//
//   1. transaction.excludedManual (DB column, set via
//      PATCH /transactions/:id/excluded) — when set, it wins. true forces
//      excluded, false forces included regardless of the rule below.
//
//   2. The live card-bill rule from Settings: when settings.hideCardTotals
//      is on AND the description contains any of settings.cardProviders
//      (case-insensitive substring), the row matches and is treated as a
//      lump-sum card-bill total — those are already itemised under the
//      card account, so counting the bank-side lump too would double-count.
//
// The manual override is intentionally tri-state (true/false/null) so a
// user can both add rows to the excluded section AND rescue a false match.

import type { Transaction } from './types';

export interface ExclusionSettings {
  hideCardTotals: boolean;
  cardProviders: string[];
}

/** True when description contains any of the cardProviders substrings
 *  (case-insensitive). The substrings are typed by the user in Settings;
 *  empty/whitespace entries are ignored so a stray Enter doesn't
 *  silently match every row. */
export function matchesCardProviderRule(
  description: string,
  cardProviders: string[],
): boolean {
  const lower = description.toLowerCase();
  for (const term of cardProviders) {
    const t = term.trim().toLowerCase();
    if (t && lower.includes(t)) return true;
  }
  return false;
}

/** Whether the rule (settings only) would mark this row as a card-bill
 *  total. Distinct from {@link isExcludedFromCycle} so the UI can tell a
 *  user "the rule matches this row" vs. "you manually excluded it". */
export function ruleMatches(t: Transaction, settings: ExclusionSettings): boolean {
  if (!settings.hideCardTotals) return false;
  return matchesCardProviderRule(t.description ?? '', settings.cardProviders);
}

/** Effective excluded state combining manual override + live rule. */
export function isExcludedFromCycle(
  t: Transaction,
  settings: ExclusionSettings,
): boolean {
  if (t.excludedManual === true) return true;
  if (t.excludedManual === false) return false;
  return ruleMatches(t, settings);
}
