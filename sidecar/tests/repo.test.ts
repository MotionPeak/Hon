import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-repo-'));
  const { db } = openDatabase(dir);
  const repo = new Repo(db);
  return { repo, db };
}

describe('Connection.historyMonths', () => {
  it('getConnection returns historyMonths', () => {
    const { repo } = makeRepo();
    const c = repo.createConnection('hapoalim', 'Hapoalim');
    const fetched = repo.getConnection(c.id);
    expect(fetched?.historyMonths).toBe(12);
  });

  it('listConnections returns historyMonths', () => {
    const { repo } = makeRepo();
    repo.createConnection('hapoalim', 'Hapoalim');
    const all = repo.listConnections();
    expect(all).toHaveLength(1);
    expect(all.every((c) => c.historyMonths === 12)).toBe(true);
  });
});

describe('listTransactions limit', () => {
  function seed(repo: Repo, count: number) {
    const conn = repo.createConnection('max', 'Max');
    const transactions = Array.from({ length: count }, (_, i) => ({
      externalId: `tx-${i}`,
      // Spread across days so date DESC ordering is well-defined.
      date: new Date(2024, 0, 1 + i).toISOString().slice(0, 10),
      amount: -10 - i,
      currency: 'ILS',
      description: `merchant ${i}`,
    }));
    repo.saveScrapeResult(conn.id, [
      { accountNumber: '1234', currency: 'ILS', balance: 0, transactions },
    ]);
  }

  it('returns ALL rows when no limit is given (full history for month pickers)', () => {
    const { repo } = makeRepo();
    seed(repo, 250);
    expect(repo.listTransactions({})).toHaveLength(250);
  });

  it('still paginates when an explicit limit is passed', () => {
    const { repo } = makeRepo();
    seed(repo, 250);
    expect(repo.listTransactions({ limit: 50 })).toHaveLength(50);
  });
});

describe('setConnectionHistoryMonths', () => {
  it('persists the new value', () => {
    const { repo } = makeRepo();
    const c = repo.createConnection('hapoalim', 'Hapoalim');
    const updated = repo.setConnectionHistoryMonths(c.id, 18);
    expect(updated.historyMonths).toBe(18);
    expect(repo.getConnection(c.id)?.historyMonths).toBe(18);
  });

  it('rejects values below 1', () => {
    const { repo } = makeRepo();
    const c = repo.createConnection('hapoalim', 'Hapoalim');
    expect(() => repo.setConnectionHistoryMonths(c.id, 0)).toThrow(/range/i);
    expect(() => repo.setConnectionHistoryMonths(c.id, -1)).toThrow(/range/i);
  });

  it('rejects values above 24', () => {
    const { repo } = makeRepo();
    const c = repo.createConnection('hapoalim', 'Hapoalim');
    expect(() => repo.setConnectionHistoryMonths(c.id, 25)).toThrow(/range/i);
    expect(() => repo.setConnectionHistoryMonths(c.id, 99)).toThrow(/range/i);
  });

  it('rejects non-integer values', () => {
    const { repo } = makeRepo();
    const c = repo.createConnection('hapoalim', 'Hapoalim');
    expect(() => repo.setConnectionHistoryMonths(c.id, 12.5)).toThrow(/integer/i);
  });

  it('throws on unknown connection id', () => {
    const { repo } = makeRepo();
    expect(() => repo.setConnectionHistoryMonths('does-not-exist', 12))
      .toThrow(/not found/i);
  });
});

