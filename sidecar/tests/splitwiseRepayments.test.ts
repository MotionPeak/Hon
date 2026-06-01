import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { recomputePaidStates } from '../src/splitwise.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-repo-'));
  const { db } = openDatabase(dir);
  return { repo: new Repo(db), db };
}

/**
 * Seeds `n` real ILS transactions and returns their ids, so repayment / link
 * rows satisfy the transactions FK instead of running with foreign_keys OFF —
 * exercising the join path the production inserts actually take.
 */
function seedTxnIds(repo: Repo, n: number): string[] {
  const conn = repo.createConnection('beinleumi', 'Beinleumi');
  repo.saveScrapeResult(conn.id, [{
    accountNumber: '1', currency: 'ILS', balance: 0,
    transactions: Array.from({ length: n }, (_, i) => ({
      externalId: `seed-${i}`, date: '2026-05-01', amount: -50,
      currency: 'ILS', description: `Seed ${i}`,
    })),
  }]);
  return repo.listTransactions({}).map((t) => t.id);
}

describe('migration 37 — splitwise_repayments', () => {
  it('bumps SCHEMA_VERSION to at least 37', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(37);
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
    const { repo } = makeRepo();
    const [t1] = seedTxnIds(repo, 1);
    repo.createRepayment({
      transactionId: t1!, counterpartyId: 2, counterpartyName: 'Roomie',
      currency: 'ILS', amount: 60,
    });
    expect(repo.listRepayments()).toEqual([
      expect.objectContaining({
        transactionId: t1, counterpartyId: 2, counterpartyName: 'Roomie',
        currency: 'ILS', amount: 60,
      }),
    ]);
    repo.deleteRepayment(t1!);
    expect(repo.listRepayments()).toHaveLength(0);
  });

  it('getRepaymentPool sums amounts per counterparty+currency', () => {
    const { repo } = makeRepo();
    const [t1, t2, t3] = seedTxnIds(repo, 3);
    repo.createRepayment({ transactionId: t1!, counterpartyId: 2, counterpartyName: 'A', currency: 'ILS', amount: 40 });
    repo.createRepayment({ transactionId: t2!, counterpartyId: 2, counterpartyName: 'A', currency: 'ILS', amount: 25 });
    repo.createRepayment({ transactionId: t3!, counterpartyId: 3, counterpartyName: 'B', currency: 'USD', amount: 10 });
    const pool = repo.getRepaymentPool();
    expect(pool.get('2|ILS')).toBe(65);
    expect(pool.get('3|USD')).toBe(10);
  });

  it('updateSplitwiseLinkPaid persists paid_amount, state, and counterparties JSON', () => {
    const { repo } = makeRepo();
    const [t1] = seedTxnIds(repo, 1);
    repo.createSplitwiseLink({
      transactionId: t1!, expenseId: 'x1', groupId: null, currency: 'ILS',
      owedToMe: 60, counterparties: [cp(2, 'Roomie', 60)],
    });
    repo.updateSplitwiseLinkPaid(t1!, 60, 'paid', [{ ...cp(2, 'Roomie', 60), paid: 60 }]);
    const link = repo.getSplitwiseLink(t1!)!;
    expect(link.paidAmount).toBe(60);
    expect(link.paidState).toBe('paid');
    expect(link.counterparties[0].paid).toBe(60);
  });
});

describe('recomputePaidStates', () => {
  it('marks a link paid from a linked repayment, not from Splitwise', () => {
    const { repo } = makeRepo();
    const [linkTxn, repayTxn] = seedTxnIds(repo, 2);
    repo.createSplitwiseLink({
      transactionId: linkTxn!, expenseId: 'x1', groupId: null, currency: 'ILS',
      owedToMe: 60, counterparties: [{ id: 2, name: 'Roomie', owed: 60 }],
    });
    // No repayment yet → stays open.
    recomputePaidStates(repo);
    expect(repo.getSplitwiseLink(linkTxn!)!.paidState).toBe('open');

    // Link the real repayment → paid.
    repo.createRepayment({ transactionId: repayTxn!, counterpartyId: 2, counterpartyName: 'Roomie', currency: 'ILS', amount: 60 });
    recomputePaidStates(repo);
    const link = repo.getSplitwiseLink(linkTxn!)!;
    expect(link.paidState).toBe('paid');
    expect(link.paidAmount).toBe(60);
    expect(link.counterparties[0].paid).toBe(60);

    // Unlink → reverts to open.
    repo.deleteRepayment(repayTxn!);
    recomputePaidStates(repo);
    expect(repo.getSplitwiseLink(linkTxn!)!.paidState).toBe('open');
  });
});
