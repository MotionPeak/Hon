// Summary API module — owns GET /summary. The engine wraps the payload as
// `{ summary }`; we parse it through the shared schema so backend/frontend
// drift fails loudly in dev instead of silently rendering a wrong net worth.

import { summaryResponseSchema, type Summary } from '@hon/shared/summary';
import { api } from './client';

/** GET /summary → net-worth headline: per-currency totals, the ILS total, the
 *  source breakdown, and the account/connection/asset/voucher counts. */
export async function getSummary(): Promise<Summary> {
  const data = await api<unknown>('/summary');
  return summaryResponseSchema.parse(data).summary;
}
