import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_VERSION = 6;

export interface DbHandle {
  db: Database.Database;
  path: string;
  schemaVersion: number;
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE connections (
        id             TEXT PRIMARY KEY,
        company_id     TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        last_scrape_at TEXT,
        last_status    TEXT
      );

      CREATE TABLE accounts (
        id             TEXT PRIMARY KEY,
        connection_id  TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        account_number TEXT NOT NULL,
        label          TEXT,
        balance        REAL,
        currency       TEXT NOT NULL DEFAULT 'ILS',
        updated_at     TEXT NOT NULL,
        UNIQUE (connection_id, account_number)
      );

      CREATE TABLE transactions (
        id             TEXT PRIMARY KEY,
        account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        external_id    TEXT NOT NULL,
        date           TEXT NOT NULL,
        processed_date TEXT,
        amount         REAL NOT NULL,
        currency       TEXT NOT NULL DEFAULT 'ILS',
        description    TEXT NOT NULL,
        memo           TEXT,
        kind           TEXT,
        status         TEXT,
        category       TEXT,
        raw_json       TEXT,
        created_at     TEXT NOT NULL,
        UNIQUE (account_id, external_id)
      );

      CREATE INDEX idx_tx_account_date ON transactions (account_id, date DESC);

      CREATE TABLE scrape_runs (
        id                 TEXT PRIMARY KEY,
        connection_id      TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        started_at         TEXT NOT NULL,
        finished_at        TEXT,
        status             TEXT NOT NULL,
        message            TEXT,
        accounts_count     INTEGER NOT NULL DEFAULT 0,
        transactions_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE category_cache (
        description_key TEXT PRIMARY KEY,
        category        TEXT NOT NULL,
        source          TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE budgets (
        category       TEXT PRIMARY KEY,
        monthly_amount REAL NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE credentials (
        connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        blob          TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE merchant_rules (
        description TEXT PRIMARY KEY,
        category    TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
    `,
  },
];

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
