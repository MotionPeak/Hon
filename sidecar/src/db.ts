import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_VERSION = 23;

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
  {
    // external_id used to be the institution's bare reference number, which
    // banks reuse across recurring deposits (and cards reuse across an
    // installment's monthly legs). Every such occurrence collided on the
    // (account_id, external_id) upsert, so only the latest survived. The id
    // now carries the transaction date; append it to existing rows so they
    // match the new format instead of being re-inserted as duplicates.
    version: 13,
    sql: `UPDATE transactions SET external_id = external_id || ':' || date;`,
  },
  {
    // Lets the user drop an individual account or manual asset out of the
    // net-worth total (e.g. a joint account, or savings they track but don't
    // want counted) while keeping it visible on its card.
    version: 14,
    sql: `
      ALTER TABLE accounts ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE manual_assets ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Brokerage support: per-account security positions, and a daily value
    // snapshot so brokerage trend graphs have a history to draw — SnapTrade
    // does not hand back historical portfolio values, so Hon records its own.
    version: 15,
    sql: `
      CREATE TABLE holdings (
        id          TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        symbol      TEXT NOT NULL,
        description TEXT,
        units       REAL NOT NULL,
        price       REAL,
        currency    TEXT NOT NULL DEFAULT 'USD',
        cost_basis  REAL,
        open_pnl    REAL,
        updated_at  TEXT NOT NULL,
        UNIQUE (account_id, symbol)
      );

      CREATE TABLE account_value_snapshots (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        date       TEXT NOT NULL,
        value      REAL NOT NULL,
        currency   TEXT NOT NULL,
        PRIMARY KEY (account_id, date)
      );
    `,
  },
  {
    // Cached SnapTrade performance report per brokerage connection — the full
    // historical equity timeline, rate of return, dividends and contributions.
    // Pulled once per sync; the UI slices it for 1M / 3M / YTD / 1Y / ALL.
    version: 16,
    sql: `
      CREATE TABLE brokerage_performance (
        connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        data_json     TEXT NOT NULL,
        fetched_at    TEXT NOT NULL
      );
    `,
  },
  {
    // Subscriptions the user has explicitly marked cancelled. The Subscriptions
    // tab hides them from "active" and surfaces them in a Cancelled section; a
    // later charge for the same merchant is flagged so the user can confirm
    // whether the cancellation actually took.
    version: 17,
    sql: `
      CREATE TABLE cancelled_subscriptions (
        merchant_key TEXT PRIMARY KEY,
        cancelled_at TEXT NOT NULL
      );
    `,
  },
  {
    // Per-holding price/value history — one row per (account, symbol, day).
    // Captured on every brokerage sync so each position can show its own
    // sparkline trend in the Insights brokerage view.
    version: 18,
    sql: `
      CREATE TABLE holding_value_snapshots (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        symbol     TEXT NOT NULL,
        date       TEXT NOT NULL,
        units      REAL NOT NULL,
        price      REAL,
        value      REAL NOT NULL,
        currency   TEXT NOT NULL,
        PRIMARY KEY (account_id, symbol, date)
      );
    `,
  },
  {
    // Loans the user is paying back — Israeli mortgage tracks (kvua lo-tzmuda,
    // kvua tzmuda, prime), car loans, personal loans. Each row holds only the
    // original terms; the current outstanding is computed at read time with a
    // Spitzer amortization, scaled by the CPI ratio for tzmuda tracks and at
    // the current BOI prime + the user's margin for prime tracks. cpi_start
    // is snapshotted at creation so the linkage is fixed. rate_cache memoises
    // the BOI prime and CBS CPI lookups so the UI does not refetch a value
    // that has not changed.
    version: 19,
    sql: `
      CREATE TABLE loans (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        principal     REAL NOT NULL,
        start_date    TEXT NOT NULL,
        term_months   INTEGER NOT NULL,
        is_prime      INTEGER NOT NULL DEFAULT 0,
        is_cpi_linked INTEGER NOT NULL DEFAULT 0,
        rate_value    REAL NOT NULL,
        cpi_start     REAL,
        currency      TEXT NOT NULL DEFAULT 'ILS',
        excluded      INTEGER NOT NULL DEFAULT 0,
        notes         TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE rate_cache (
        series      TEXT NOT NULL,
        period      TEXT NOT NULL,
        value       REAL NOT NULL,
        fetched_at  TEXT NOT NULL,
        PRIMARY KEY (series, period)
      );
    `,
  },
  {
    // Lets a loan be linked to the bank connection that scraped it, so a
    // re-sync upserts the same row instead of inserting a duplicate. Both
    // columns are NULL for hand-entered loans. The partial unique index
    // enforces one row per (connection, bank loan id) but allows any
    // number of manual loans alongside.
    version: 20,
    sql: `
      ALTER TABLE loans ADD COLUMN connection_id TEXT
        REFERENCES connections(id) ON DELETE CASCADE;
      ALTER TABLE loans ADD COLUMN external_id TEXT;
      CREATE UNIQUE INDEX idx_loans_connection_external
        ON loans(connection_id, external_id)
        WHERE connection_id IS NOT NULL AND external_id IS NOT NULL;
    `,
  },
  {
    // Piggy banks can now be one-shot "lump-sum" reservations alongside the
    // existing monthly set-asides: a fixed amount earmarked for a single
    // future expense (taxes, a deposit), funded the first month it fits and
    // then held in reserve — no recurring draw — until the user marks it
    // used. `monthly_amount` is ignored for lump piggies.
    version: 21,
    sql: `
      ALTER TABLE piggy_banks ADD COLUMN kind TEXT NOT NULL DEFAULT 'monthly';
    `,
  },
  {
    // User-editable spending categories. Replaces the hardcoded list in
    // categorize.ts / budget.ts / app.html — the canonical category set
    // now lives here so a user can add (Hobbies, Pets…) or re-classify an
    // existing one ("Subscriptions" → essential instead of fixed). Built-in
    // categories carry the original emoji/colour/group and are editable but
    // not deletable; deleting a custom category reassigns its transactions
    // to 'Other'. cat_group is one of essential/fixed/variable — the budget
    // and frontend group breakdowns read from it directly.
    version: 22,
    sql: `
      CREATE TABLE categories (
        name        TEXT PRIMARY KEY,
        emoji       TEXT NOT NULL DEFAULT '🏷️',
        color       TEXT NOT NULL DEFAULT '#8C8FA8',
        cat_group   TEXT NOT NULL DEFAULT 'variable',
        sort_order  INTEGER NOT NULL DEFAULT 100,
        is_builtin  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
      INSERT INTO categories (name, emoji, color, cat_group, sort_order, is_builtin, created_at) VALUES
        ('Groceries',     '🛒',  '#5CC773', 'essential', 10, 1, datetime('now')),
        ('Dining',        '🍽️', '#F59942', 'essential', 20, 1, datetime('now')),
        ('Transport',     '🚌',  '#5C9EF5', 'essential', 30, 1, datetime('now')),
        ('Fuel',          '⛽',  '#EB736B', 'essential', 40, 1, datetime('now')),
        ('Health',        '⚕️', '#ED6680', 'essential', 50, 1, datetime('now')),
        ('Housing',       '🏠',  '#66B8BD', 'fixed',     60, 1, datetime('now')),
        ('Utilities',     '💡',  '#F2C752', 'fixed',     70, 1, datetime('now')),
        ('Insurance',     '🛡️', '#6E8FD6', 'fixed',     80, 1, datetime('now')),
        ('Subscriptions', '🔁',  '#7D8CED', 'fixed',     90, 1, datetime('now')),
        ('Education',     '📚',  '#73B39E', 'fixed',    100, 1, datetime('now')),
        ('Fees',          '﹪',  '#B38C80', 'fixed',    110, 1, datetime('now')),
        ('Shopping',      '🛍️', '#D975D6', 'variable', 120, 1, datetime('now')),
        ('Entertainment', '🎭',  '#A880ED', 'variable', 130, 1, datetime('now')),
        ('Travel',        '✈️', '#5CC7DB', 'variable', 140, 1, datetime('now')),
        ('Income',        '💰',  '#4CD180', 'variable', 150, 1, datetime('now')),
        ('Transfers',     '↔️', '#999EB8', 'variable', 160, 1, datetime('now')),
        ('Other',         '▫️', '#8C8FA8', 'variable', 999, 1, datetime('now'));
    `,
  },
  {
    // A one-off, per-cycle "savings reserve" the user can dial in for the
    // current month. The Variable Spending card deducts it (capped at the
    // available pool) so the leftover reflects the saving plan. Not a piggy
    // bank — no target, no recurring commitment, just "set aside X this
    // month". The single global "expected_income_override" lives in `meta`.
    version: 23,
    sql: `
      CREATE TABLE monthly_savings (
        month  TEXT PRIMARY KEY,
        amount REAL NOT NULL
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
