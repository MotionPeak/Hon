// Shared zod schema for a Connection (a linked institution login that owns one
// or more accounts). Returned by GET /connections. Single source of truth for
// the engine + web.

import { z } from 'zod';

/** A non-terminal scrape run in flight for a connection, surfaced on the
 *  connection so the UI can restore sync progress (and the OTP prompt) after a
 *  navigation/remount without having kept the runId. null when nothing runs. */
export const activeRunSchema = z.object({
  runId: z.string(),
  connectionId: z.string(),
  status: z.enum(['running', 'needs-otp', 'success', 'error']),
  message: z.string(),
  accountsCount: z.number(),
  transactionsCount: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type ActiveRun = z.infer<typeof activeRunSchema>;

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
  /** The in-flight run for this connection, if any (else null/absent). */
  activeRun: activeRunSchema.nullable().optional(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionsResponseSchema = z.object({ connections: z.array(connectionSchema) });
