import { useQuery } from '@tanstack/react-query';
import { listCompanies } from '../companies';
import { qk } from '../queryClient';

/** The institution catalog for the Add Account picker. */
export function useCompanies() {
  return useQuery({ queryKey: qk.companies(), queryFn: listCompanies });
}
