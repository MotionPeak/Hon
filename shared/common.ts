// Shared zod primitives reused across Hon's domain schemas. Imported by BOTH
// the Fastify engine (request validation) and the React app (react-hook-form
// resolvers), so this file stays dependency-free apart from zod.

import { z } from 'zod';

/** A calendar date, `YYYY-MM-DD`. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-05-01 (YYYY-MM-DD)');

/** A calendar month, `YYYY-MM`. */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Use a month like 2026-05 (YYYY-MM)');

/** An ISO-4217-ish currency code; upper-cased. Defaults applied by callers. */
export const currencySchema = z
  .string()
  .trim()
  .min(3)
  .max(3)
  .transform((s) => s.toUpperCase());

/** A non-empty trimmed display name with a sane upper bound. */
export const nameSchema = z.string().trim().min(1).max(120);

/** A strictly-positive finite number (principal, balance, target…). */
export const positiveNumber = z.number().finite().positive();

/** A non-negative finite number (amounts that may be zero). */
export const nonNegativeNumber = z.number().finite().nonnegative();

/** `{ id }` route param — the common path-param shape. */
export const idParamSchema = z.object({ id: z.string().min(1) });
export type IdParam = z.infer<typeof idParamSchema>;