describe('analytics exclude patterns', () => {
  function seedSpending(repo: Repo) {
    const conn = repo.createConnection('beinleumi', 'Beinleumi');
    repo.saveScrapeResult(conn.id, [{
      accountNumber: '1', currency: 'ILS', balance: 0,
      transactions: [
        { externalId: 'a', date: '2026-05-02', amount: -100, currency: 'ILS', description: 'Cafe' },
        { externalId: 'b', date: '2026-05-03', amount: -9461, currency: 'ILS', description: 'מקס איט פיננסים' },
        { externalId: 'c', date: '2026-05-04', amount: 5000, currency: 'ILS', description: 'Salary' },
      ],
    }]);
  }

  it('monthlyTotals excludes matching descriptions', () => {
    const { repo } = makeRepo();
    seedSpending(repo);
    const base = repo.monthlyTotals('2026-05-01').find((m) => m.month === '2026-05');
    const excl = repo.monthlyTotals('2026-05-01', ['מקס איט']).find((m) => m.month === '2026-05');
    expect(base?.spending).toBe(9561);
    expect(excl?.spending).toBe(100);
  });

  it('categorySpending excludes matching descriptions', () => {
    const { repo } = makeRepo();
    seedSpending(repo);
    const total = (rows: { total: number }[]) => rows.reduce((s, r) => s + r.total, 0);
    expect(total(repo.categorySpending('2026-05-01', '2026-06-01'))).toBe(9561);
    expect(total(repo.categorySpending('2026-05-01', '2026-06-01', ['מקס איט']))).toBe(100);
  });

  it('expenseStats excludes matching descriptions', () => {
    const { repo } = makeRepo();
    seedSpending(repo);
    expect(repo.expenseStats('2026-05-01', '2026-06-01').count).toBe(2);
    expect(repo.expenseStats('2026-05-01', '2026-06-01', ['מקס איט']).count).toBe(1);
  });

  it('treats LIKE metacharacters in exclude patterns literally (no wildcard leak)', () => {
    const { repo } = makeRepo();
    const conn = repo.createConnection('max', 'Max');
    repo.saveScrapeResult(conn.id, [{
      accountNumber: '1', currency: 'ILS', balance: 0,
      transactions: [
        { externalId: 'lit', date: '2026-05-02', amount: -100, currency: 'ILS', description: 'visa_direct shop' },
        { externalId: 'wild', date: '2026-05-03', amount: -50, currency: 'ILS', description: 'visaxdirect shop' },
      ],
    }]);
    const total = (rows: { total: number }[]) => rows.reduce((s, r) => s + r.total, 0);
    // The '_' in the pattern must match a literal underscore, NOT any single
    // char — so 'visaxdirect' (50) is NOT excluded; only the literal row (100).
    expect(total(repo.categorySpending('2026-05-01', '2026-06-01', ['visa_direct']))).toBe(50);
  });
});

describe('snaptrade performance-disabled marker', () => {
  it('round-trips and clears', () => {
    const { repo } = makeRepo();
    expect(repo.getPerformanceDisabledAt('conn1')).toBeNull();
    repo.setPerformanceDisabled('conn1', '2026-05-30T10:00:00.000Z');
    expect(repo.getPerformanceDisabledAt('conn1')).toBe('2026-05-30T10:00:00.000Z');
    repo.setPerformanceDisabled('conn1', null);
    expect(repo.getPerformanceDisabledAt('conn1')).toBeNull();
  });
  it('is scoped per connection', () => {
    const { repo } = makeRepo();
    repo.setPerformanceDisabled('connA', '2026-05-30T10:00:00.000Z');
    expect(repo.getPerformanceDisabledAt('connB')).toBeNull();
  });
});

describe('applyMerchantRule', () => {
  it('only flips uncategorized rows, leaving hand-categorized ones intact (H-4)', () => {
    const { repo } = makeRepo();
    const conn = repo.createConnection('wolt', 'Wolt');
    repo.saveScrapeResult(conn.id, [{
      accountNumber: '1', currency: 'ILS', balance: 0,
      transactions: [
        { externalId: 'tx-categorized', date: '2026-05-02', amount: -50, currency: 'ILS', description: 'WOLT' },
        { externalId: 'tx-uncategorized', date: '2026-05-03', amount: -75, currency: 'ILS', description: 'WOLT' },
      ],
    }]);

    // Hand-categorize exactly one of the two WOLT rows. updateTransactionCategory
    // is the real method the UI uses when the user moves a txn by hand.
    const handPicked = repo.listTransactions({}).find((t) => t.externalId === 'tx-categorized');
    expect(handPicked).toBeTruthy();
    repo.updateTransactionCategory(handPicked!.id, 'Groceries');

    // Apply a merchant rule for WOLT -> Dining.
    const changed = repo.applyMerchantRule('WOLT', 'Dining');

    // Only the still-uncategorized row should flip; the hand-categorized one stays.
    expect(changed).toBe(1);

    const rows = repo.listTransactions({});
    const cat = rows.find((t) => t.externalId === 'tx-categorized');
    const unc = rows.find((t) => t.externalId === 'tx-uncategorized');
    expect(cat?.category).toBe('Groceries');
    expect(unc?.category).toBe('Dining');
  });
});

