import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from './db/migrations.js';

// SCHEMA_VERSION + the migration list now live in ./db/migrations.ts (pure
// data, no native dependency) so tooling and the Drizzle schema-parity test can
// read the canonical DDL on any platform. db.ts keeps the job of opening the
// connection and applying anything outstanding. Re-exported here so existing
// importers (`import { SCHEMA_VERSION } from './db.js'`) keep working.
export { SCHEMA_VERSION };

export interface DbHandle {
  db: Database.Database;
  path: string;
  schemaVersion: number;
}

/**
 * Opens (creating/migrating if needed) the local Hon database. All financial
 * data lives here on disk only — it is never sent anywhere.
 */
export function openDatabase(dataDir: string): DbHandle {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'hon.db');

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

  const currentRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  const current = Number(currentRow?.value ?? 0);

  for (const migration of MIGRATIONS.filter((m) => m.version > current)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('schema_version', String(migration.version));
    })();
  }

  return { db, path, schemaVersion: SCHEMA_VERSION };
}
