// Piggy-bank (savings goal) schemas — shared by POST/PUT /piggy and the piggy
// form. `monthly` piggies set aside a fixed amount each month; `lump` piggies
// reserve the full target in one shot. The engine cross-checks that a monthly
// piggy carries a positive monthlyAmount.

import { z } from 'zod';
import { nameSchema, positiveNumber } from './common.js';

export const PIGGY_KINDS = ['monthly', 'lump'] as const;
export const piggyKindSchema = z.enum(PIGGY_KINDS);
export type PiggyKind = z.infer<typeof piggyKindSchema>;

/** POST /piggy body. `monthlyAmount` is required-positive only for monthly
 *  piggies — enforced by superRefine so the message lands on the field. */
export const piggyCreateSchema = z
  .object({
    name: nameSchema,
    emoji: z.string().min(1).max(8).default('🐷'),
    kind: piggyKindSchema.default('monthly'),
    targetAmount: positiveNumber,
    monthlyAmount: z.number().finite().nonnegative().default(0),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'monthly' && !(v.monthlyAmount > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['monthlyAmount'],
        message: 'a positive monthly amount is required',
      });
    }
  });
export type PiggyCreate = z.infer<typeof piggyCreateSchema>;

/** PUT /piggy/:id body — partial (rename, re-target, pause via onHold…). */
export const piggyUpdateSchema = z
  .object({
    name: nameSchema,
    emoji: z.string().min(1).max(8),
    kind: piggyKindSchema,
    targetAmount: positiveNumber,
    monthlyAmount: z.number().finite().nonnegative(),
    onHold: z.boolean(),
  })
  .partial();
export type PiggyUpdate = z.infer<typeof piggyUpdateSchema>;
