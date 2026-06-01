// Manual-asset domain schemas — shared by POST/PUT /assets and the asset
// editor forms. A manual asset is something the user owns with no institution
// to scrape (car, property, cash, pension, crypto, other). `details` is
// free-form JSON the engine stores as text.

import { z } from 'zod';
import { currencySchema, nameSchema } from './common.js';

export const ASSET_KINDS = ['car', 'property', 'cash', 'pension', 'crypto', 'other'] as const;
export const assetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof assetKindSchema>;

/** Free-form per-kind detail bag (a car keeps plate/year/mileage here). */
export const assetDetailsSchema = z.record(z.string(), z.unknown()).nullish();

/** POST /assets body. */
export const assetCreateSchema = z.object({
  kind: assetKindSchema,
  name: nameSchema,
  value: z.number().finite(),
  currency: currencySchema.default('ILS'),
  details: assetDetailsSchema,
});
export type AssetCreate = z.infer<typeof assetCreateSchema>;

/** PUT /assets/:id body — partial; also used to toggle `excluded`. */
export const assetUpdateSchema = z
  .object({
    name: nameSchema,
    value: z.number().finite(),
    details: z.record(z.string(), z.unknown()).nullable(),
    excluded: z.boolean(),
  })
  .partial();
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;
