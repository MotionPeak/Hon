import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_VERSION = 12;

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
  {
    // Manually-valued assets the user owns — cars, property, cash — that have
    // no institution to scrape. `details` is free-form JSON (a car keeps its
    // plate, year, mileage, ownership type and new price there).
    version: 7,
    sql: `
      CREATE TABLE manual_assets (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        value      REAL NOT NULL,
        currency   TEXT NOT NULL DEFAULT 'ILS',
        details    TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // Links a refunded/reimbursed expense to the offsetting (usually positive)
    // transaction — e.g. a bill the user paid that a roommate paid back. The
    // `txn_effective` view folds the refund into the expense and drops the
    // refund itself, so every spending aggregate counts the real net amount.
    version: 8,
    sql: `
      CREATE TABLE transaction_links (
        expense_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
        refund_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE VIEW txn_effective AS
        SELECT t.id, t.account_id, t.date,
               t.amount + COALESCE(r.amount, 0) AS amount,
               t.currency, t.description, t.category
        FROM transactions t
        LEFT JOIN transaction_links l ON l.expense_id = t.id
        LEFT JOIN transactions r ON r.id = l.refund_id
        WHERE t.id NOT IN (SELECT refund_id FROM transaction_links);
    `,
  },
  {
    // How often a recurring charge actually bills, keyed by a cleaned merchant
    // name (digit-bearing words stripped) so it carries across charges whose
    // descriptors differ only by a transaction code. Lets the app show a
    // monthly-equivalent cost for yearly subscriptions and bimonthly bills.
    version: 9,
    sql: `
      CREATE TABLE merchant_recurrence (
        merchant_key TEXT PRIMARY KEY,
        frequency    TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `,
  },
  {
    // Links a Hon transaction to a Splitwise expense created from it. Records
    // what others owe the user (`owed_to_me`) and who owes it (`counterparties`
    // — JSON `[{id,name,owed}]`), so the app can show a per-transaction "owed
    // to you" / "paid back" note. `paid_amount` and `paid_state` are recomputed
    // on each Splitwise refresh by matching payment records to linked expenses.
    version: 10,
    sql: `
      CREATE TABLE splitwise_links (
        transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
        expense_id     TEXT NOT NULL,
        group_id       TEXT,
        currency       TEXT NOT NULL,
        owed_to_me     REAL NOT NULL,
        counterparties TEXT NOT NULL,
        paid_amount    REAL NOT NULL DEFAULT 0,
        paid_state     TEXT NOT NULL DEFAULT 'open',
        created_at     TEXT NOT NULL,
        synced_at      TEXT
      );
    `,
  },
  {
    // Savings goals ("piggy banks"): a thing the user is saving toward, with a
    // target and a chosen monthly set-aside. The monthly amount is treated as
    // an expense against the budget. `piggy_contributions` is the per-month
    // ledger — one row per piggy per month, `funded` when the set-aside fit
    // that month's budget, `skipped` when it did not.
    version: 11,
    sql: `
      CREATE TABLE piggy_banks (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        emoji          TEXT NOT NULL DEFAULT '🐷',
        target_amount  REAL NOT NULL,
        monthly_amount REAL NOT NULL,
        currency       TEXT NOT NULL DEFAULT 'ILS',
        sort_order     INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE piggy_contributions (
        piggy_id   TEXT NOT NULL REFERENCES piggy_banks(id) ON DELETE CASCADE,
        month      TEXT NOT NULL,
        amount     REAL NOT NULL,
        status     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (piggy_id, month)
      );
    `,
  },
  {
    // A piggy bank the user has manually paused. While on hold it gets no
    // monthly set-aside and stops counting as a budget expense, regardless of
    // headroom — distinct from a bank auto-skipped because the budget is tight.
    version: 12,
    sql: `ALTER TABLE piggy_banks ADD COLUMN on_hold INTEGER NOT NULL DEFAULT 0;`,
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
