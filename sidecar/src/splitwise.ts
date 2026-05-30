// Splitwise integration — creates expenses from Hon transactions and tracks
// what others owe back. Splitwise has no webhooks and no per-expense settle
// flag, so the paid state is inferred on each refresh by matching settle-up
// payment records to the linked expenses, oldest first.

import type { Repo, SplitwiseCounterparty, SplitwiseLink } from './repo.js';

// --- Pure allocation helpers -------------------------------------------------

export interface PaidResult {
  transactionId: string;
  paidAmount: number;
  paidState: 'open' | 'partial' | 'paid';
  counterparties: SplitwiseCounterparty[];
}

/**
 * Pure allocation: consume each person's repayment pool against their linked
 * expenses oldest-first, setting per-counterparty `paid`. `pool` is keyed
 * `counterpartyId|currency`. Splitwise tracks debt per person, not per expense,
 * so oldest-first is the honest approximation.
 */
export function allocatePayments(
  links: SplitwiseLink[],
  pool: Map<string, number>,
): PaidResult[] {
  const remaining = new Map(pool);
  const ordered = [...links].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const results: PaidResult[] = [];
  for (const link of ordered) {
    let paid = 0;
    const counterparties = link.counterparties.map((cp) => {
      const key = `${cp.id}|${link.currency}`;
      const available = remaining.get(key) ?? 0;
      const take = Math.min(cp.owed, available);
      if (take > 0) {
        remaining.set(key, available - take);
        paid += take;
      }
      return { ...cp, paid: Math.round(take * 100) / 100 };
    });
    paid = Math.round(paid * 100) / 100;
    const paidState: PaidResult['paidState'] =
      paid >= link.owedToMe - 0.01 ? 'paid' : paid > 0.01 ? 'partial' : 'open';
    results.push({ transactionId: link.transactionId, paidAmount: paid, paidState, counterparties });
  }
  return results;
}

// --- API constants -----------------------------------------------------------

const API_BASE = 'https://secure.splitwise.com/api/v3.0';

// --- Wire types — the subset of the Splitwise API that Hon reads ------------

interface SwBalance {
  currency_code: string;
  amount: string;
}
interface SwPerson {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}
interface SwFriend extends SwPerson {
  balance?: SwBalance[];
}
interface SwGroup {
  id: number;
  name: string;
  members?: SwPerson[];
}
// --- HTTP -------------------------------------------------------------------

class SplitwiseError extends Error {}

