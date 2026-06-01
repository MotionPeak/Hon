// Voucher / gift-card schemas — shared by POST /vouchers, PATCH /vouchers/:id
// and the voucher form. `expiresOn` is an optional YYYY-MM-DD; null when the
// voucher does not expire.

import { z } from 'zod';
import { currencySchema, isoDateSchema, nameSchema } from './common.js';

/** POST /vouchers body. */
export const voucherCreateSchema = z.object({
  name: nameSchema,
  provider: z.string().trim().min(1),
  balance: z.number().finite(),
  currency: currencySchema.default('ILS'),
  expiresOn: isoDateSchema.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});
export type VoucherCreate = z.infer<typeof voucherCreateSchema>;

/** PATCH /vouchers/:id body — partial. */
export const voucherUpdateSchema = z
  .object({
    name: nameSchema,
    provider: z.string().trim().min(1),
    balance: z.number().finite(),
    currency: currencySchema,
    expiresOn: isoDateSchema.nullable(),
    notes: z.string().trim().max(2000).nullable(),
    excluded: z.boolean(),
  })
  .partial();
export type VoucherUpdate = z.infer<typeof voucherUpdateSchema>;
