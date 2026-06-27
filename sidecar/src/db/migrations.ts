// The ordered list of schema migrations and the current SCHEMA_VERSION.
//
// Extracted from db.ts (2026-06-01) so this list is importable WITHOUT pulling
// in the native better-sqlite3 binding — the Drizzle schema-parity test and any
// tooling can read the canonical DDL on any platform. db.ts still owns opening
// + applying these; this module is pure data.
//
// **db.ts / these migrations remain the single source of truth for the DB
// schema.** The Drizzle schema in ./schema.ts is a typed query layer over the
// database these migrations build — it does NOT create tables. When you add a
// migration here, mirror the change in ./schema.ts; the schema-parity test
// (tests/schema.parity.test.ts) fails if they drift.

export const SCHEMA_VERSION = 43;

export const MIGRATIONS: { version: number; sql: string }[] = [
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
        ('Income',        '💰',  '#4CD180', 'income',   150, 1, datetime('now')),
        ('Transfers',     '↔️', '#999EB8', 'income',   160, 1, datetime('now')),
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
  {
    // N:M refund linking with partial amounts. The original 1:1 table forced
    // one expense to one refund and the whole refund magnitude was applied —
    // no way to model "one bank inflow covers two bills" or vice versa, and
    // no way for a Splitwise-owed expense to read as partially-reimbursed
    // before the cash actually moves. Each row now records HOW MUCH of the
    // refund is allocated to the expense, and the new view sums per-expense
    // allocations and folds in a Splitwise virtual-refund leg (owed_to_me
    // minus already-settled, capped so it can't double-count manual links).
    version: 24,
    sql: `
      DROP VIEW IF EXISTS txn_effective;

      CREATE TABLE transaction_links_new (
        id          TEXT PRIMARY KEY,
        expense_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        refund_id   TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        amount      REAL NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE (expense_id, refund_id)
      );

      -- Backfill: each existing link transfers, with amount = full refund
      -- magnitude (the prior semantics).
      INSERT INTO transaction_links_new (id, expense_id, refund_id, amount, created_at)
      SELECT lower(hex(randomblob(16))), l.expense_id, l.refund_id,
             ABS(r.amount), l.created_at
      FROM transaction_links l
      JOIN transactions r ON r.id = l.refund_id;

      DROP TABLE transaction_links;
      ALTER TABLE transaction_links_new RENAME TO transaction_links;

      CREATE INDEX idx_txn_links_expense ON transaction_links (expense_id);
      CREATE INDEX idx_txn_links_refund  ON transaction_links (refund_id);

      -- For each expense:  effective = original_amount + manual refund allocations
      --                              + Splitwise virtual refund (owed minus settled
      --                                minus what manual links already cover).
      -- For each refund:   effective = signed_amount minus already-allocated portion
      --                                (shows the unallocated remainder; drop the row
      --                                entirely when fully allocated).
      CREATE VIEW txn_effective AS
      WITH refund_allocs AS (
        SELECT expense_id, SUM(amount) AS refunded
        FROM transaction_links GROUP BY expense_id
      ),
      refund_used AS (
        SELECT refund_id, SUM(amount) AS used
        FROM transaction_links GROUP BY refund_id
      ),
      splitwise_virtual AS (
        SELECT s.transaction_id AS expense_id,
               MAX(0, s.owed_to_me - s.paid_amount - COALESCE(r.refunded, 0))
                 AS virtual
        FROM splitwise_links s
        LEFT JOIN refund_allocs r ON r.expense_id = s.transaction_id
      )
      SELECT t.id, t.account_id, t.date,
             CASE
               WHEN ru.used IS NOT NULL THEN
                 CASE WHEN t.amount > 0 THEN t.amount - ru.used
                      ELSE t.amount + ru.used END
               ELSE
                 t.amount + COALESCE(r.refunded, 0) + COALESCE(sv.virtual, 0)
             END AS amount,
             t.currency, t.description, t.category
      FROM transactions t
      LEFT JOIN refund_allocs r ON r.expense_id = t.id
      LEFT JOIN refund_used ru ON ru.refund_id = t.id
      LEFT JOIN splitwise_virtual sv ON sv.expense_id = t.id
      WHERE NOT EXISTS (
        SELECT 1 FROM refund_used u
        WHERE u.refund_id = t.id AND u.used >= ABS(t.amount) - 0.005
      );
    `,
  },
  {
    // Whether a month's savings set-aside is a real transfer out of the
    // checking account (1) or just a budget earmark that stays in (0). The
    // bank-balance projection deducts only the transferred ones.
    version: 25,
    sql: `
      ALTER TABLE monthly_savings ADD COLUMN transferred INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Bills the user shares with roommates / partners: per-merchant
    // split_count means "I pay 1/N of every charge from this merchant".
    // Independent of merchant_recurrence (a merchant can be split without
    // being tagged as recurring, and vice versa). The Fixed bills view
    // divides displayed amounts by split_count; raw transactions are left
    // unchanged so the original charges still match the bank.
    version: 26,
    sql: `
      CREATE TABLE merchant_splits (
        merchant_key TEXT PRIMARY KEY,
        split_count  INTEGER NOT NULL CHECK (split_count >= 1),
        created_at   TEXT NOT NULL
      );
    `,
  },
  {
    // Per-CATEGORY split (e.g. Utilities ÷ 3 when shared with roommates).
    // The user-level mental model is "I share this whole category with N
    // people", so the divisor lives on the category rather than per
    // merchant. Applies to every fixed-bill row inside that category in
    // the Fixed-bills view, the section totals, and the headline.
    version: 27,
    sql: `
      CREATE TABLE category_splits (
        category    TEXT PRIMARY KEY,
        split_count INTEGER NOT NULL CHECK (split_count >= 1),
        created_at  TEXT NOT NULL
      );
    `,
  },
  {
    // Income gets its own cat_group so it doesn't sit under "Variable
    // expenses" on the Activity page. The budget engine already excludes
    // positive amounts from spending sums, so this is purely a UI / grouping
    // change — no math shift.
    version: 28,
    sql: `
      UPDATE categories SET cat_group = 'income'
        WHERE name IN ('Income', 'Transfers');
    `,
  },
  {
    // Carry the bank-reported market value alongside units and price. For
    // SnapTrade brokerages units × price is a faithful number (USD/share ×
    // shares = USD), but Israeli securities quote price in agorot while
    // the actual holding value is in NIS — a 100× gap that breaks the
    // "value" column when computed naively. Storing the value lets each
    // scraper hand the real figure through; consumers fall back to
    // units × price when value is null.
    version: 29,
    sql: `
      ALTER TABLE holdings ADD COLUMN value REAL;
    `,
  },
  {
    // Tracks whether the user has edited a loan's name in Hon. Bank-loan
    // upserts overwrite every other column on each sync — that's right for
    // principal, rate, term, etc. (the bank is the source of truth) — but
    // wrong for the name, which the user may have cleaned up (e.g. Hapoalim
    // truncates "ירושלים" to "ים"). When this flag is 1 the name column is
    // preserved across scrapes; PATCH /loans/:id sets it whenever a rename
    // comes in. Hand-entered loans never have it flipped, so renaming them
    // is a no-op for sync semantics.
    version: 30,
    sql: `
      ALTER TABLE loans ADD COLUMN name_overridden INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Vouchers and gift cards — Shufersal Tav Hazahav, Pluxee/Sodexo, Cibus,
    // and the like. Each row carries an explicit currency, an optional expiry
    // (some employer cards roll over the year and reset), and an `excluded`
    // toggle so vouchers can be dropped from the net-worth roll-up without
    // deleting them. Like `loans`, the table supports both hand-entered rows
    // (connection_id NULL) and rows synced from a provider (connection_id +
    // external_id), so a future Shufersal scraper can upsert in place.
    version: 31,
    sql: `
      CREATE TABLE vouchers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        provider      TEXT NOT NULL,
        balance       REAL NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'ILS',
        expires_on    TEXT,
        notes         TEXT,
        excluded      INTEGER NOT NULL DEFAULT 0,
        connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
        external_id   TEXT,
        name_overridden INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_vouchers_connection_external
        ON vouchers(connection_id, external_id)
        WHERE connection_id IS NOT NULL AND external_id IS NOT NULL;
    `,
  },
  {
    // Per-account "when did I actually start investing in this" override.
    // The Insights brokerage chart's ALL range otherwise either paints 10
    // years of synthetic Yahoo-backfill history or, with cap heuristics
    // applied, narrows to Hon's first sync — which on a freshly-linked
    // account is just a few days old. A user-set inception date lets the
    // chart clip pretend-history precisely at the user's known buy date.
    version: 32,
    sql: `ALTER TABLE accounts ADD COLUMN inception_date TEXT;`,
  },
  {
    // Per-transaction link to a Loan row. Bank-loan payments are detected
    // by the loanMatcher (sidecar/src/loanMatcher.ts) after each scrape
    // and after a new bank loan is first written, then this column carries
    // the link so the Loans tab can render a "Last payment" badge + the
    // per-loan payment history without re-running pattern matching on
    // every request. SQLite `ALTER TABLE ADD COLUMN` cannot carry a
    // REFERENCES clause, so the column is a plain TEXT — integrity is
    // maintained by setTransactionLoan's existence check and a
    // delete-time null-out step.
    version: 33,
    sql: `ALTER TABLE transactions ADD COLUMN loan_id TEXT;`,
  },
  {
    // Partial index on transactions.loan_id — only includes rows that
    // have a link, which is a small minority of the table. Speeds up
    // listLoanPayments(loanId) (Loans card history reads) without the
    // size cost of indexing every NULL row.
    version: 34,
    sql: `CREATE INDEX IF NOT EXISTS idx_txn_loan_id ON transactions (loan_id) WHERE loan_id IS NOT NULL;`,
  },
  {
    // Per-transaction "exclude from cycle calculations" override. NULL means
    // the live cardProviders rule (web/settings) decides; 1 forces excluded;
    // 0 forces included even when the rule would match. Lets a user park
    // any transaction out of monthly totals (one-off card chargebacks,
    // misposted business spend, etc.) AND override the rule per-row.
    version: 35,
    sql: `ALTER TABLE transactions ADD COLUMN excluded_manual INTEGER;`,
  },
  {
    // Per-connection history window. Drives runner.chooseStartDate
    // and POST /connections/:id/scrape's default monthsBack. Range
    // [1, 24] enforced at API + repo layer (no DB CHECK constraint).
    // Default 12 means every existing connection recovers to a full
    // year on its next sync — see runner.ts where the lastSuccess-
    // based incremental shortcut was removed in the same change.
    version: 36,
    sql: `ALTER TABLE connections ADD COLUMN history_months INTEGER NOT NULL DEFAULT 12;`,
  },
  {
    // Splitwise repayments — incoming transactions the user marks as a
    // friend paying them back. Replaces trusting Splitwise's settle-up flag:
    // paid_amount/paid_state are recomputed from these rows, not from
    // Splitwise payment records. `amount` is captured from the txn at mark
    // time (incoming bank credits don't change). ON DELETE CASCADE mirrors
    // splitwise_links so removing a txn cleans up.
    version: 37,
    sql: `CREATE TABLE splitwise_repayments (
      transaction_id    TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
      counterparty_id   TEXT NOT NULL,
      counterparty_name TEXT NOT NULL,
      currency          TEXT NOT NULL,
      amount            REAL NOT NULL,
      created_at        TEXT NOT NULL
    );`,
  },
  {
    // Per-transaction "Savings" mark. 1 = money the user moved to savings;
    // such rows are pulled OUT of spend / "minus" calculations (like
    // excluded_manual) AND tallied as "saved this cycle". Mutually exclusive
    // with excluded_manual (the repo setters enforce that).
    version: 38,
    sql: `ALTER TABLE transactions ADD COLUMN savings INTEGER;`,
  },
  {
    // Recreate txn_effective so a transaction that is BOTH used as a refund
    // (refund_used) AND itself refunded / Splitwise-reduced (refund_allocs /
    // splitwise_virtual) reflects ALL of those adjustments. The previous
    // definition branched exclusively — `WHEN ru.used IS NOT NULL` returned the
    // refund-side amount and silently ignored r.refunded + sv.virtual — so a
    // dual-role row showed a wrong effective amount in every spending
    // aggregate. The combined form adds the expense-side adjustments and
    // subtracts the amount lent out as a refund (magnitude-wise, toward zero),
    // and is identical to the old result for every single-role row.
    version: 39,
    sql: `
      DROP VIEW IF EXISTS txn_effective;
      CREATE VIEW txn_effective AS
      WITH refund_allocs AS (
        SELECT expense_id, SUM(amount) AS refunded
        FROM transaction_links GROUP BY expense_id
      ),
      refund_used AS (
        SELECT refund_id, SUM(amount) AS used
        FROM transaction_links GROUP BY refund_id
      ),
      splitwise_virtual AS (
        SELECT s.transaction_id AS expense_id,
               MAX(0, s.owed_to_me - s.paid_amount - COALESCE(r.refunded, 0))
                 AS virtual
        FROM splitwise_links s
        LEFT JOIN refund_allocs r ON r.expense_id = s.transaction_id
      )
      SELECT t.id, t.account_id, t.date,
             t.amount
               + COALESCE(r.refunded, 0)
               + COALESCE(sv.virtual, 0)
               - CASE WHEN t.amount > 0 THEN COALESCE(ru.used, 0)
                      ELSE -COALESCE(ru.used, 0) END
               AS amount,
             t.currency, t.description, t.category
      FROM transactions t
      LEFT JOIN refund_allocs r ON r.expense_id = t.id
      LEFT JOIN refund_used ru ON ru.refund_id = t.id
      LEFT JOIN splitwise_virtual sv ON sv.expense_id = t.id
      WHERE NOT EXISTS (
        SELECT 1 FROM refund_used u
        WHERE u.refund_id = t.id AND u.used >= ABS(t.amount) - 0.005
      );
    `,
  },
  {
    // Recreate txn_effective so a row that is used as a refund is dropped only
    // when its FULL effective amount nets to ~0 — not whenever the refund-out
    // leg alone covers its magnitude. The v39 WHERE clause looked solely at
    // refund_used (`used >= ABS(amount)`), so a dual-role row — one that gives
    // a refund AND also receives one (refund_allocs) or carries a Splitwise
    // virtual leg — vanished entirely even though its net is non-zero. The net
    // is already computed in the SELECT (identical math to v39); this just
    // moves the drop test onto that net. For every single-role refund the
    // allocation cap (Σ links ≤ refund magnitude, enforced in the API layer)
    // makes the net-based drop identical to the old behavior, so fully-consumed
    // pure refunds still disappear. Columns are unchanged from v39.
    version: 40,
    sql: `
      DROP VIEW IF EXISTS txn_effective;
      CREATE VIEW txn_effective AS
      WITH refund_allocs AS (
        SELECT expense_id, SUM(amount) AS refunded
        FROM transaction_links GROUP BY expense_id
      ),
      refund_used AS (
        SELECT refund_id, SUM(amount) AS used
        FROM transaction_links GROUP BY refund_id
      ),
      splitwise_virtual AS (
        SELECT s.transaction_id AS expense_id,
               MAX(0, s.owed_to_me - s.paid_amount - COALESCE(r.refunded, 0))
                 AS virtual
        FROM splitwise_links s
        LEFT JOIN refund_allocs r ON r.expense_id = s.transaction_id
      ),
      effective AS (
        SELECT t.id, t.account_id, t.date,
               t.amount
                 + COALESCE(r.refunded, 0)
                 + COALESCE(sv.virtual, 0)
                 - CASE WHEN t.amount > 0 THEN COALESCE(ru.used, 0)
                        ELSE -COALESCE(ru.used, 0) END
                 AS amount,
               t.currency, t.description, t.category,
               ru.used AS refund_used
        FROM transactions t
        LEFT JOIN refund_allocs r ON r.expense_id = t.id
        LEFT JOIN refund_used ru ON ru.refund_id = t.id
        LEFT JOIN splitwise_virtual sv ON sv.expense_id = t.id
      )
      SELECT id, account_id, date, amount, currency, description, category
      FROM effective
      WHERE refund_used IS NULL OR ABS(amount) >= 0.005;
    `,
  },
  {
    // Built-in substring categorization rules, moved out of categorize.ts into
    // data so the match runs as ONE set-based SQL pass (repo.applyBuiltinRules)
    // instead of a per-transaction JS loop. `pattern` is a lowercase needle
    // matched via INSTR(LOWER(description), pattern); `priority` ascending is
    // first-match-wins (specific brands before broad words — "amazon prime" →
    // Subscriptions outranks "amazon" → Shopping). `source` is the provenance
    // seam ('builtin' now; a future 'user' for user-added rules). Seeded from
    // the array that previously lived in categorize.ts, in the same order.
    version: 41,
    sql: `
      CREATE TABLE category_rules (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern    TEXT NOT NULL,
        category   TEXT NOT NULL,
        priority   INTEGER NOT NULL,
        source     TEXT NOT NULL DEFAULT 'builtin',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_category_rules_priority ON category_rules (priority);
      INSERT INTO category_rules (pattern, category, priority, source, created_at) VALUES
        ('netflix', 'Subscriptions', 10, 'builtin', datetime('now')),
        ('נטפליקס', 'Subscriptions', 20, 'builtin', datetime('now')),
        ('spotify', 'Subscriptions', 30, 'builtin', datetime('now')),
        ('ספוטיפיי', 'Subscriptions', 40, 'builtin', datetime('now')),
        ('youtube', 'Subscriptions', 50, 'builtin', datetime('now')),
        ('disney', 'Subscriptions', 60, 'builtin', datetime('now')),
        ('apple.com', 'Subscriptions', 70, 'builtin', datetime('now')),
        ('icloud', 'Subscriptions', 80, 'builtin', datetime('now')),
        ('openai', 'Subscriptions', 90, 'builtin', datetime('now')),
        ('chatgpt', 'Subscriptions', 100, 'builtin', datetime('now')),
        ('amazon prime', 'Subscriptions', 110, 'builtin', datetime('now')),
        ('מנוי', 'Subscriptions', 120, 'builtin', datetime('now')),
        ('ביטוח', 'Insurance', 130, 'builtin', datetime('now')),
        ('insurance', 'Insurance', 140, 'builtin', datetime('now')),
        ('הראל', 'Insurance', 150, 'builtin', datetime('now')),
        ('כלל ביטוח', 'Insurance', 160, 'builtin', datetime('now')),
        ('מגדל', 'Insurance', 170, 'builtin', datetime('now')),
        ('פניקס', 'Insurance', 180, 'builtin', datetime('now')),
        ('סונול', 'Fuel', 190, 'builtin', datetime('now')),
        ('דור אלון', 'Fuel', 200, 'builtin', datetime('now')),
        ('תחנת דלק', 'Fuel', 210, 'builtin', datetime('now')),
        ('דלקן', 'Fuel', 220, 'builtin', datetime('now')),
        ('פז יב', 'Fuel', 230, 'builtin', datetime('now')),
        ('שופרסל', 'Groceries', 240, 'builtin', datetime('now')),
        ('רמי לוי', 'Groceries', 250, 'builtin', datetime('now')),
        ('ויקטורי', 'Groceries', 260, 'builtin', datetime('now')),
        ('יוחננוף', 'Groceries', 270, 'builtin', datetime('now')),
        ('אושר עד', 'Groceries', 280, 'builtin', datetime('now')),
        ('טיב טעם', 'Groceries', 290, 'builtin', datetime('now')),
        ('יינות ביתן', 'Groceries', 300, 'builtin', datetime('now')),
        ('מגה בעיר', 'Groceries', 310, 'builtin', datetime('now')),
        ('סופרמרקט', 'Groceries', 320, 'builtin', datetime('now')),
        ('carrefour', 'Groceries', 330, 'builtin', datetime('now')),
        ('קרפור', 'Groceries', 340, 'builtin', datetime('now')),
        ('am:pm', 'Groceries', 350, 'builtin', datetime('now')),
        ('מקדונלד', 'Dining', 360, 'builtin', datetime('now')),
        ('ארומה', 'Dining', 370, 'builtin', datetime('now')),
        ('קפה קפה', 'Dining', 380, 'builtin', datetime('now')),
        ('רולדין', 'Dining', 390, 'builtin', datetime('now')),
        ('פיצה האט', 'Dining', 400, 'builtin', datetime('now')),
        ('דומינוס', 'Dining', 410, 'builtin', datetime('now')),
        ('בורגר', 'Dining', 420, 'builtin', datetime('now')),
        ('מסעד', 'Dining', 430, 'builtin', datetime('now')),
        ('וולט', 'Dining', 440, 'builtin', datetime('now')),
        ('wolt', 'Dining', 450, 'builtin', datetime('now')),
        ('10bis', 'Dining', 460, 'builtin', datetime('now')),
        ('תן ביס', 'Dining', 470, 'builtin', datetime('now')),
        ('לנדוור', 'Dining', 480, 'builtin', datetime('now')),
        ('kfc', 'Dining', 490, 'builtin', datetime('now')),
        ('רכבת ישראל', 'Transport', 500, 'builtin', datetime('now')),
        ('רב קו', 'Transport', 510, 'builtin', datetime('now')),
        ('רב-קו', 'Transport', 520, 'builtin', datetime('now')),
        ('gett', 'Transport', 530, 'builtin', datetime('now')),
        ('yango', 'Transport', 540, 'builtin', datetime('now')),
        ('moovit', 'Transport', 550, 'builtin', datetime('now')),
        ('אגד', 'Transport', 560, 'builtin', datetime('now')),
        ('מטרופולין', 'Transport', 570, 'builtin', datetime('now')),
        ('חניון', 'Transport', 580, 'builtin', datetime('now')),
        ('pango', 'Transport', 590, 'builtin', datetime('now')),
        ('פנגו', 'Transport', 600, 'builtin', datetime('now')),
        ('סלופארק', 'Transport', 610, 'builtin', datetime('now')),
        ('cellopark', 'Transport', 620, 'builtin', datetime('now')),
        ('כביש 6', 'Transport', 630, 'builtin', datetime('now')),
        ('נתיבי איילון', 'Transport', 640, 'builtin', datetime('now')),
        ('חברת חשמל', 'Utilities', 650, 'builtin', datetime('now')),
        ('בזק', 'Utilities', 660, 'builtin', datetime('now')),
        ('הוט', 'Utilities', 670, 'builtin', datetime('now')),
        ('partner', 'Utilities', 680, 'builtin', datetime('now')),
        ('פרטנר', 'Utilities', 690, 'builtin', datetime('now')),
        ('סלקום', 'Utilities', 700, 'builtin', datetime('now')),
        ('cellcom', 'Utilities', 710, 'builtin', datetime('now')),
        ('פלאפון', 'Utilities', 720, 'builtin', datetime('now')),
        ('גולן טלקום', 'Utilities', 730, 'builtin', datetime('now')),
        ('מי אביבים', 'Utilities', 740, 'builtin', datetime('now')),
        ('מקורות', 'Utilities', 750, 'builtin', datetime('now')),
        ('תאגיד המים', 'Utilities', 760, 'builtin', datetime('now')),
        ('שכר דירה', 'Housing', 770, 'builtin', datetime('now')),
        ('ארנונה', 'Housing', 780, 'builtin', datetime('now')),
        ('ועד בית', 'Housing', 790, 'builtin', datetime('now')),
        ('משכנתא', 'Housing', 800, 'builtin', datetime('now')),
        ('עיריית', 'Housing', 810, 'builtin', datetime('now')),
        ('עירית', 'Housing', 820, 'builtin', datetime('now')),
        ('סופר פארם', 'Health', 830, 'builtin', datetime('now')),
        ('super-pharm', 'Health', 840, 'builtin', datetime('now')),
        ('ניו פארם', 'Health', 850, 'builtin', datetime('now')),
        ('בית מרקחת', 'Health', 860, 'builtin', datetime('now')),
        ('מכבי', 'Health', 870, 'builtin', datetime('now')),
        ('כללית', 'Health', 880, 'builtin', datetime('now')),
        ('מאוחדת', 'Health', 890, 'builtin', datetime('now')),
        ('קופת חולים', 'Health', 900, 'builtin', datetime('now')),
        ('סינמה סיטי', 'Entertainment', 910, 'builtin', datetime('now')),
        ('יס פלאנט', 'Entertainment', 920, 'builtin', datetime('now')),
        ('רב חן', 'Entertainment', 930, 'builtin', datetime('now')),
        ('סינמטק', 'Entertainment', 940, 'builtin', datetime('now')),
        ('תיאטר', 'Entertainment', 950, 'builtin', datetime('now')),
        ('steam', 'Entertainment', 960, 'builtin', datetime('now')),
        ('playstation', 'Entertainment', 970, 'builtin', datetime('now')),
        ('בית מלון', 'Travel', 980, 'builtin', datetime('now')),
        ('airbnb', 'Travel', 990, 'builtin', datetime('now')),
        ('booking.com', 'Travel', 1000, 'builtin', datetime('now')),
        ('אל על', 'Travel', 1010, 'builtin', datetime('now')),
        ('אלעל', 'Travel', 1020, 'builtin', datetime('now')),
        ('el al', 'Travel', 1030, 'builtin', datetime('now')),
        ('ארקיע', 'Travel', 1040, 'builtin', datetime('now')),
        ('wizz', 'Travel', 1050, 'builtin', datetime('now')),
        ('נמל תעופה', 'Travel', 1060, 'builtin', datetime('now')),
        ('expedia', 'Travel', 1070, 'builtin', datetime('now')),
        ('פתאל', 'Travel', 1080, 'builtin', datetime('now')),
        ('אוניברסיט', 'Education', 1090, 'builtin', datetime('now')),
        ('מכלל', 'Education', 1100, 'builtin', datetime('now')),
        ('בית ספר', 'Education', 1110, 'builtin', datetime('now')),
        ('צהרון', 'Education', 1120, 'builtin', datetime('now')),
        ('udemy', 'Education', 1130, 'builtin', datetime('now')),
        ('coursera', 'Education', 1140, 'builtin', datetime('now')),
        ('שכר לימוד', 'Education', 1150, 'builtin', datetime('now')),
        ('ikea', 'Shopping', 1160, 'builtin', datetime('now')),
        ('איקאה', 'Shopping', 1170, 'builtin', datetime('now')),
        ('קסטרו', 'Shopping', 1180, 'builtin', datetime('now')),
        ('רנואר', 'Shopping', 1190, 'builtin', datetime('now')),
        ('מקס סטוק', 'Shopping', 1200, 'builtin', datetime('now')),
        ('הום סנטר', 'Shopping', 1210, 'builtin', datetime('now')),
        ('aliexpress', 'Shopping', 1220, 'builtin', datetime('now')),
        ('עלי אקספרס', 'Shopping', 1230, 'builtin', datetime('now')),
        ('amazon', 'Shopping', 1240, 'builtin', datetime('now')),
        ('אמזון', 'Shopping', 1250, 'builtin', datetime('now')),
        ('ebay', 'Shopping', 1260, 'builtin', datetime('now')),
        ('shein', 'Shopping', 1270, 'builtin', datetime('now')),
        ('טרמינל איקס', 'Shopping', 1280, 'builtin', datetime('now')),
        ('משכורת', 'Income', 1290, 'builtin', datetime('now')),
        ('שכר עבודה', 'Income', 1300, 'builtin', datetime('now')),
        ('זיכוי', 'Income', 1310, 'builtin', datetime('now')),
        ('דיבידנד', 'Income', 1320, 'builtin', datetime('now')),
        ('paybox', 'Transfers', 1330, 'builtin', datetime('now')),
        ('פייבוקס', 'Transfers', 1340, 'builtin', datetime('now')),
        ('משיכת מזומן', 'Transfers', 1350, 'builtin', datetime('now')),
        ('כספומט', 'Transfers', 1360, 'builtin', datetime('now')),
        ('הפקדה', 'Transfers', 1370, 'builtin', datetime('now')),
        ('העברה', 'Transfers', 1380, 'builtin', datetime('now')),
        ('העברת', 'Transfers', 1390, 'builtin', datetime('now')),
        ('דמי כרטיס', 'Fees', 1400, 'builtin', datetime('now')),
        ('דמי ניהול', 'Fees', 1410, 'builtin', datetime('now')),
        ('דמי טיפול', 'Fees', 1420, 'builtin', datetime('now')),
        ('עמלת', 'Fees', 1430, 'builtin', datetime('now')),
        ('עמלה', 'Fees', 1440, 'builtin', datetime('now'));
    `,
  },
  {
    // Per-connection scrape watermark: the earliest date a successful sync has
    // already fetched from. NULL = unknown, which makes the next sync a full
    // backfill that then records it. The runner reads this to fetch
    // incrementally instead of re-downloading the whole historyMonths window
    // every time (see scrapeWindow.pickScrapeStartDate).
    version: 42,
    sql: `ALTER TABLE connections ADD COLUMN fetched_since TEXT;`,
  },
  {
    // Optional absolute "my share" override for a split category — for uneven
    // splits the integer split_count can't express (rent ₪7,500, I pay ₪2,250).
    // NULL keeps the ÷split_count behaviour.
    version: 43,
    sql: `ALTER TABLE category_splits ADD COLUMN share_amount REAL;`,
  },
];
