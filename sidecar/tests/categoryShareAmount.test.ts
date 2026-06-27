import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/db.js';
import { Repo } from '../src/repo.js';

describe('category_splits.share_amount migration', () => {
  it('adds a nullable share_amount column and bumps the version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hon-mig43-'));
    const { db } = openDatabase(dir);
    const cols = db.prepare(`PRAGMA table_info(category_splits)`).all() as Array<{ name: string; notnull: number }>;
    const share = cols.find((c) => c.name === 'share_amount');
    expect(share).toBeTruthy();
    expect(share!.notnull).toBe(0); // nullable
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(43);
  });
});

describe('Repo category share amounts', () => {
  it('round-trips a share amount and reports it in listCategorySplits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hon-share-'));
    const { db } = openDatabase(dir);
    const repo = new Repo(db);
    repo.setCategoryShareAmount('Housing', 2250);
    const rows = repo.listCategorySplits();
    const housing = rows.find((r) => r.category === 'Housing');
    expect(housing?.shareAmount).toBe(2250);
    expect(housing?.splitCount).toBe(1); // defaults to 1 when only a share is set
  });

  it('clears the share amount back to null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hon-share-'));
    const { db } = openDatabase(dir);
    const repo = new Repo(db);
    repo.setCategoryShareAmount('Housing', 2250);
    repo.clearCategoryShareAmount('Housing');
    const housing = repo.listCategorySplits().find((r) => r.category === 'Housing');
    expect(housing?.shareAmount ?? null).toBeNull();
  });

  it('keeps the split when clearing only the share', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hon-share-'));
    const { db } = openDatabase(dir);
    const repo = new Repo(db);
    repo.setCategorySplit('Housing', 3);
    repo.setCategoryShareAmount('Housing', 2250);
    repo.clearCategoryShareAmount('Housing');
    const housing = repo.listCategorySplits().find((r) => r.category === 'Housing');
    expect(housing?.splitCount).toBe(3);
    expect(housing?.shareAmount ?? null).toBeNull();
  });

  it('keeps the share when clearing only the split', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hon-share-'));
    const { db } = openDatabase(dir);
    const repo = new Repo(db);
    repo.setCategoryShareAmount('Housing', 2250);
    repo.setCategorySplit('Housing', 3);
    repo.clearCategorySplit('Housing');
    const housing = repo.listCategorySplits().find((r) => r.category === 'Housing');
    expect(housing?.splitCount).toBe(1);
    expect(housing?.shareAmount).toBe(2250);
  });
});
