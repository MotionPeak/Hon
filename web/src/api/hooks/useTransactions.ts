// TanStack Query hooks for the Transactions domain. Replaces the hand-rolled
// useEffect + api() + setState reads (Activity/Insights/Overview/Recurring)
// and the per-transaction mutations in Activity that previously each called a
// manual refresh(). Every write shifts spend totals, so it invalidates
// transactions + summary + accounts; a loan link also changes the loan's
// payments list, so it invalidates loans too.

import {
  useMutation, useQuery, useQueryClient, type QueryClient,
} from '@tanstack/react-query';
import {
  listTransactions,
  setTransactionCategory,
  setTransactionLoan,
  setTransactionExcluded,
  setTransactionSavings,
  linkRefund,
  unlinkRefund,
  setTransactionDetails,
} from '../transactions';
import { qk } from '../queryClient';

function invalidateAfterTxnWrite(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: qk.transactions() });
  qc.invalidateQueries({ queryKey: qk.summary() });
  qc.invalidateQueries({ queryKey: qk.accounts() });
}

/** The transaction list. */
export function useTransactions() {
  return useQuery({ queryKey: qk.transactions(), queryFn: listTransactions });
}

export function useSetTransactionCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; category: string; applyToMerchant?: boolean }) =>
      setTransactionCategory(v.id, v.category, v.applyToMerchant),
    onSuccess: () => invalidateAfterTxnWrite(qc),
  });
}

export function useSetTransactionLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; loanId: string | null }) => setTransactionLoan(v.id, v.loanId),
    onSuccess: () => {
      invalidateAfterTxnWrite(qc);
      qc.invalidateQueries({ queryKey: qk.loans() });
    },
  });
}

export function useSetTransactionExcluded() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; excluded: boolean | null }) =>
      setTransactionExcluded(v.id, v.excluded),
    onSuccess: () => invalidateAfterTxnWrite(qc),
  });
}

export function useSetTransactionSavings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; savings: boolean }) => setTransactionSavings(v.id, v.savings),
    onSuccess: () => invalidateAfterTxnWrite(qc),
  });
}

export function useLinkRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { expenseId: string; refundId: string }) => linkRefund(v.expenseId, v.refundId),
    onSuccess: () => invalidateAfterTxnWrite(qc),
  });
}

export function useUnlinkRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (expenseId: string) => unlinkRefund(expenseId),
    onSuccess: () => invalidateAfterTxnWrite(qc),
  });
}

export function useSetTransactionDetails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; customTitle?: string | null; notes?: string | null }) =>
      setTransactionDetails(v.id, { customTitle: v.customTitle, notes: v.notes }),
    onSuccess: () => invalidateAfterTxnWrite(qc),
  });
}
