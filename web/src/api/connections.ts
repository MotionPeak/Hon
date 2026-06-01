// Connections API module — owns GET /connections, the delete + credentials
// writes, and the scrape trigger. The list is parsed through the shared
// schema. `startConnectionScrape` is imperative (it feeds the existing
// run-status poll), so it stays a direct call rather than a Query hook.

import { connectionsResponseSchema, type Connection } from '@hon/shared/connection';
import { api } from './client';

/** GET /connections → every linked institution login. */
export async function listConnections(): Promise<Connection[]> {
  const data = await api<unknown>('/connections');
  return connectionsResponseSchema.parse(data).connections;
}

/** DELETE /connections/:id — remove a connection and its accounts. */
export async function deleteConnection(id: string): Promise<void> {
  await api(`/connections/${encodeURIComponent(id)}`, 'DELETE');
}

/** PUT /connections/:id/credentials — re-save login credentials to the vault. */
export async function updateConnectionCredentials(
  id: string,
  credentials: Record<string, string>,
): Promise<void> {
  await api(`/connections/${encodeURIComponent(id)}/credentials`, 'PUT', { credentials });
}

/** POST /connections/:id/scrape — start a sync; returns the new run id for the
 *  status poll. Imperative — not a Query hook. */
export async function startConnectionScrape(
  id: string,
  opts: { monthsBack?: number; interactive?: boolean } = {},
): Promise<{ runId: string }> {
  return api<{ runId: string }>(`/connections/${encodeURIComponent(id)}/scrape`, 'POST', opts);
}
