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
  /** Per-transaction override for the "exclude from cycle" rule:
   *  true forces excluded, false forces included, null/undefined defers
   *  to the live card-bill rule (settings.cardProviders +
   *  settings.hideCardTotals). Set via PATCH /transactions/:id/excluded. */
  excludedManual?: boolean | null;
  /** "Savings" mark — money moved to savings. Out of spend, tallied as saved.
   *  Number at runtime (SQLite INTEGER); use truthy checks. */
  savings?: boolean | null;
}
