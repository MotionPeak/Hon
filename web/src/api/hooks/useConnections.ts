// Query hooks for the Connections domain. Deleting a connection drops its
// accounts, so it invalidates connections + accounts + summary. (The scrape
// trigger is imperative — call startConnectionScrape from the module directly.)

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listConnections, deleteConnection, updateConnectionCredentials } from '../connections';
import { qk } from '../queryClient';

/** Every linked institution login. */
export function useConnections() {
  return useQuery({ queryKey: qk.connections(), queryFn: listConnections });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteConnection(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.connections() });
      qc.invalidateQueries({ queryKey: qk.accounts() });
      qc.invalidateQueries({ queryKey: qk.summary() });
    },
  });
}

export function useUpdateConnectionCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; credentials: Record<string, string> }) =>
      updateConnectionCredentials(v.id, v.credentials),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.connections() }),
  });
}
