// Shared zod schema for an Account (one account on a connected institution).
// Returned by GET /accounts. Single source of truth for the engine + web.

import { z } from 'zod';

export const accountSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  companyId: z.string(),
  connectionName: z.string(),
  accountNumber: z.string(),
  label: z.string().nullable(),
  balance: z.number().nullable(),
  currency: z.string(),
  updatedAt: z.string(),
  excluded: z.boolean(),
  inceptionDate: z.string().nullable(),
});
export type Account = z.infer<typeof accountSchema>;

export const accountsResponseSchema = z.object({ accounts: z.array(accountSchema) });