describe('savings mark', () => {
  /** Seed one transaction and return its id. */
  function seedTxn(
    repo: Repo,
    opts: { externalId: string; date: string; amount: number; description: string },
  ): string {
    const conn = repo.createConnection('hapoalim', 'Hapoalim');
    repo.saveScrapeResult(conn.id, [
      {
        accountNumber: '9999',
        currency: 'ILS',
        balance: 0,
        transactions: [
          {
            externalId: opts.externalId,
            date: opts.date,
            amount: opts.amount,
            currency: 'ILS',
            description: opts.description,
          },
        ],
      },
    ]);
    const rows = repo.listTransactions({});
    const row = rows.find((r) => r.externalId === opts.externalId);
    if (!row) throw new Error('seeded txn not found');
    return row.id;
  }

  it('setTransactionSavings(true) sets savings=1 and clears excluded_manual even if it was set', () => {
    const { repo } = makeRepo();
    const id = seedTxn(repo, { externalId: 'sv-1', date: '2026-05-10', amount: -1000, description: 'Transfer to savings' });
    // Pre-mark as excluded
    repo.setTransactionExcluded(id, true);
    // Now mark as savings — should flip savings=1 and clear excluded_manual
    repo.setTransactionSavings(id, true);
    const row = repo.getTransaction(id);
    expect(row?.savings).toBe(true);
    expect(row?.excludedManual).toBeNull();
  });

  it('setTransactionExcluded(true) clears a prior savings mark', () => {
    const { repo } = makeRepo();
    const id = seedTxn(repo, { externalId: 'sv-2', date: '2026-05-11', amount: -500, description: 'Transfer again' });
    repo.setTransactionSavings(id, true);
    // Now exclude — should flip excludedManual=1 and clear savings=0
    repo.setTransactionExcluded(id, true);
    const row = repo.getTransaction(id);
    expect(row?.savings).toBe(false);
    expect(row?.excludedManual).toBe(true);
  });

  it('monthlySpending excludes savings-marked rows', () => {
    const { repo } = makeRepo();
    const conn = repo.createConnection('beinleumi', 'Beinleumi');
    repo.saveScrapeResult(conn.id, [
      {
        accountNumber: '5555',
        currency: 'ILS',
        balance: 0,
        transactions: [
          { externalId: 'ms-1', date: '2026-05-15', amount: -500, currency: 'ILS', description: 'Shopping trip' },
          { externalId: 'ms-2', date: '2026-05-20', amount: -1000, currency: 'ILS', description: 'Savings transfer' },
        ],
      },
    ]);
    // Assign categories so monthlySpending picks them up
    repo.updateTransactionCategory(
      repo.listTransactions({}).find((r) => r.externalId === 'ms-1')!.id,
      'Shopping',
    );
    const savingsId = repo.listTransactions({}).find((r) => r.externalId === 'ms-2')!.id;
    repo.updateTransactionCategory(savingsId, 'Transfers');
    repo.setTransactionSavings(savingsId, true);

    const rows = repo.monthlySpending('2026-05-01', '2026-06-01');
    const total = rows.reduce((s, r) => s + r.total, 0);
    expect(total).toBe(500);
  });
});

