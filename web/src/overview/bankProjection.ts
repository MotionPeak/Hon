import type { Account, Company } from '../accounts/types';
import type { Transaction } from '../activity/types';
import { currentCycleKey, cycleKey } from '../cycle';
import { fixedDueNotYetPosted as sumFixedDue, type MerchantRow } from '../recurring/helpers';

export type AccountType = 'bank' | 'card' | 'other';
export type ProjectionMode = 'committed' | 'budget';

/** accountId → 'bank' | 'card' | 'other', via the account's company type. */
export function classifyAccounts(
  accounts: Account[], companies: Company[],
): Map<string, AccountType> {
  const typeByCompany = new Map<string, string>();
  for (const c of companies) typeByCompany.set(c.id, c.type);
  const out = new Map<string, AccountType>();
  for (const a of accounts) {
    const t = typeByCompany.get(a.companyId);
    out.set(a.id, t === 'bank' ? 'bank' : t === 'card' ? 'card' : 'other');
  }
  return out;
}

export interface BankProjectionInput {
  /**
   * Transactions to scan for this cycle's income/card flows. PRECONDITION: the
   * caller must exclude transactions from excluded accounts — this helper has no
   * visibility into the `excluded` flag.
   */
  transactions: Transaction[];
  accountType: Map<string, AccountType>;
  bankNow: number;
  expectedIncome: number;
  owed: number;
  piggies: number;
  /** ProjectedVariable.allowed (the Budget card's "left to spend"); clamped ≥ 0 here. */
  variableLeftToSpend: number;
  rows: MerchantRow[];
  monthStartDay: number;
  mode: ProjectionMode;
}

export interface BankProjection {
  futureBank: number;
  bankNow: number;
  incomeStillExpected: number;
  owed: number;
  cardSpendThisCycle: number;
  fixedDueNotYetPosted: number;
  piggies: number;
  variableLeftToSpend: number; // 0 in committed mode
}

/**
 * Projects the checking balance once this cycle's expected income has landed and
 * its commitments have cleared. Counts ONLY what is still to come: income not yet
 * received, the upcoming card bill, and fixed bills due-but-not-posted. Anything
 * already posted to a bank account is in `bankNow` and is never re-counted — this
 * is what keeps the number correct mid-cycle (no double counting of a salary that
 * already landed or a bill already debited).
 */
export function projectBank(input: BankProjectionInput): BankProjection {
  const cur = currentCycleKey(input.monthStartDay);
  const inCurrentCycle = (t: Transaction) => cycleKey(t.date, input.monthStartDay) === cur;

  let incomeReceived = 0;
  let cardSpendThisCycle = 0;
  for (const t of input.transactions) {
    if (t.currency !== 'ILS') continue;
    if (t.refundForId) continue;
    if (!inCurrentCycle(t)) continue;
    const type = input.accountType.get(t.accountId) ?? 'other';
    // Income counts only if it posted to a BANK account (not card or other/investment).
    if (type === 'bank' && t.amount > 0) incomeReceived += t.amount;
    if (type === 'card' && t.amount < 0) cardSpendThisCycle += -t.amount;
  }

  const incomeStillExpected = Math.max(0, input.expectedIncome - incomeReceived);
  const fixedDue = sumFixedDue(input.rows, input.monthStartDay);
  const piggies = Math.max(0, input.piggies);
  const variableLeftToSpend = input.mode === 'budget' ? Math.max(0, input.variableLeftToSpend) : 0;

  const futureBank =
    input.bankNow + incomeStillExpected + input.owed
    - cardSpendThisCycle - fixedDue - piggies - variableLeftToSpend;

  return {
    futureBank,
    bankNow: input.bankNow,
    incomeStillExpected,
    owed: input.owed,
    cardSpendThisCycle,
    fixedDueNotYetPosted: fixedDue,
    piggies,
    variableLeftToSpend,
  };
}
