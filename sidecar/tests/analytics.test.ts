import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { buildAnalytics } from '../src/analytics.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-analytics-'));
  const { db } = openDatabase(dir);
  return new Repo(db);
}

function seedThisMonth(repo: Repo) {
  const now = new Date();
  const iso = (day: number) =>
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const conn = repo.createConnection('beinleumi', 'Beinleumi');
  repo.saveScrapeResult(conn.id, [{
    accountNumber: '1', currency: 'ILS', balance: 0,
    transactions: [
      { externalId: 'a', date: iso(2), amount: -100, currency: 'ILS', description: 'Cafe' },
      { externalId: 'b', date: iso(3), amount: -9461, currency: 'ILS', description: 'מקס איט פיננסים' },
    ],
  }]);
}

describe('buildAnalytics cardProviders', () => {
  it('excludes matching card-bill lump sums from this-month spending', () => {
    const repo = makeRepo();
    seedThisMonth(repo);
    expect(buildAnalytics(repo).thisMonth.spending).toBe(9561);
    expect(buildAnalytics(repo, ['מקס איט']).thisMonth.spending).toBe(100);
  });

  it('default (no patterns) is unchanged', () => {
    const repo = makeRepo();
    seedThisMonth(repo);
    const a = buildAnalytics(repo);
    expect(a.txnCount).toBe(2);
    expect(buildAnalytics(repo, []).txnCount).toBe(2);
  });
});
