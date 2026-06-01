// TanStack Query hook for the Summary domain. Replaces OverviewView's
// hand-rolled useEffect + api() + setState for the net-worth headline.

import { useQuery } from '@tanstack/react-query';
import { getSummary } from '../summary';
import { qk } from '../queryClient';

/** The net-worth / summary headline for the Overview dashboard. */
export function useSummary() {
  return useQuery({ queryKey: qk.summary(), queryFn: getSummary });
}
