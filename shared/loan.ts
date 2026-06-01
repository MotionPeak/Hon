// Loan domain schemas — shared by POST/PUT /loans (engine validation) and the
// loan editor form (react-hook-form). Mirrors repo.createLoan / updateLoan and
// the Israeli rate-track model (fixed / prime / cpi-fixed / cpi-prime).

import { z } from 'zod';
import { currencySchema, isoDateSchema, nameSchema, positiveNumber } from './common.js';

/** The four Israeli retail loan tracks the app recognises. */
export const RATE_TYPES = ['fixed', 'prime', 'cpi-fixed', 'cpi-prime'] as const;
export const rateTypeSchema = z.enum(RATE_TYPES);
export type RateType = z.infer<typeof rateTypeSchema>;

/** POST /loans body. The engine snapshots the CPI for cpi-linked tracks and
 *  decomposes rateType into isPrime/isCpiLinked, so those derived fields are
 *  NOT part of the wire schema. */
export const loanCreateSchema = z.object({
  name: nameSchema,
  principal: positiveNumber,
  startDate: isoDateSchema,
  termMonths: z.number().int().positive(),
  rateType: rateTypeSchema,
  rateValue: z.number().finite(),
  currency: currencySchema.default('ILS'),
  notes: z.string().trim().max(2000).nullish(),
});
export type LoanCreate = z.infer<typeof loanCreateSchema>;

/** PUT /loans/:id body — partial; the editor sends only changed fields. */
export const loanUpdateSchema = z
  .object({
    name: nameSchema,
    principal: positiveNumber,
    startDate: isoDateSchema,
    termMonths: z.number().int().positive(),
    rateValue: z.number().finite(),
    currency: currencySchema,
    notes: z.string().trim().max(2000).nullable(),
    excluded: z.boolean(),
  })
  .partial();
export type LoanUpdate = z.infer<typeof loanUpdateSchema>;

/** PATCH /loans/:id/excluded body. */
export const excludedToggleSchema = z.object({ excluded: z.boolean() });
export type ExcludedToggle = z.infer<typeof excludedToggleSchema>;
