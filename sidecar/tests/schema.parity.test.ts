// Schema-parity guard. The migrations in src/db/migrations.ts are the single
// source of truth for the DB schema; the Drizzle schema in src/db/schema.ts is
// a typed query layer over the tables those migrations build (it does NOT
// create them). The two can silently drift — add a column in a migration but
// forget to mirror it in schema.ts (or vice versa) and reads/writes go wrong at
// runtime with no compile error.
//
// This test opens a freshly-migrated database and asserts, for every table the
// Drizzle schema declares, that its column-name set matches the live table
// exactly (in both directions). The view (txn_effective, declared `.existing()`)
// is intentionally skipped — Drizzle never creates it and its projection is
// asserted by the analytics tests.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { openDatabase } from '../src/db.js';
import * as schema from '../src/db/schema.js';

describe('schema parity (migrations.ts ↔ schema.ts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hon-schema-parity-'));
  const { db } = openDatabase(dir);

  // Every exported Drizzle table object (skip the view + non-table exports).
  // The exports are a heterogeneous union of specific table types; widen to
  // unknown[] so the `is(...)` guard narrows cleanly to the base SQLiteTable.
  const exports: unknown[] = Object.values(schema);
  const tables = exports.filter((v): v is SQLiteTable => is(v, SQLiteTable));

  it('declares at least one table', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))(
    'table %s has matching columns in the live schema',
    (_name, table) => {
      const cfg = getTableConfig(table);
      const declared = new Set(cfg.columns.map((c) => c.name));
      const live = new Set(
        (db.prepare(`PRAGMA table_info("${cfg.name}")`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );

      // The migrated table must actually exist (PRAGMA returns no rows for a
      // missing table — a schema.ts table with no migration behind it).
      expect(live.size, `table "${cfg.name}" is declared in schema.ts but absent from the migrated DB`).toBeGreaterThan(0);

      const missingInDb = [...declared].filter((c) => !live.has(c)).sort();
      const missingInSchema = [...live].filter((c) => !declared.has(c)).sort();

      expect(
        missingInDb,
        `columns declared in schema.ts but missing from the migrated "${cfg.name}" table`,
      ).toEqual([]);
      expect(
        missingInSchema,
        `columns in the migrated "${cfg.name}" table but missing from schema.ts`,
      ).toEqual([]);
    },
  );
});
