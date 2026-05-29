// Web-side mirror of the sidecar Splitwise contract (sidecar/src/repo.ts +
// /splitwise/* routes). Splitwise ids are numeric; Hon transaction ids are
// strings.

export interface SplitwiseCounterparty {
  id: number;
  name: string;
  owed: number;
}

export interface SplitwiseLink {
  transactionId: string;
  expenseId: string;
  groupId: string | null;
  currency: string;
  owedToMe: number;
  counterparties: SplitwiseCounterparty[];
  paidAmount: number;
  /** 'open' | 'partial' | 'paid' */
  paidState: string;
  createdAt: string;
  syncedAt: string | null;
}

export interface SplitwiseUser {
  id: number;
  name: string;
}

export interface SplitwiseFriend {
  id: number;
  name: string;
}

export interface SplitwiseGroupMember {
  id: number;
  name: string;
}

export interface SplitwiseGroup {
  id: number;
  name: string;
  members: SplitwiseGroupMember[];
}

export interface SplitwisePickList {
  friends: SplitwiseFriend[];
  groups: SplitwiseGroup[];
  me: SplitwiseUser | null;
}

/** A friend with the balances the user is owed (from POST /splitwise/refresh). */
export interface SplitwiseFriendBalance {
  name: string;
  balances: { amount: number; currency: string }[];
}

/** One share line sent to POST /splitwise/expense. */
export interface SplitwiseShare {
  userId: number;
  name: string;
  owed: number;
}
