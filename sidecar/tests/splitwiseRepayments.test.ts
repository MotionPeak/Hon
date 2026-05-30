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
