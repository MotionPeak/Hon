import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { SCHEMA_VERSION } from '../src/db/migrations.js';

describe('transactions custom_title/notes migration', () => {
  it('adds nullable custom_title + notes columns and bumps version', () => {
    const { db } = openDatabase(mkdtempSync(join(tmpdir(), 'hon-txnmeta-')));
    const cols = db.prepare(`PRAGMA table_info(transactions)`).all() as Array<{ name: string; notnull: number }>;
    const title = cols.find((c) => c.name === 'custom_title');
    const notes = cols.find((c) => c.name === 'notes');
    expect(title).toBeTruthy(); expect(title!.notnull).toBe(0);
    expect(notes).toBeTruthy(); expect(notes!.notnull).toBe(0);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
  });
});
