// Transaction row + per-transaction mutation schemas. Shared so the API
// library and engine agree on shapes.

import { z } from 'zod';

/** A transaction row as returned by GET /transactions. Mirrors `TxnRow` in
 *  sidecar/src/repo.ts. The trailing fields are optional/nullable — they are
 *  only present on some rows (refund links, loan link, tri-state overrides). */
export const transactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  externalId: z.string(),
  date: z.string(),
  processedDate: z.string().nullable(),
  amount: z.number(),
  currency: z.string(),
  description: z.string(),
  memo: z.string().nullable(),
  kind: z.string().nullable(),
  status: z.string().nullable(),
  category: z.string().nullable(),
  createdAt: z.string(),
  refundId: z.string().nullable().optional(),
  refundForId: z.string().nullable().optional(),
  loanId: z.string().nullable().optional(),
  excludedManual: z.boolean().nullable().optional(),
  savings: z.boolean().nullable().optional(),
  customTitle: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Reimbursement netting (present from GET /transactions; optional so older
  // payloads and test fixtures still parse).
  reimbursedTotal: z.number().optional(),
  reimbursementCount: z.number().optional(),
  effectiveAmount: z.number().optional(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const transactionsResponseSchema = z.object({
  transactions: z.array(transactionSchema),
});

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

/** PATCH /transactions/:id/details — set/clear the display title and/or notes.
 *  Both optional; null or "" clears. */
export const txnDetailsSchema = z.object({
  customTitle: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type TxnDetails = z.infer<typeof txnDetailsSchema>;

/** PUT /transactions/:id/link — link `refundId` against this expense. */
export const txnLinkSchema = z.object({ refundId: z.string().min(1) });
export type TxnLink = z.infer<typeof txnLinkSchema>;

/** One (expense, refund) allocation row as returned by GET /transaction-links. */
export const transactionLinkSchema = z.object({
  expenseId: z.string(),
  refundId: z.string(),
  amount: z.number(),
});
export type TransactionLink = z.infer<typeof transactionLinkSchema>;

/** GET /transaction-links → `{ links: [...] }`. */
export const transactionLinksResponseSchema = z.object({
  links: z.array(transactionLinkSchema),
});
