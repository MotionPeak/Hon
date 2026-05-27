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
