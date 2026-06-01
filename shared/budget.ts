// Budget-tweak schemas — shared by the budget editor and PUT /budgets,
// /budget/income-override, /budget/savings.

import { z } from 'zod';
import { monthSchema, nameSchema, nonNegativeNumber } from './common.js';

/** PUT /budgets body. A non-positive `monthlyAmount` clears the budget
 *  (handled in the route), so the schema only requires a finite number. */
export const budgetSetSchema = z.object({
  category: nameSchema,
  monthlyAmount: z.number().finite(),
});
export type BudgetSet = z.infer<typeof budgetSetSchema>;

/** PUT /budget/income-override body — `value: null` clears the override. */
export const incomeOverrideSchema = z.object({
  value: nonNegativeNumber.nullable(),
});
export type IncomeOverride = z.infer<typeof incomeOverrideSchema>;

/** PUT /budget/savings body — one month's set-aside. */
export const monthlySavingsSchema = z.object({
  month: monthSchema,
  amount: nonNegativeNumber,
  transferred: z.boolean().default(false),
});
export type MonthlySavings = z.infer<typeof monthlySavingsSchema>;
