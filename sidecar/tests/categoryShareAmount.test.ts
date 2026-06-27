import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/db.js';

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
