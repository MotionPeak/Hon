/**
 * The variable / discretionary allowance, projected. Whatever this cycle's
 * income leaves once fixed bills, essentials, piggy set-asides and savings are
 * reserved — less the variable spending already made. Ported from the legacy
 * SPA's `projectedVariable`, but fed the figures the React engine already
 * returns from `/budget` (`savings` and `piggyFunded` arrive already settled,
 * so there's no monthly-savings cap to recompute here).
 *
 * `predictedFixed` is the merchant-rollup's `expectedFixedThisCycle` (the same
 * number the Fixed-bills tab and the Overview headline use). When it's null
 * (projection off, or no recurring history yet) we fall back to the posted
 * `fixedSpent`, and `projected` flips to false so the card drops its
 * "Projected — …" note.
 */
export interface VariableInput {
  income: number;
  spent: number;
  essentialSpent: number;
  fixedSpent: number;
  piggyFunded: number;
  savings: number;
}

export interface ProjectedVariable {
  income: number;
  spent: number;
  fixed: number;
  essential: number;
  committed: number;
  piggy: number;
  savings: number;
  disposable: number;
  allowed: number;
  projected: boolean;
}

/**
 * Essential reserve: hold the planned essential budget (so the leftover stays
 * stable as the budget gets used), but never less than what's already spent.
 * Computed from GROUP totals (Σ budget vs Σ spent), NOT per-row — shared by
 * projectVariable and the budget editor's live preview so the two can't drift.
 */
export function essentialReserve(budgetTotal: number, spentTotal: number): number {
  return budgetTotal > 0 ? Math.max(budgetTotal, spentTotal) : spentTotal;
}

export function projectVariable(
  v: VariableInput,
  essentialBudgetTotal: number,
  predictedFixed: number | null,
): ProjectedVariable {
  const income = v.income || 0;
  const essentialSpent = v.essentialSpent || 0;
  const essential = essentialReserve(essentialBudgetTotal, essentialSpent);
  const fixed = predictedFixed != null ? predictedFixed : (v.fixedSpent || 0);
  const committed = fixed + essential;
  const piggy = Math.max(0, v.piggyFunded || 0);
  const savings = Math.max(0, v.savings || 0);
  const disposable = income - committed - piggy - savings;
  const allowed = disposable - (v.spent || 0);
  return {
    income,
    spent: v.spent || 0,
    fixed,
    essential,
    committed,
    piggy,
    savings,
    disposable,
    allowed,
    projected: predictedFixed != null,
  };
}
