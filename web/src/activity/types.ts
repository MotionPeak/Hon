// Mirrors TxnRow in sidecar/src/repo.ts.

export interface Transaction {
  id: string;
  accountId: string;
  externalId: string;
  date: string;
  processedDate: string | null;
  amount: number;
  currency: string;
  description: string;
  memo: string | null;
  kind: string | null;
  status: string | null;
  category: string | null;
  createdAt: string;
  refundId?: string | null;
  refundForId?: string | null;
  /** Optional link to a Loan row when the matcher (or the user via
   *  PATCH /transactions/:id/loan) tagged this txn as a loan payment. */
  loanId?: string | null;
}