async function swRequest<T>(
  apiKey: string,
  path: string,
  init?: { method?: string; form?: Record<string, string> },
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  let body: string | undefined;
  if (init?.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body,
    });
  } catch (err) {
    throw new SplitwiseError(
      `Could not reach Splitwise: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new SplitwiseError('Splitwise rejected the API key — check it and reconnect.');
  }
  if (res.status === 429) {
    throw new SplitwiseError('Splitwise is rate-limiting Hon. Try again in a minute.');
  }
  if (!res.ok) {
    throw new SplitwiseError(`Splitwise request failed (HTTP ${res.status}).`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new SplitwiseError('Splitwise returned an unreadable response.');
  }
}

/** A display name for a Splitwise person, falling back to email then id. */
function personName(p: SwPerson): string {
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  return full || (p.email ?? '').trim() || `User ${p.id}`;
}

// --- Account ----------------------------------------------------------------

export interface SplitwiseUser {
  id: number;
  name: string;
}

/** Verifies an API key and returns the account it belongs to. */
export async function verifyKey(apiKey: string): Promise<SplitwiseUser> {
  const data = await swRequest<{ user?: SwPerson }>(apiKey, '/get_current_user');
  if (!data.user?.id) {
    throw new SplitwiseError('Splitwise did not return your account.');
  }
  return { id: data.user.id, name: personName(data.user) };
}

// --- The friend / group picker ---------------------------------------------

export interface SplitwisePickList {
  friends: { id: number; name: string }[];
  groups: { id: number; name: string; members: { id: number; name: string }[] }[];
}

/** Friends and groups the user can split an expense with. */
export async function fetchPickList(apiKey: string): Promise<SplitwisePickList> {
  const [friendsData, groupsData] = await Promise.all([
    swRequest<{ friends?: SwFriend[] }>(apiKey, '/get_friends'),
    swRequest<{ groups?: SwGroup[] }>(apiKey, '/get_groups'),
  ]);
  return {
    friends: (friendsData.friends ?? []).map((f) => ({ id: f.id, name: personName(f) })),
    groups: (groupsData.groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      members: (g.members ?? []).map((m) => ({ id: m.id, name: personName(m) })),
    })),
  };
}

// --- Creating an expense ----------------------------------------------------

interface ExpenseShare {
  userId: number;
  paidShare: number;
  owedShare: number;
}

export interface SplitPlan {
  users: ExpenseShare[];
  owedToMe: number;
  counterparties: SplitwiseCounterparty[];
}

/**
 * Turns the chosen per-person owed amounts into a Splitwise `users` array. The
 * user paid the whole expense; everyone else owes their stated share and the
 * user owes whatever is left — so the shares always sum exactly to `cost`,
 * which Splitwise requires.
 */
export function planSplit(
  cost: number,
  myId: number,
  others: { id: number; name: string; owed: number }[],
): SplitPlan {
  const costCents = Math.round(cost * 100);
  const counterparties: SplitwiseCounterparty[] = [];
  const others_: ExpenseShare[] = [];
  let othersCents = 0;
  for (const o of others) {
    const cents = Math.round(o.owed * 100);
    if (cents < 0) throw new Error('A share cannot be negative.');
    othersCents += cents;
    counterparties.push({ id: o.id, name: o.name, owed: cents / 100 });
    others_.push({ userId: o.id, paidShare: 0, owedShare: cents / 100 });
  }
  if (othersCents > costCents) {
    throw new Error('The shares add up to more than the expense.');
  }
  const me: ExpenseShare = {
    userId: myId,
    paidShare: costCents / 100,
    owedShare: (costCents - othersCents) / 100,
  };
  return { users: [me, ...others_], owedToMe: othersCents / 100, counterparties };
}

/** Splitwise wants an ISO 8601 datetime; Hon transaction dates may be date-only. */
function normalizeDate(date: string): string {
  return /T/.test(date) ? date : `${date}T12:00:00Z`;
}

/** Pulls any human-readable messages out of a create_expense `errors` object. */
function describeErrors(errors: unknown): string | null {
  if (!errors || typeof errors !== 'object') return null;
  const messages: string[] = [];
  for (const value of Object.values(errors as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const m of value) if (typeof m === 'string') messages.push(m);
    } else if (typeof value === 'string') {
      messages.push(value);
    }
  }
  return messages.length ? messages.join(' ') : null;
}

/** Creates a Splitwise expense and returns its id. */
export async function createExpense(
  apiKey: string,
  input: {
    cost: number;
    description: string;
    date: string;
    currencyCode: string;
    groupId: number;
    users: ExpenseShare[];
  },
): Promise<string> {
  const form: Record<string, string> = {
    cost: input.cost.toFixed(2),
    description: input.description,
    currency_code: input.currencyCode,
    date: normalizeDate(input.date),
    group_id: String(input.groupId),
  };
  input.users.forEach((u, i) => {
    form[`users__${i}__user_id`] = String(u.userId);
    form[`users__${i}__paid_share`] = u.paidShare.toFixed(2);
    form[`users__${i}__owed_share`] = u.owedShare.toFixed(2);
  });

  const data = await swRequest<{ expenses?: { id?: number }[]; errors?: unknown }>(
    apiKey,
    '/create_expense',
    { method: 'POST', form },
  );
  // Splitwise returns HTTP 200 even on a logical failure — the `errors` object
  // is the real success signal.
  const errorText = describeErrors(data.errors);
  if (errorText) throw new SplitwiseError(errorText);
  const id = data.expenses?.[0]?.id;
  if (!id) throw new SplitwiseError('Splitwise did not return the new expense.');
  return String(id);
}

/** Deletes a Splitwise expense — throws if Splitwise reports it could not. */
export async function deleteExpense(apiKey: string, expenseId: string): Promise<void> {
  const data = await swRequest<{ success?: boolean; errors?: unknown }>(
    apiKey,
    `/delete_expense/${encodeURIComponent(expenseId)}`,
    { method: 'POST' },
  );
  const errorText = describeErrors(data.errors);
  if (errorText) throw new SplitwiseError(errorText);
  if (data.success === false) {
    throw new SplitwiseError('Splitwise would not delete the expense.');
  }
}

// --- Refresh: balances + paid-state inference -------------------------------

export interface SplitwiseFriendBalance {
  id: number;
  name: string;
  balances: { currency: string; amount: number }[];
}

export interface SplitwiseRefresh {
  friends: SplitwiseFriendBalance[];
  links: SplitwiseLink[];
}

/**
 * Refreshes per-friend balances (for the picker) and recomputes paid-state from
 * the user's linked repayment transactions. Splitwise's own settle-up flag is no
 * longer trusted — only real repayments the user marked move a split toward paid.
 */
export async function refreshSplitwise(
  apiKey: string,
  repo: Repo,
): Promise<SplitwiseRefresh> {
  const friendsData = await swRequest<{ friends?: SwFriend[] }>(apiKey, '/get_friends');
  const friends: SplitwiseFriendBalance[] = (friendsData.friends ?? []).map((f) => ({
    id: f.id,
    name: personName(f),
    balances: (f.balance ?? [])
      .map((b) => ({ currency: b.currency_code, amount: Number(b.amount) || 0 }))
      .filter((b) => b.amount !== 0),
  }));
  recomputePaidStates(repo);
  return { friends, links: repo.listSplitwiseLinks() };
}

/** Recomputes every link's paid-state from the local repayment pool. */
export function recomputePaidStates(repo: Repo): void {
  const links = repo.listSplitwiseLinks();
  if (links.length === 0) return;
  const pool = repo.getRepaymentPool();
  for (const r of allocatePayments(links, pool)) {
    repo.updateSplitwiseLinkPaid(r.transactionId, r.paidAmount, r.paidState, r.counterparties);
  }
}
