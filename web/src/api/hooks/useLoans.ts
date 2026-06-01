// TanStack Query hook for the Loans domain. Replaces LoansView's hand-rolled
// useEffect + api() + setState, so Query owns caching/dedupe and — crucially —
// exposes a real `isError` flag distinct from an empty list (the old catch
// collapsed a failed fetch into the same blank "No loans yet" CTA).

import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type { Loan } from '../../accounts/types';
import { qk } from '../queryClient';

export interface LoansResponse {
  loans: Loan[];
  rates: { prime: number | null; cpiNow: number | null };
}

/** The loans list + reference rates. */
export function useLoans() {
  return useQuery({
    queryKey: qk.loans(),
    queryFn: () => api<LoansResponse>('/loans'),
  });
}
