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
