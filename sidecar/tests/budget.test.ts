import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { buildBudgetReport, type MonthRange } from '../src/budget.js';

function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'hon-budget-'));
  const { db } = openDatabase(dir);
  return new Repo(db);
}

// Seeds a single ILS salary credit inside the June cycle and pins it to the
// Income category, so monthlyInflow counts it as posted income.
function seedSalary(repo: Repo, amount: number): void {
  const conn = repo.createConnection('beinleumi', 'Beinleumi');
  repo.saveScrapeResult(conn.id, [{
    accountNumber: '1', currency: 'ILS', balance: 0,
    transactions: [
      { externalId: 'salary', date: '2026-06-05', amount, currency: 'ILS', description: 'Salary' },
    ],
  }]);
  const txn = repo.listTransactions({}).find((t) => t.externalId === 'salary');
  if (!txn) throw new Error('seed failed: salary txn not found');
  repo.updateTransactionCategory(txn.id, 'Income');
}

const JUNE: MonthRange = { start: '2026-06-01', end: '2026-07-01', label: '2026-06' };

describe('buildBudgetReport — expected-income override', () => {
  // Fixed mid-June clock so any current-cycle math is stable on a month boundary.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-15T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses posted inflow as income when no override is supplied', () => {
    const repo = makeRepo();
    seedSalary(repo, 8000);
    const report = buildBudgetReport(repo, JUNE);
    expect(report.variable.income).toBe(8000);
  });

  it('replaces income with the expected-income override when supplied', () => {
    const repo = makeRepo();
    seedSalary(repo, 8000); // only ₪8,000 has actually landed…
    const report = buildBudgetReport(repo, JUNE, { expectedIncome: 20000 });
    // …but the user expects ₪20,000 this cycle, so the whole variable budget —
    // income, disposable and allowed — is built on that figure.
    expect(report.variable.income).toBe(20000);
    expect(report.variable.disposable).toBe(20000 - report.variable.committed);
  });
});
