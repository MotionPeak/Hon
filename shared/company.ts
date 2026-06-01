// Shared zod schema for a Company (an institution Hon can connect — bank,
// card, brokerage, pension). Returned by GET /companies. Single source of
// truth for the engine + web.

import { z } from 'zod';

export const companyTypeSchema = z.enum(['bank', 'card', 'brokerage', 'pension']);
export type CompanyType = z.infer<typeof companyTypeSchema>;

export const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  loginFields: z.array(z.string()),
  type: companyTypeSchema,
  domain: z.string().optional(),
  interactive: z.boolean().optional(),
});
export type Company = z.infer<typeof companySchema>;

export const companiesResponseSchema = z.object({ companies: z.array(companySchema) });
