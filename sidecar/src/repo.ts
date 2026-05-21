import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { NormalizedAccount } from './scrapers.js';

export interface Connection {
  id: string;
  companyId: string;
  displayName: string;
  createdAt: string;
  lastScrapeAt: string | null;
  lastStatus: string | null;
  hasCredentials: boolean;
}

// SQLite has no boolean type, so `hasCredentials` arrives as 0 | 1.
type ConnectionRow = Omit<Connection, 'hasCredentials'> & { hasCredentials: number };

function toConnection(row: ConnectionRow): Connection {
  return { ...row, hasCredentials: row.hasCredentials !== 0 };
}

export interface AccountRow {
  id: string;
  connectionId: string;
  companyId: string;
  connectionName: string;
  accountNumber: string;
  label: string | null;
  balance: number | null;
  currency: string;
  updatedAt: string;
}

export interface TxnRow {
  id: string;
  accountId: string;
  externalId: string;
  date: string;
  processedDate: string | null;
  amount: number;
  currency: string;
  description: string;
  memo: string | null;
  kind: string | null;
  status: string | null;
  category: string | null;
  createdAt: string;
}

export interface ScrapeRunRow {
  id: string;
  connectionId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  message: string | null;
  accountsCount: number;
  transactionsCount: number;
}

export interface Summary {
  connectionCount: number;
  accountCount: number;
  byCurrency: { currency: string; total: number; accountCount: number }[];
}

// `hasCredentials` reports whether the vault holds credentials for the
// connection — true for web-app connections, false for Keychain-only ones.
const CONNECTION_COLS =
  'c.id, c.company_id AS companyId, c.display_name AS displayName, ' +
  'c.created_at AS createdAt, c.last_scrape_at AS lastScrapeAt, ' +
  'c.last_status AS lastStatus, (cr.connection_id IS NOT NULL) AS hasCredentials';

const CONNECTION_FROM =
  'FROM connections c LEFT JOIN credentials cr ON cr.connection_id = c.id';

const RUN_COLS =
  'id, connection_id AS connectionId, started_at AS startedAt, finished_at AS finishedAt, ' +
  'status, message, accounts_count AS accountsCount, transactions_count AS transactionsCount';

const TXN_COLS =
  'id, account_id AS accountId, external_id AS externalId, date, ' +
  'processed_date AS processedDate, amount, currency, description, memo, ' +
  'kind, status, category, created_at AS createdAt';

/** All database reads/writes go through this typed repository. */
export class Repo {
  constructor(private readonly db: Database.Database) {}

  // --- Connections ----------------------------------------------------------

  listConnections(): Connection[] {
    const rows = this.db
      .prepare(`SELECT ${CONNECTION_COLS} ${CONNECTION_FROM} ORDER BY c.display_name`)
      .all() as ConnectionRow[];
    return rows.map(toConnection);
  }

  getConnection(id: string): Connection | undefined {
    const row = this.db
      .prepare(`SELECT ${CONNECTION_COLS} ${CONNECTION_FROM} WHERE c.id = ?`)
      .get(id) as ConnectionRow | undefined;
    return row ? toConnection(row) : undefined;
  }

  createConnection(companyId: string, displayName: string): Connection {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO connections (id, company_id, display_name, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, companyId, displayName, new Date().toISOString());
    return this.getConnection(id)!;
  }

  deleteConnection(id: string): void {
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  }

  setConnectionStatus(id: string, status: string, scrapeAt?: string): void {
    if (scrapeAt) {
      this.db
        .prepare('UPDATE connections SET last_status = ?, last_scrape_at = ? WHERE id = ?')
        .run(status, scrapeAt, id);
    } else {
      this.db.prepare('UPDATE connections SET last_status = ? WHERE id = ?').run(status, id);
    }
  }

  // --- Accounts & transactions ---------------------------------------------

  listAccounts(): AccountRow[] {
    return this.db
      .prepare(
        `SELECT a.id, a.connection_id AS connectionId, c.company_id AS companyId,
                c.display_name AS connectionName, a.account_number AS accountNumber,
                a.label, a.balance, a.currency, a.updated_at AS updatedAt
         FROM accounts a
         JOIN connections c ON c.id = a.connection_id
         ORDER BY c.display_name, a.account_number`,
      )
      .all() as AccountRow[];
  }

  listTransactions(opts: { accountId?: string; limit?: number }): TxnRow[] {
    return this.db
      .prepare(
        `SELECT ${TXN_COLS}
         FROM transactions
         WHERE (@accountId IS NULL OR account_id = @accountId)
         ORDER BY date DESC, created_at DESC
         LIMIT @limit`,
      )
      .all({ accountId: opts.accountId ?? null, limit: opts.limit ?? 200 }) as TxnRow[];
  }

