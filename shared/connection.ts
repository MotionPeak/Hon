// Shared zod schema for a Connection (a linked institution login that owns one
// or more accounts). Returned by GET /connections. Single source of truth for
// the engine + web.

import { z } from 'zod';

export const connectionSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  lastScrapeAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  hasCredentials: z.boolean(),
  /** Months of transaction history to fetch each sync. Default 12; range [1, 24]. */
  historyMonths: z.number(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionsResponseSchema = z.object({ connections: z.array(connectionSchema) });
