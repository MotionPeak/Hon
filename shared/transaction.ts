// Per-transaction mutation schemas — the small PATCH bodies the Activity view
// sends. Shared so the API library and engine agree on shapes.

import { z } from 'zod';

/** PATCH /transactions/:id/category */
export const txnCategorySchema = z.object({
  category: z.string().min(1),
  applyToMerchant: z.boolean().optional(),
});
export type TxnCategory = z.infer<typeof txnCategorySchema>;

/** PATCH /transactions/:id/loan — `loanId: null` unlinks. */
export const txnLoanSchema = z.object({ loanId: z.string().min(1).nullable() });
export type TxnLoan = z.infer<typeof txnLoanSchema>;

/** PATCH /transactions/:id/excluded — tri-state (true forces out, false forces
 *  in, null defers to the live card-bill rule). */
export const txnExcludedSchema = z.object({ excluded: z.boolean().nullable() });
export type TxnExcluded = z.infer<typeof txnExcludedSchema>;

/** PATCH /transactions/:id/savings */
export const txnSavingsSchema = z.object({ savings: z.boolean() });
export type TxnSavings = z.infer<typeof txnSavingsSchema>;

/** PUT /transactions/:id/link — link `refundId` against this expense. */
export const txnLinkSchema = z.object({ refundId: z.string().min(1) });
export type TxnLink = z.infer<typeof txnLinkSchema>;
