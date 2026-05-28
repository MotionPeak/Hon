import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/db.js';

describe('db migrations', () => {
  it('migration 36: connections.history_months exists with default 12', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hon-mig36-'));
    const { db } = openDatabase(dir);

    // Seed a connection without specifying history_months — must take the default.
    db.prepare(
      "INSERT INTO connections (id, company_id, display_name, created_at) VALUES ('c1', 'hapoalim', 'Hapoalim', '2026-01-01')"
    ).run();

    const row = db
      .prepare('SELECT history_months FROM connections WHERE id = ?')
      .get('c1') as { history_months: number };
    expect(row.history_months).toBe(12);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(36);
  });
});
