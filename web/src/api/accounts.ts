// Accounts API module — owns GET /accounts and the manual balance / exclude
// writes. The list is parsed STRICTLY through the shared schema so drift fails
// loudly in dev. Write bodies are small and typed at the call boundary.

import { accountsResponseSchema, type Account } from '@hon/shared/account';
import { api } from './client';

/** GET /accounts → every account across all connections. */
export async function listAccounts(): Promise<Account[]> {
  const data = await api<unknown>('/accounts');
  return accountsResponseSchema.parse(data).accounts;
}

/** PATCH /accounts/:id/balance — set a manual balance (cards report none). */
export async function setAccountBalance(id: string, balance: number): Promise<void> {
  await api(`/accounts/${encodeURIComponent(id)}/balance`, 'PATCH', { balance });
}

/** PATCH /accounts/:id/excluded — include/exclude one account from net worth. */
export async function setAccountExcluded(id: string, excluded: boolean): Promise<void> {
  await api(`/accounts/${encodeURIComponent(id)}/excluded`, 'PATCH', { excluded });
}
