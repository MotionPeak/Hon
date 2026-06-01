// Query hooks for the Accounts domain. Balance / exclude writes invalidate
// accounts (the row changed) and summary (net-worth totals shift).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listAccounts, setAccountBalance, setAccountExcluded } from '../accounts';
import { qk } from '../queryClient';

/** Every account across all connections. */
export function useAccounts() {
  return useQuery({ queryKey: qk.accounts(), queryFn: listAccounts });
}

export function useSetAccountBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; balance: number }) => setAccountBalance(v.id, v.balance),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.accounts() });
      qc.invalidateQueries({ queryKey: qk.summary() });
    },
  });
}

export function useSetAccountExcluded() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; excluded: boolean }) => setAccountExcluded(v.id, v.excluded),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.accounts() });
      qc.invalidateQueries({ queryKey: qk.summary() });
    },
  });
}
