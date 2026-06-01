// Category domain — the single source of truth for category validation,
// imported by BOTH the Fastify engine (sidecar, request validation via
// fastify-type-provider-zod) AND the React app (web, react-hook-form
// resolver). Keep this file dependency-free apart from zod so it stays
// importable from either side of the wire. See /shared/README.md.

import { z } from 'zod';

/** The four spending umbrellas the budget + group breakdowns read from.
 *  `income` is the inflow bucket (excluded from every spending sum). */
export const CAT_GROUPS = ['essential', 'fixed', 'variable', 'income'] as const;
export const catGroupSchema = z.enum(CAT_GROUPS);
export type CatGroup = z.infer<typeof catGroupSchema>;

/** Accent colour as a 6-digit hex string, e.g. "#5CC773". */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #5CC773');

/** A single emoji glyph (1–8 UTF-16 units covers multi-codepoint emoji). */
export const emojiSchema = z.string().min(1).max(8);

export const CATEGORY_NAME_MAX = 40;

/** Full category as returned by GET /categories. */
export const categorySchema = z.object({
  name: z.string().min(1).max(CATEGORY_NAME_MAX),
  emoji: emojiSchema,
  color: hexColorSchema,
  catGroup: catGroupSchema,
  sortOrder: z.number().int(),
  isBuiltin: z.boolean(),
  createdAt: z.string(),
});
export type Category = z.infer<typeof categorySchema>;

/** POST /categories body. Defaults mirror the DB column defaults so a
 *  caller may omit anything but the name. */
export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name the category.').max(CATEGORY_NAME_MAX),
  emoji: emojiSchema.default('🏷️'),
  color: hexColorSchema.default('#8C8FA8'),
  catGroup: catGroupSchema.default('variable'),
  sortOrder: z.number().int().default(100),
});
export type CategoryCreate = z.infer<typeof categoryCreateSchema>;

/** PUT /categories/:name body — every field optional (partial update). */
export const categoryUpdateSchema = z
  .object({
    emoji: emojiSchema,
    color: hexColorSchema,
    catGroup: catGroupSchema,
    sortOrder: z.number().int(),
  })
  .partial();
export type CategoryUpdate = z.infer<typeof categoryUpdateSchema>;

/** :name path param for PUT/DELETE /categories/:name. */
export const categoryNameParamSchema = z.object({ name: z.string().min(1) });
export type CategoryNameParam = z.infer<typeof categoryNameParamSchema>;

/** What the in-app editor (react-hook-form) manages. The editor always
 *  has concrete values for every field, so nothing is optional here —
 *  this keeps the resolved form-values type clean. `sortOrder` is owned
 *  by the API layer (new categories default to 500), not the form. */
export const categoryFormSchema = z.object({
  name: z.string().trim().min(1, 'Name the category.').max(CATEGORY_NAME_MAX),
  emoji: emojiSchema,
  color: hexColorSchema,
  catGroup: catGroupSchema,
});
export type CategoryForm = z.infer<typeof categoryFormSchema>;
