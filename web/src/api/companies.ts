// Companies API module — owns GET /companies (the Add Account institution
// catalog). Response parsed through the shared schema.

import { companiesResponseSchema, type Company } from '@hon/shared/company';
import { api } from './client';

/** GET /companies → the institution catalog for the Add Account picker. */
export async function listCompanies(): Promise<Company[]> {
  const data = await api<unknown>('/companies');
  return companiesResponseSchema.parse(data).companies;
}
