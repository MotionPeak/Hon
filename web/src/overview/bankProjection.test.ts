import { describe, it, expect } from 'vitest';
import { classifyAccounts, projectBank } from './bankProjection';
import type { Account, Company } from '../accounts/types';
import type { Transaction } from '../activity/types';
import type { MerchantRow } from '../recurring/helpers';

const companies: Company[] = [
  { id: 'bank1', type: 'bank' } as Company,
  { id: 'card1', type: 'card' } as Company,
];
const accounts: Account[] = [
  { id: 'B', companyId: 'bank1', balance: 0, currency: 'ILS', excluded: false } as Account,
  { id: 'C', companyId: 'card1', balance: 0, currency: 'ILS', excluded: false } as Account,
];

function txn(p: Partial<Transaction>): Transaction {
  return {
    id: Math.random().toString(), accountId: 'B', date: thisCycleDate(), amount: 0,
    currency: 'ILS', description: 'x', category: 'Other', refundForId: null, ...p,
  } as Transaction;
}

// A date guaranteed to be in the current cycle (today).
function thisCycleDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(Math.min(d.getDate(), 28)).padStart(2, '0')}`;
}

function dueRow(category: string, cycleCharge: number): MerchantRow {
  // Only fields read by fixedDueNotYetPosted/cycleStatus matter here. A row with
  // NO current-cycle charge and a prior-cycle lastTxnDate is 'due'.
  const prior = new Date();
  prior.setMonth(prior.getMonth() - 1);
  const lastTxnDate = `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}-03`;
  return {
    category, cycleCharge, freq: 'monthly', cycles: new Set([
      `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}`,
    ]),
    lastTxnDate,
  } as unknown as MerchantRow;
}

describe('classifyAccounts', () => {
  it('maps accountId → bank/card via company type', () => {
    const m = classifyAccounts(accounts, companies);
    expect(m.get('B')).toBe('bank');
    expect(m.get('C')).toBe('card');
  });
});

describe('projectBank — fresh cycle', () => {
  it('bank 0, income 10000 unreceived, 2000 card, 5000 fixed due → 3000', () => {
    const out = projectBank({
      transactions: [txn({ accountId: 'C', amount: -2000, category: 'Shopping' })],
      accountType: classifyAccounts(accounts, companies),
      bankNow: 0, expectedIncome: 10000, owed: 0, piggies: 0, variableLeftToSpend: 0,
      rows: [dueRow('Housing', 5000)], monthStartDay: 1, mode: 'committed',
    });
    expect(out.cardSpendThisCycle).toBe(2000);
    expect(out.fixedDueNotYetPosted).toBe(5000);
    expect(out.incomeStillExpected).toBe(10000);
    expect(out.futureBank).toBe(3000);
  });
});

describe('projectBank — mid cycle, no double count', () => {
  it('salary landed + rent debited from bank, 2000 card pending → 3000', () => {
    const transactions = [
      txn({ accountId: 'B', amount: 10000, category: 'Salary' }),   // income already received to bank
      txn({ accountId: 'B', amount: -2000, category: 'Housing' }),  // rent already debited from bank
      txn({ accountId: 'C', amount: -2000, category: 'Shopping' }), // card pending
    ];
    const out = projectBank({
      transactions, accountType: classifyAccounts(accounts, companies),
      bankNow: 8000, expectedIncome: 10000, owed: 0, piggies: 0, variableLeftToSpend: 0,
      rows: [dueRow('Utilities', 3000)], monthStartDay: 1, mode: 'committed',
    });
    expect(out.incomeStillExpected).toBe(0);    // 10000 already received
    expect(out.cardSpendThisCycle).toBe(2000);
    expect(out.fixedDueNotYetPosted).toBe(3000);
    expect(out.futureBank).toBe(3000);
  });
});

describe('projectBank — refunds and non-ILS excluded', () => {
  it('ignores refund rows and non-ILS txns in the cycle sums', () => {
    const out = projectBank({
      transactions: [
        txn({ accountId: 'C', amount: -500, category: 'Shopping', refundForId: 'x' }), // refund → ignored
        txn({ accountId: 'C', amount: -300, currency: 'USD', category: 'Shopping' }),   // non-ILS → ignored
        txn({ accountId: 'B', amount: 999, currency: 'USD' }),                          // non-ILS income → ignored
      ],
      accountType: classifyAccounts(accounts, companies),
      bankNow: 100, expectedIncome: 0, owed: 0, piggies: 0, variableLeftToSpend: 0,
      rows: [], monthStartDay: 1, mode: 'committed',
    });
    expect(out.cardSpendThisCycle).toBe(0);
    expect(out.incomeStillExpected).toBe(0);
    expect(out.futureBank).toBe(100);
  });
});

describe('projectBank — + Variable budget mode', () => {
  it('subtracts variableLeftToSpend only in budget mode', () => {
    const base = {
      transactions: [], accountType: classifyAccounts(accounts, companies),
      bankNow: 1000, expectedIncome: 0, owed: 0, piggies: 0,
      variableLeftToSpend: 400, rows: [] as MerchantRow[], monthStartDay: 1,
    };
    expect(projectBank({ ...base, mode: 'committed' }).futureBank).toBe(1000);
    expect(projectBank({ ...base, mode: 'budget' }).futureBank).toBe(600);
  });

  it('owed lifts the balance; piggies lower it', () => {
    const out = projectBank({
      transactions: [], accountType: classifyAccounts(accounts, companies),
      bankNow: 0, expectedIncome: 0, owed: 250, piggies: 100, variableLeftToSpend: 0,
      rows: [], monthStartDay: 1, mode: 'committed',
    });
    expect(out.futureBank).toBe(150);
  });
});
