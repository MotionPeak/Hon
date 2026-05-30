import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/db.js';
import { Repo } from '../src/repo.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-repo-'));
  const { db } = openDatabase(dir);
  return { repo: new Repo(db), db };
}

describe('migration 37 — splitwise_repayments', () => {
  it('bumps SCHEMA_VERSION to 37', () => {
    expect(SCHEMA_VERSION).toBe(37);
  });

  it('creates the splitwise_repayments table', () => {
    const { db } = makeRepo();
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='splitwise_repayments'",
      )
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('splitwise_repayments');
  });
});

describe('Repo — splitwise repayments', () => {
  const cp = (id: number, name: string, owed: number) => ({ id, name, owed });

  it('creates, lists, and deletes a repayment', () => {
    const { repo, db } = makeRepo();
    // FK requires a real transactions row; bypass for this unit test.
    db.pragma('foreign_keys = OFF');
    repo.createRepayment({
      transactionId: 'r1', counterpartyId: 2, counterpartyName: 'Roomie',
      currency: 'ILS', amount: 60,
    });
    db.pragma('foreign_keys = ON');
    expect(repo.listRepayments()).toEqual([
      expect.objectContaining({
        transactionId: 'r1', counterpartyId: 2, counterpartyName: 'Roomie',
        currency: 'ILS', amount: 60,
      }),
    ]);
    repo.deleteRepayment('r1');
    expect(repo.listRepayments()).toHaveLength(0);
  });

  it('getRepaymentPool sums amounts per counterparty+currency', () => {
    const { repo, db } = makeRepo();
    // FK requires real transactions rows; bypass for this unit test.
    db.pragma('foreign_keys = OFF');
    repo.createRepayment({ transactionId: 'r1', counterpartyId: 2, counterpartyName: 'A', currency: 'ILS', amount: 40 });
    repo.createRepayment({ transactionId: 'r2', counterpartyId: 2, counterpartyName: 'A', currency: 'ILS', amount: 25 });
    repo.createRepayment({ transactionId: 'r3', counterpartyId: 3, counterpartyName: 'B', currency: 'USD', amount: 10 });
    db.pragma('foreign_keys = ON');
    const pool = repo.getRepaymentPool();
    expect(pool.get('2|ILS')).toBe(65);
    expect(pool.get('3|USD')).toBe(10);
  });

  it('updateSplitwiseLinkPaid persists paid_amount, state, and counterparties JSON', () => {
    const { repo, db } = makeRepo();
    // FK requires a real transactions row; bypass for this unit test.
    db.pragma('foreign_keys = OFF');
    repo.createSplitwiseLink({
      transactionId: 'e1', expenseId: 'x1', groupId: null, currency: 'ILS',
      owedToMe: 60, counterparties: [cp(2, 'Roomie', 60)],
    });
    db.pragma('foreign_keys = ON');
    repo.updateSplitwiseLinkPaid('e1', 60, 'paid', [{ ...cp(2, 'Roomie', 60), paid: 60 }]);
    const link = repo.getSplitwiseLink('e1')!;
    expect(link.paidAmount).toBe(60);
    expect(link.paidState).toBe('paid');
    expect(link.counterparties[0].paid).toBe(60);
  });
});