  getTransaction(id: string): TxnRow | undefined {
    return this.db
      .prepare(`SELECT ${TXN_COLS} FROM transactions WHERE id = ?`)
      .get(id) as TxnRow | undefined;
  }

  /** Sets one transaction's category (used when the user moves it by hand). */
  updateTransactionCategory(id: string, category: string): void {
    this.db.prepare('UPDATE transactions SET category = ? WHERE id = ?').run(category, id);
  }

  summary(): Summary {
    const byCurrency = this.db
      .prepare(
        `SELECT currency, COALESCE(SUM(balance), 0) AS total, COUNT(*) AS accountCount
         FROM accounts GROUP BY currency ORDER BY currency`,
      )
      .all() as { currency: string; total: number; accountCount: number }[];
    const connectionCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }
    ).n;
    const accountCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
    ).n;
    return { connectionCount, accountCount, byCurrency };
  }

  /** Upserts every account + transaction from a scrape, in one transaction. */
  saveScrapeResult(
    connectionId: string,
    accounts: NormalizedAccount[],
  ): { accounts: number; transactions: number } {
    const upsertAccount = this.db.prepare(
      `INSERT INTO accounts (id, connection_id, account_number, label, balance, currency, updated_at)
       VALUES (@id, @connectionId, @accountNumber, @label, @balance, @currency, @updatedAt)
       ON CONFLICT (connection_id, account_number) DO UPDATE SET
         label = excluded.label, balance = excluded.balance,
         currency = excluded.currency, updated_at = excluded.updated_at
       RETURNING id`,
    );
    const upsertTxn = this.db.prepare(
      `INSERT INTO transactions
         (id, account_id, external_id, date, processed_date, amount, currency,
          description, memo, kind, status, raw_json, created_at)
       VALUES
         (@id, @accountId, @externalId, @date, @processedDate, @amount, @currency,
          @description, @memo, @kind, @status, @rawJson, @createdAt)
       ON CONFLICT (account_id, external_id) DO UPDATE SET
         date = excluded.date, processed_date = excluded.processed_date,
         amount = excluded.amount, currency = excluded.currency,
         description = excluded.description, memo = excluded.memo,
         kind = excluded.kind, status = excluded.status, raw_json = excluded.raw_json`,
    );

    let txnCount = 0;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      for (const account of accounts) {
        const row = upsertAccount.get({
          id: randomUUID(),
          connectionId,
          accountNumber: account.accountNumber,
          label: account.label ?? null,
          balance: account.balance ?? null,
          currency: account.currency,
          updatedAt: now,
        }) as { id: string };

        for (const txn of account.transactions) {
          upsertTxn.run({
            id: randomUUID(),
            accountId: row.id,
            externalId: txn.externalId,
            date: txn.date,
            processedDate: txn.processedDate ?? null,
            amount: txn.amount,
            currency: txn.currency,
            description: txn.description,
            memo: txn.memo ?? null,
            kind: txn.kind ?? null,
            status: txn.status ?? null,
            rawJson: txn.raw ? JSON.stringify(txn.raw) : null,
            createdAt: now,
          });
          txnCount += 1;
        }
      }
    })();

    return { accounts: accounts.length, transactions: txnCount };
  }

  // --- Categorization -------------------------------------------------------

  /** Distinct transaction descriptions that have no category yet. */
  uncategorizedDescriptions(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT description FROM transactions WHERE category IS NULL')
      .all() as { description: string }[];
    return rows.map((row) => row.description);
  }

  getCachedCategory(key: string): { category: string; source: string } | undefined {
    return this.db
      .prepare('SELECT category, source FROM category_cache WHERE description_key = ?')
      .get(key) as { category: string; source: string } | undefined;
  }

  cacheCategory(key: string, category: string, source: string): void {
    this.db
      .prepare(
        `INSERT INTO category_cache (description_key, category, source, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (description_key) DO UPDATE SET
           category = excluded.category, source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(key, category, source, new Date().toISOString());
  }

  /** Applies a category to every still-uncategorized transaction with this description. */
  applyCategory(description: string, category: string): number {
    return this.db
      .prepare('UPDATE transactions SET category = ? WHERE description = ? AND category IS NULL')
      .run(category, description).changes;
  }

  // --- Merchant rules -------------------------------------------------------
  // A user-set rule mapping an exact transaction description to a category, so
  // future transactions from that business categorize the same way.

  listMerchantRules(): { description: string; category: string }[] {
    return this.db
      .prepare('SELECT description, category FROM merchant_rules')
      .all() as { description: string; category: string }[];
  }

  setMerchantRule(description: string, category: string): void {
    this.db
      .prepare(
        `INSERT INTO merchant_rules (description, category, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (description) DO UPDATE SET category = excluded.category`,
      )
      .run(description, category, new Date().toISOString());
  }

  /** Forces a category onto every transaction with this exact description. */
  applyMerchantRule(description: string, category: string): number {
    return this.db
      .prepare('UPDATE transactions SET category = ? WHERE description = ?')
      .run(category, description).changes;
  }

  /** ILS expense totals per category within [start, end) — ISO date strings. */
  monthlySpending(start: string, end: string): { category: string; total: number }[] {
    return this.db
      .prepare(
        `SELECT category, SUM(-amount) AS total
         FROM transactions
         WHERE category IS NOT NULL AND amount < 0 AND currency = 'ILS'
           AND date >= @start AND date < @end
         GROUP BY category`,
      )
      .all({ start, end }) as { category: string; total: number }[];
  }

  listBudgets(): { category: string; monthlyAmount: number }[] {
    return this.db
      .prepare('SELECT category, monthly_amount AS monthlyAmount FROM budgets')
      .all() as { category: string; monthlyAmount: number }[];
  }

  setBudget(category: string, monthlyAmount: number): void {
    this.db
      .prepare(
        `INSERT INTO budgets (category, monthly_amount, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (category) DO UPDATE SET
           monthly_amount = excluded.monthly_amount, updated_at = excluded.updated_at`,
      )
      .run(category, monthlyAmount, new Date().toISOString());
  }

  deleteBudget(category: string): void {
    this.db.prepare('DELETE FROM budgets WHERE category = ?').run(category);
  }

  categorizationCounts(): { categorized: number; total: number } {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }
    ).n;
    const categorized = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM transactions WHERE category IS NOT NULL')
        .get() as { n: number }
    ).n;
    return { categorized, total };
  }

  // --- Analytics ------------------------------------------------------------

  /** Total ILS spending & income per calendar month, from @start onward. */
  monthlyTotals(start: string): { month: string; spending: number; income: number }[] {
    return this.db
      .prepare(
        `SELECT substr(date, 1, 7) AS month,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spending,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income
         FROM transactions
         WHERE currency = 'ILS' AND date >= @start
         GROUP BY substr(date, 1, 7)
         ORDER BY month`,
      )
      .all({ start }) as { month: string; spending: number; income: number }[];
  }

  /** ILS expense totals per category in [start, end); uncategorized included. */
  categorySpending(start: string, end: string): { category: string; total: number }[] {
    return this.db
      .prepare(
        `SELECT COALESCE(category, 'Uncategorized') AS category, SUM(-amount) AS total
         FROM transactions
         WHERE amount < 0 AND currency = 'ILS' AND date >= @start AND date < @end
         GROUP BY COALESCE(category, 'Uncategorized')`,
      )
      .all({ start, end }) as { category: string; total: number }[];
  }

  /** Count and mean of ILS expense transactions in [start, end). */
  expenseStats(start: string, end: string): { count: number; avg: number } {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(AVG(-amount), 0) AS avg
         FROM transactions
         WHERE amount < 0 AND currency = 'ILS' AND date >= @start AND date < @end`,
      )
      .get({ start, end }) as { count: number; avg: number };
  }

  // --- Meta & credential vault ---------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  getCredentialBlob(connectionId: string): string | undefined {
    const row = this.db
      .prepare('SELECT blob FROM credentials WHERE connection_id = ?')
      .get(connectionId) as { blob: string } | undefined;
    return row?.blob;
  }

  saveCredentialBlob(connectionId: string, blob: string): void {
    this.db
      .prepare(
        `INSERT INTO credentials (connection_id, blob, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET
           blob = excluded.blob, updated_at = excluded.updated_at`,
      )
      .run(connectionId, blob, new Date().toISOString());
  }

  // --- Scrape runs ----------------------------------------------------------

  createRun(connectionId: string): ScrapeRunRow {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO scrape_runs (id, connection_id, started_at, status) VALUES (?, ?, ?, ?)',
      )
      .run(id, connectionId, new Date().toISOString(), 'running');
    return this.getRun(id)!;
  }

  getRun(id: string): ScrapeRunRow | undefined {
    return this.db
      .prepare(`SELECT ${RUN_COLS} FROM scrape_runs WHERE id = ?`)
      .get(id) as ScrapeRunRow | undefined;
  }

  updateRun(
    id: string,
    fields: Partial<{
      status: string;
      message: string | null;
      finishedAt: string | null;
      accountsCount: number;
      transactionsCount: number;
    }>,
  ): void {
    const columns: Record<string, string> = {
      status: 'status',
      message: 'message',
      finishedAt: 'finished_at',
      accountsCount: 'accounts_count',
      transactionsCount: 'transactions_count',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in fields) {
        sets.push(`${column} = ?`);
        values.push((fields as Record<string, unknown>)[key]);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE scrape_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
}
