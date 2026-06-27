// Transactions API module — owns GET /transactions and every per-transaction
// mutation (category, loan link, excluded override, savings mark, refund
// link). The list is parsed STRICTLY through the shared schema so backend/
// frontend shape drift fails loudly in dev (the user opted into max
// drift-safety). Mutation bodies reuse the shared PATCH schemas the engine
// validates against, so the two ends can't disagree on shape.

import {
  transactionsResponseSchema,
  txnCategorySchema,
  txnLoanSchema,
  txnExcludedSchema,
  txnSavingsSchema,
  txnLinkSchema,
  txnDetailsSchema,
  transactionLinksResponseSchema,
  type Transaction,
  type TransactionLink,
} from '@hon/shared/transaction';
import { api } from './client';

const sub = (id: string, leaf: string): string =>
  `/transactions/${encodeURIComponent(id)}/${leaf}`;

/** GET /transactions → the transaction list (newest-first, server-ordered). */
export async function listTransactions(): Promise<Transaction[]> {
  const data = await api<unknown>('/transactions');
  return transactionsResponseSchema.parse(data).transactions;
}

/** GET /transaction-links → every (expense, refund) reimbursement allocation. */
export async function listTransactionLinks(): Promise<TransactionLink[]> {
  const data = await api<unknown>('/transaction-links');
  return transactionLinksResponseSchema.parse(data).links;
}

/** PATCH /transactions/:id/category — set a transaction's category. Pass
 *  `applyToMerchant` to also create a merchant rule + backfill peers. */
export async function setTransactionCategory(
  id: string,
  category: string,
  applyToMerchant?: boolean,
): Promise<void> {
  await api(sub(id, 'category'), 'PATCH', txnCategorySchema.parse({ category, applyToMerchant }));
}

/** PATCH /transactions/:id/loan — link to a loan; `loanId: null` unlinks. */
export async function setTransactionLoan(id: string, loanId: string | null): Promise<void> {
  await api(sub(id, 'loan'), 'PATCH', txnLoanSchema.parse({ loanId }));
}

/** PATCH /transactions/:id/excluded — tri-state (true forces out, false forces
 *  in, null defers to the live card-bill rule). */
export async function setTransactionExcluded(id: string, excluded: boolean | null): Promise<void> {
  await api(sub(id, 'excluded'), 'PATCH', txnExcludedSchema.parse({ excluded }));
}

/** PATCH /transactions/:id/savings — mark/unmark money moved to savings. */
export async function setTransactionSavings(id: string, savings: boolean): Promise<void> {
  await api(sub(id, 'savings'), 'PATCH', txnSavingsSchema.parse({ savings }));
}

/** PUT /transactions/:expenseId/link — link a refund to an expense. The URL
 *  always carries the EXPENSE id and the body the REFUND id. */
export async function linkRefund(expenseId: string, refundId: string): Promise<void> {
  await api(sub(expenseId, 'link'), 'PUT', txnLinkSchema.parse({ refundId }));
}

/** DELETE /transactions/:expenseId/link — unlink a reimbursement. Pass
 *  `refundId` to remove ONE allocation; omit to remove all on this expense. */
export async function unlinkRefund(expenseId: string, refundId?: string): Promise<void> {
  const q = refundId ? `?refundId=${encodeURIComponent(refundId)}` : '';
  await api(sub(expenseId, 'link') + q, 'DELETE');
}

/** PATCH /transactions/:id/details — set a custom title and/or notes. */
export async function setTransactionDetails(
  id: string,
  fields: { customTitle?: string | null; notes?: string | null },
): Promise<void> {
  await api(sub(id, 'details'), 'PATCH', txnDetailsSchema.parse(fields));
}
