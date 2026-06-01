// Shared zod schema for GET /summary — the net-worth headline payload.
// Single source of truth for the response shape (engine assembles it in
// server.ts `/summary`; the web app parses it through this schema). Mirrors
// repo.summary() fields + the route's recomputed byCurrency / netWorthILS /
// sources, so backend/frontend drift fails loudly in dev.

import { z } from 'zod';

/** One per-currency net-worth bucket. `total` already folds in loan debt for
 *  that currency (negative reduces the bucket). */
export const currencyTotalSchema = z.object({
  currency: z.string(),
  total: z.number(),
  accountCount: z.number(),
});
export type CurrencyTotal = z.infer<typeof currencyTotalSchema>;

/** One net-worth source bucket — `bank` / `card` / `brokerage` / `pension` /
 *  `loan`, or `asset:<kind>`; converted to ILS. Negative for debt. */
export const netWorthSourceSchema = z.object({
  key: z.string(),
  amount: z.number(),
});
export type NetWorthSource = z.infer<typeof netWorthSourceSchema>;

/** The `/summary` payload (the engine wraps it as `{ summary }`). */
export const summarySchema = z.object({
  connectionCount: z.number(),
  accountCount: z.number(),
  manualAssetCount: z.number(),
  voucherCount: z.number(),
  byCurrency: z.array(currencyTotalSchema),
  /** Single ILS-converted figure; null when the FX lookup failed (the UI then
   *  falls back to the per-currency breakdown). */
  netWorthILS: z.number().nullable(),
  sources: z.array(netWorthSourceSchema),
});
export type Summary = z.infer<typeof summarySchema>;

export const summaryResponseSchema = z.object({ summary: summarySchema });
