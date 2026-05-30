import type { SplitwiseLink } from './types';

export interface OwedFriend {
  id: number;
  name: string;
  currency: string;
  owed: number;
}

/**
 * Per-friend money still owed to the user, from Hon's own links
 * (`Σ owed − Σ paid` per counterparty+currency, positive only). This replaces
 * reading Splitwise's net friend balances, which settle-ups shrink on their side.
 */
export function owedByFriend(links: SplitwiseLink[]): OwedFriend[] {
  const acc = new Map<string, OwedFriend>();
  for (const link of links) {
    for (const cp of link.counterparties) {
      const remaining = Math.max(0, cp.owed - (cp.paid ?? 0));
      if (remaining <= 0.001) continue;
      const key = `${cp.id}|${link.currency}`;
      const cur = acc.get(key);
      if (cur) cur.owed += remaining;
      else acc.set(key, { id: cp.id, name: cp.name, currency: link.currency, owed: remaining });
    }
  }
  return [...acc.values()].map((f) => ({ ...f, owed: Math.round(f.owed * 100) / 100 }));
}