describe('txn_effective — dual-role transaction (migration 39)', () => {
  it('reflects BOTH the refund it received and the amount it was used as a refund for', () => {
    const { repo, db } = makeRepo();
    const conn = repo.createConnection('beinleumi', 'Dual');
    repo.saveScrapeResult(conn.id, [{
      accountNumber: '1', currency: 'ILS', balance: 0,
      transactions: [
        { externalId: 'E', date: '2026-05-10', amount: -200, currency: 'ILS', description: 'E' },
        { externalId: 'X', date: '2026-05-10', amount: -100, currency: 'ILS', description: 'X' },
        { externalId: 'R', date: '2026-05-10', amount: 30, currency: 'ILS', description: 'R' },
      ],
    }]);
    const idOf = (ext: string): string =>
      repo.listTransactions({}).find((r) => r.externalId === ext)!.id;
    const e = idOf('E');
    const x = idOf('X');
    const r = idOf('R');

    // X is refunded by R (X is the expense side) AND X is itself used as a
    // refund for E (X is the refund side) — the dual role the old view got wrong.
    repo.setTransactionLink(x, r, 30);
    repo.setTransactionLink(e, x, 20);

    const eff = (id: string): number =>
      (db.prepare('SELECT amount FROM txn_effective WHERE id = ?').get(id) as
        { amount: number } | undefined)?.amount ?? NaN;

    // X: -100 original + 30 refund received - (-20 used as refund, toward zero
    // for a negative amount) = -50. The old branch-exclusive view returned -80,
    // ignoring the 30 refund.
    expect(eff(x)).toBeCloseTo(-50, 5);
    // E received a 20 refund from X: -200 + 20 = -180.
    expect(eff(e)).toBeCloseTo(-180, 5);
  });
});

describe('listTransactions reimbursement net fields', () => {
  function seedExpenseAndRefunds(repo: Repo) {
    const conn = repo.createConnection('max', 'Max');
    repo.saveScrapeResult(conn.id, [
      {
        accountNumber: '1234', currency: 'ILS', balance: 0,
        transactions: [
          { externalId: 'exp', date: '2026-06-07', amount: -7500, currency: 'ILS', description: 'Catering' },
          { externalId: 'rf1', date: '2026-06-07', amount: 3000, currency: 'ILS', description: 'Reimb A' },
          { externalId: 'rf2', date: '2026-06-07', amount: 2250, currency: 'ILS', description: 'Reimb B' },
        ],
      },
    ]);
    const rows = repo.listTransactions({});
    const expense = rows.find((r) => r.amount === -7500)!;
    const rf1 = rows.find((r) => r.amount === 3000)!;
    const rf2 = rows.find((r) => r.amount === 2250)!;
    return { expense, rf1, rf2 };
  }

  it('nets multiple reimbursements into the expense', () => {
    const { repo } = makeRepo();
    const { expense, rf1, rf2 } = seedExpenseAndRefunds(repo);
    repo.setTransactionLink(expense.id, rf1.id, 3000);
    repo.setTransactionLink(expense.id, rf2.id, 2250);

    const exp = repo.listTransactions({}).find((r) => r.id === expense.id)!;
    expect(exp.reimbursedTotal).toBe(5250);
    expect(exp.reimbursementCount).toBe(2);
    expect(exp.effectiveAmount).toBe(-2250);
  });

  it('leaves un-reimbursed rows unchanged (effectiveAmount === amount)', () => {
    const { repo } = makeRepo();
    const { expense, rf1 } = seedExpenseAndRefunds(repo);
    const exp = repo.listTransactions({}).find((r) => r.id === expense.id)!;
    expect(exp.reimbursedTotal).toBe(0);
    expect(exp.reimbursementCount).toBe(0);
    expect(exp.effectiveAmount).toBe(-7500);
    const refund = repo.listTransactions({}).find((r) => r.id === rf1.id)!;
    expect(refund.reimbursedTotal).toBe(0);
  });

  it('effectiveAmount matches the txn_effective view (single source of truth)', () => {
    const { repo, db } = makeRepo();
    const { expense, rf1, rf2 } = seedExpenseAndRefunds(repo);
    repo.setTransactionLink(expense.id, rf1.id, 3000);
    repo.setTransactionLink(expense.id, rf2.id, 2250);
    const exp = repo.listTransactions({}).find((r) => r.id === expense.id)!;
    const view = db.prepare('SELECT amount FROM txn_effective WHERE id = ?').get(expense.id) as { amount: number };
    expect(exp.effectiveAmount).toBeCloseTo(view.amount, 5);
  });
});
