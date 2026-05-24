import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  BrokeragePerformanceData,
  NormalizedAccount,
  NormalizedHolding,
} from './scrapers.js';
import type { Loan } from './loans.js';

/** Tracks Israeli retail loans recognise: a fixed-rate loan, a prime-linked
 *  loan (prime + margin, no index linkage), and the CPI-linked variants of
 *  each (the "tzmuda" tracks common in mortgages). */
export type RateType = 'fixed' | 'prime' | 'cpi-fixed' | 'cpi-prime';

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
  /** When true, this account is left out of the net-worth total. */
  excluded: boolean;
}

// SQLite has no boolean type, so `excluded` arrives as 0 | 1.
type AccountRowDb = Omit<AccountRow, 'excluded'> & { excluded: number };

export interface HoldingRow {
  accountId: string;
  symbol: string;
  description: string | null;
  units: number;
  price: number | null;
  currency: string;
  costBasis: number | null;
  openPnl: number | null;
  updatedAt: string;
}

export interface ValueSnapshotRow {
  accountId: string;
  date: string;
  value: number;
  currency: string;
}

export interface HoldingSnapshotRow {
  accountId: string;
  symbol: string;
  date: string;
  units: number;
  price: number | null;
  value: number;
  currency: string;
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
  /** When set, the id of the transaction that refunds/reimburses this expense. */
  refundId?: string | null;
  /** When set, the id of the expense this transaction is a refund for. */
  refundForId?: string | null;
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
  manualAssetCount: number;
  byCurrency: { currency: string; total: number; accountCount: number }[];
}

export interface ManualAsset {
  id: string;
  kind: string;
  name: string;
  value: number;
  currency: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  /** When true, this asset is left out of the net-worth total. */
  excluded: boolean;
}

// SQLite stores `details` as JSON text and `excluded` as 0 | 1.
type ManualAssetRow = Omit<ManualAsset, 'details' | 'excluded'> & {
  details: string | null;
  excluded: number;
};

function toManualAsset(row: ManualAssetRow): ManualAsset {
  let details: Record<string, unknown> | null = null;
  if (row.details) {
    try {
      const parsed = JSON.parse(row.details) as unknown;
      if (parsed && typeof parsed === 'object') {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      details = null;
    }
  }
  return { ...row, details, excluded: row.excluded !== 0 };
}

/** A savings goal. `kind` decides how the budget engine funds it:
 *   - `monthly`: a fixed `monthlyAmount` set aside each month until the
 *     target is reached (the original behaviour).
 *   - `lump`: the full target is reserved in one shot the first month its
 *     amount fits the budget, then held until the user marks it used. */
export type PiggyKind = 'monthly' | 'lump';

export interface PiggyBank {
  id: string;
  name: string;
  emoji: string;
  kind: PiggyKind;
  targetAmount: number;
  monthlyAmount: number;
  currency: string;
  sortOrder: number;
  onHold: boolean;
  createdAt: string;
  updatedAt: string;
}

// SQLite has no boolean type, so `onHold` arrives as 0 | 1.
type PiggyBankRow = Omit<PiggyBank, 'onHold' | 'kind'> & {
  onHold: number;
  kind: string;
};

function toPiggyBank(row: PiggyBankRow): PiggyBank {
  return {
    ...row,
    onHold: row.onHold !== 0,
    kind: row.kind === 'lump' ? 'lump' : 'monthly',
  };
}

/** A single month's set-aside for one piggy bank. */
export interface PiggyContribution {
  piggyId: string;
  month: string;
  amount: number;
  status: 'funded' | 'skipped';
}

/** One person (besides the user) on a split, and what they owe for it. */
export interface SplitwiseCounterparty {
  id: number;
  name: string;
  owed: number;
}

/** A Hon transaction linked to the Splitwise expense created from it. */
export interface SplitwiseLink {
  transactionId: string;
  expenseId: string;
  groupId: string | null;
  currency: string;
  owedToMe: number;
  counterparties: SplitwiseCounterparty[];
  paidAmount: number;
  /** 'open' | 'partial' | 'paid' */
  paidState: string;
  createdAt: string;
  syncedAt: string | null;
}

type SplitwiseLinkRow = Omit<SplitwiseLink, 'counterparties'> & { counterparties: string };

function toSplitwiseLink(row: SplitwiseLinkRow): SplitwiseLink {
  let counterparties: SplitwiseCounterparty[] = [];
  try {
    const parsed = JSON.parse(row.counterparties) as unknown;
    if (Array.isArray(parsed)) counterparties = parsed as SplitwiseCounterparty[];
  } catch {
    counterparties = [];
  }
  return { ...row, counterparties };
}

// `hasCredentials` reports whether the vault holds credentials for the
// connection.
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
    const rows = this.db
      .prepare(
        `SELECT a.id, a.connection_id AS connectionId, c.company_id AS companyId,
                c.display_name AS connectionName, a.account_number AS accountNumber,
                a.label, a.balance, a.currency, a.updated_at AS updatedAt,
                a.excluded
         FROM accounts a
         JOIN connections c ON c.id = a.connection_id
         ORDER BY c.display_name, a.account_number`,
      )
      .all() as AccountRowDb[];
    return rows.map((r) => ({ ...r, excluded: r.excluded !== 0 }));
  }

  /** Every brokerage position across all accounts. */
  listHoldings(): HoldingRow[] {
    return this.db
      .prepare(
        `SELECT account_id AS accountId, symbol, description, units, price,
                currency, cost_basis AS costBasis, open_pnl AS openPnl,
                updated_at AS updatedAt
         FROM holdings
         ORDER BY symbol`,
      )
      .all() as HoldingRow[];
  }

  /** Brokerage accounts joined with their connection's company id. */
  listBrokerageAccounts(snaptradeCompanyId: string): AccountRow[] {
    return this.listAccounts().filter((a) => a.companyId === snaptradeCompanyId);
  }

  /**
   * Returns the date-range bounds of stored history for a single position.
   * `count` lets the caller skip the Yahoo backfill when enough history is
   * already in the database.
   */
  holdingSnapshotBounds(accountId: string, symbol: string):
    { count: number; firstDate: string | null; lastDate: string | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(date) AS firstDate, MAX(date) AS lastDate
         FROM holding_value_snapshots
         WHERE account_id = ? AND symbol = ?`,
      )
      .get(accountId, symbol) as
        { count: number; firstDate: string | null; lastDate: string | null };
    return row;
  }

  /**
   * Bulk-inserts a historical price series for one position into the per-
   * holding snapshots table. Existing rows for the same (account, symbol,
   * date) are left alone — Hon's own daily syncs are the source of truth.
   */
  backfillHoldingHistory(
    accountId: string,
    symbol: string,
    units: number,
    history: { date: string; price: number; currency: string }[],
  ): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO holding_value_snapshots
         (account_id, symbol, date, units, price, value, currency)
       VALUES (@accountId, @symbol, @date, @units, @price, @value, @currency)`,
    );
    let inserted = 0;
    this.db.transaction(() => {
      for (const point of history) {
        const r = insert.run({
          accountId,
          symbol,
          date: point.date,
          units,
          price: point.price,
          value: units * point.price,
          currency: point.currency,
        });
        if (r.changes) inserted += 1;
      }
    })();
    return inserted;
  }

  /** Cached SnapTrade performance reports, keyed by connection id. */
  listBrokeragePerformance(): { connectionId: string; data: BrokeragePerformanceData; fetchedAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT connection_id AS connectionId, data_json AS dataJson,
                fetched_at AS fetchedAt
         FROM brokerage_performance`,
      )
      .all() as { connectionId: string; dataJson: string; fetchedAt: string }[];
    return rows
      .map((r) => {
        try {
          return {
            connectionId: r.connectionId,
            data: JSON.parse(r.dataJson) as BrokeragePerformanceData,
            fetchedAt: r.fetchedAt,
          };
        } catch {
          return null;
        }
      })
      .filter((r): r is { connectionId: string; data: BrokeragePerformanceData; fetchedAt: string } => r !== null);
  }

  saveBrokeragePerformance(connectionId: string, data: BrokeragePerformanceData): void {
    this.db
      .prepare(
        `INSERT INTO brokerage_performance (connection_id, data_json, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT (connection_id) DO UPDATE SET
           data_json = excluded.data_json, fetched_at = excluded.fetched_at`,
      )
      .run(connectionId, JSON.stringify(data), new Date().toISOString());
  }

  /** Every per-holding price/value snapshot, oldest first. */
  listHoldingSnapshots(): HoldingSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT account_id AS accountId, symbol, date, units, price, value, currency
         FROM holding_value_snapshots
         ORDER BY date`,
      )
      .all() as HoldingSnapshotRow[];
  }

  /** Every recorded brokerage value snapshot, oldest first. */
  listValueSnapshots(): ValueSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT account_id AS accountId, date, value, currency
         FROM account_value_snapshots
         ORDER BY date`,
      )
      .all() as ValueSnapshotRow[];
  }

  listTransactions(opts: { accountId?: string; limit?: number }): TxnRow[] {
    return this.db
      .prepare(
        `SELECT ${TXN_COLS},
                (SELECT refund_id FROM transaction_links
                   WHERE expense_id = transactions.id) AS refundId,
                (SELECT expense_id FROM transaction_links
                   WHERE refund_id = transactions.id) AS refundForId
         FROM transactions
         WHERE (@accountId IS NULL OR account_id = @accountId)
         ORDER BY date DESC, created_at DESC
         LIMIT @limit`,
      )
      .all({ accountId: opts.accountId ?? null, limit: opts.limit ?? 200 }) as TxnRow[];
  }

  /** Sets one account's balance by hand (scrapers do not report card balances). */
  setAccountBalance(id: string, balance: number): void {
    this.db
      .prepare('UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?')
      .run(balance, new Date().toISOString(), id);
  }

  /** Includes or excludes one account from the net-worth total. */
  setAccountExcluded(id: string, excluded: boolean): void {
    this.db
      .prepare('UPDATE accounts SET excluded = ? WHERE id = ?')
      .run(excluded ? 1 : 0, id);
  }

  // --- Refund / reimbursement links ----------------------------------------

  listTransactionLinks(): { expenseId: string; refundId: string }[] {
    return this.db
      .prepare('SELECT expense_id AS expenseId, refund_id AS refundId FROM transaction_links')
      .all() as { expenseId: string; refundId: string }[];
  }

  /** Links an expense to its offsetting refund; a refund can offset only one. */
  setTransactionLink(expenseId: string, refundId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM transaction_links WHERE refund_id = ?').run(refundId);
      this.db
        .prepare(
          `INSERT INTO transaction_links (expense_id, refund_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT (expense_id) DO UPDATE SET refund_id = excluded.refund_id`,
        )
        .run(expenseId, refundId, new Date().toISOString());
    })();
  }

  deleteTransactionLink(expenseId: string): void {
    this.db.prepare('DELETE FROM transaction_links WHERE expense_id = ?').run(expenseId);
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

  // --- Splitwise links ------------------------------------------------------
  // Maps a Hon transaction to the Splitwise expense created from it. The paid
  // state is recomputed on each Splitwise refresh, not stored by the client.

  private static readonly SW_COLS =
    'transaction_id AS transactionId, expense_id AS expenseId, group_id AS groupId, ' +
    'currency, owed_to_me AS owedToMe, counterparties, paid_amount AS paidAmount, ' +
    'paid_state AS paidState, created_at AS createdAt, synced_at AS syncedAt';

  listSplitwiseLinks(): SplitwiseLink[] {
    const rows = this.db
      .prepare(`SELECT ${Repo.SW_COLS} FROM splitwise_links ORDER BY created_at`)
      .all() as SplitwiseLinkRow[];
    return rows.map(toSplitwiseLink);
  }

  getSplitwiseLink(transactionId: string): SplitwiseLink | undefined {
    const row = this.db
      .prepare(`SELECT ${Repo.SW_COLS} FROM splitwise_links WHERE transaction_id = ?`)
      .get(transactionId) as SplitwiseLinkRow | undefined;
    return row ? toSplitwiseLink(row) : undefined;
  }

  /** Records (or replaces) the link from a transaction to a Splitwise expense. */
  createSplitwiseLink(link: {
    transactionId: string;
    expenseId: string;
    groupId: string | null;
    currency: string;
    owedToMe: number;
    counterparties: SplitwiseCounterparty[];
  }): SplitwiseLink {
    this.db
      .prepare(
        `INSERT INTO splitwise_links
           (transaction_id, expense_id, group_id, currency, owed_to_me,
            counterparties, paid_amount, paid_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'open', ?)
         ON CONFLICT (transaction_id) DO UPDATE SET
           expense_id = excluded.expense_id, group_id = excluded.group_id,
           currency = excluded.currency, owed_to_me = excluded.owed_to_me,
           counterparties = excluded.counterparties,
           paid_amount = 0, paid_state = 'open', synced_at = NULL`,
      )
      .run(
        link.transactionId,
        link.expenseId,
        link.groupId,
        link.currency,
        link.owedToMe,
        JSON.stringify(link.counterparties),
        new Date().toISOString(),
      );
    return this.getSplitwiseLink(link.transactionId)!;
  }

  /** Updates a link's paid figures after a Splitwise refresh. */
  updateSplitwiseLinkPaid(transactionId: string, paidAmount: number, paidState: string): void {
    this.db
      .prepare(
        `UPDATE splitwise_links SET paid_amount = ?, paid_state = ?, synced_at = ?
         WHERE transaction_id = ?`,
      )
      .run(paidAmount, paidState, new Date().toISOString(), transactionId);
  }

  deleteSplitwiseLink(transactionId: string): void {
    this.db.prepare('DELETE FROM splitwise_links WHERE transaction_id = ?').run(transactionId);
  }

  summary(): Summary {
    // Net-worth totals skip anything the user has excluded.
    const accountTotals = this.db
      .prepare(
        `SELECT currency, COALESCE(SUM(balance), 0) AS total, COUNT(*) AS accountCount
         FROM accounts WHERE excluded = 0 GROUP BY currency`,
      )
      .all() as { currency: string; total: number; accountCount: number }[];
    const assetTotals = this.db
      .prepare(
        `SELECT currency, COALESCE(SUM(value), 0) AS total, COUNT(*) AS n
         FROM manual_assets WHERE excluded = 0 GROUP BY currency`,
      )
      .all() as { currency: string; total: number; n: number }[];

    // Net worth spans both scraped accounts and manually-valued assets, so the
    // per-currency totals merge the two before any FX conversion.
    const totals = new Map<
      string,
      { currency: string; total: number; accountCount: number }
    >();
    for (const row of accountTotals) {
      totals.set(row.currency, { ...row });
    }
    for (const row of assetTotals) {
      const entry =
        totals.get(row.currency) ?? { currency: row.currency, total: 0, accountCount: 0 };
      entry.total += row.total;
      totals.set(row.currency, entry);
    }
    const byCurrency = [...totals.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    );

    const connectionCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }
    ).n;
    const accountCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
    ).n;
    const manualAssetCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM manual_assets').get() as { n: number }
    ).n;
    return { connectionCount, accountCount, manualAssetCount, byCurrency };
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
         label = excluded.label,
         balance = COALESCE(excluded.balance, accounts.balance),
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

    const deleteHoldings = this.db.prepare('DELETE FROM holdings WHERE account_id = ?');
    const insertHolding = this.db.prepare(
      `INSERT INTO holdings
         (id, account_id, symbol, description, units, price, currency,
          cost_basis, open_pnl, updated_at)
       VALUES
         (@id, @accountId, @symbol, @description, @units, @price, @currency,
          @costBasis, @openPnl, @updatedAt)`,
    );
    const upsertSnapshot = this.db.prepare(
      `INSERT INTO account_value_snapshots (account_id, date, value, currency)
       VALUES (@accountId, @date, @value, @currency)
       ON CONFLICT (account_id, date) DO UPDATE SET
         value = excluded.value, currency = excluded.currency`,
    );
    const upsertHoldSnapshot = this.db.prepare(
      `INSERT INTO holding_value_snapshots
         (account_id, symbol, date, units, price, value, currency)
       VALUES (@accountId, @symbol, @date, @units, @price, @value, @currency)
       ON CONFLICT (account_id, symbol, date) DO UPDATE SET
         units = excluded.units, price = excluded.price,
         value = excluded.value, currency = excluded.currency`,
    );

    let txnCount = 0;
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

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

        // Brokerage accounts carry a holdings list — replace the prior
        // positions wholesale, and record today's value for trend graphs.
        if (account.holdings) {
          deleteHoldings.run(row.id);
          for (const h of account.holdings) {
            insertHolding.run({
              id: randomUUID(),
              accountId: row.id,
              symbol: h.symbol,
              description: h.description ?? null,
              units: h.units,
              price: h.price ?? null,
              currency: h.currency,
              costBasis: h.costBasis ?? null,
              openPnl: h.openPnl ?? null,
              updatedAt: now,
            });
          }
          if (account.balance != null) {
            upsertSnapshot.run({
              accountId: row.id,
              date: today,
              value: account.balance,
              currency: account.currency,
            });
          }
          // Per-holding daily snapshot — feeds each position's own sparkline
          // when the user expands a holding in the Insights brokerage view.
          for (const h of account.holdings) {
            const value = h.price != null ? h.units * h.price : null;
            if (value == null) continue;
            upsertHoldSnapshot.run({
              accountId: row.id,
              symbol: h.symbol,
              date: today,
              units: h.units,
              price: h.price ?? null,
              value,
              currency: h.currency,
            });
          }
        }

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

  // --- Manual assets --------------------------------------------------------
  // Cars, property, cash and the like — things the user owns that have no
  // institution to scrape. They count toward net worth via summary().

  private static readonly ASSET_COLS =
    'id, kind, name, value, currency, details, excluded, ' +
    'created_at AS createdAt, updated_at AS updatedAt';

  listManualAssets(): ManualAsset[] {
    const rows = this.db
      .prepare(`SELECT ${Repo.ASSET_COLS} FROM manual_assets ORDER BY created_at`)
      .all() as ManualAssetRow[];
    return rows.map(toManualAsset);
  }

  getManualAsset(id: string): ManualAsset | undefined {
    const row = this.db
      .prepare(`SELECT ${Repo.ASSET_COLS} FROM manual_assets WHERE id = ?`)
      .get(id) as ManualAssetRow | undefined;
    return row ? toManualAsset(row) : undefined;
  }

  createManualAsset(input: {
    kind: string;
    name: string;
    value: number;
    currency: string;
    details: Record<string, unknown> | null;
  }): ManualAsset {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO manual_assets
           (id, kind, name, value, currency, details, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.name,
        input.value,
        input.currency,
        input.details ? JSON.stringify(input.details) : null,
        now,
        now,
      );
    return this.getManualAsset(id)!;
  }

  updateManualAsset(
    id: string,
    fields: Partial<{
      name: string;
      value: number;
      details: Record<string, unknown> | null;
      excluded: boolean;
    }>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      values.push(fields.name);
    }
    if (fields.value !== undefined) {
      sets.push('value = ?');
      values.push(fields.value);
    }
    if (fields.details !== undefined) {
      sets.push('details = ?');
      values.push(fields.details ? JSON.stringify(fields.details) : null);
    }
    if (fields.excluded !== undefined) {
      sets.push('excluded = ?');
      values.push(fields.excluded ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db
      .prepare(`UPDATE manual_assets SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  deleteManualAsset(id: string): void {
    this.db.prepare('DELETE FROM manual_assets WHERE id = ?').run(id);
  }

  // --- Piggy banks ----------------------------------------------------------

  private static readonly PIGGY_COLS =
    'id, name, emoji, kind, target_amount AS targetAmount, ' +
    'monthly_amount AS monthlyAmount, currency, sort_order AS sortOrder, ' +
    'on_hold AS onHold, created_at AS createdAt, updated_at AS updatedAt';

  listPiggyBanks(): PiggyBank[] {
    const rows = this.db
      .prepare(`SELECT ${Repo.PIGGY_COLS} FROM piggy_banks ORDER BY sort_order, created_at`)
      .all() as PiggyBankRow[];
    return rows.map(toPiggyBank);
  }

  getPiggyBank(id: string): PiggyBank | undefined {
    const row = this.db
      .prepare(`SELECT ${Repo.PIGGY_COLS} FROM piggy_banks WHERE id = ?`)
      .get(id) as PiggyBankRow | undefined;
    return row ? toPiggyBank(row) : undefined;
  }

  createPiggyBank(input: {
    name: string;
    emoji: string;
    kind?: PiggyKind;
    targetAmount: number;
    monthlyAmount: number;
    currency: string;
  }): PiggyBank {
    const id = randomUUID();
    const now = new Date().toISOString();
    const nextOrder =
      (this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM piggy_banks').get() as {
        n: number;
      }).n + 1;
    this.db
      .prepare(
        `INSERT INTO piggy_banks
           (id, name, emoji, kind, target_amount, monthly_amount, currency,
            sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.emoji,
        input.kind === 'lump' ? 'lump' : 'monthly',
        input.targetAmount,
        // Lump-sum piggies don't recur, so the column gets the full target
        // — handy if anything ever reads monthlyAmount expecting "what this
        // piggy charges in a fund-able month".
        input.kind === 'lump' ? input.targetAmount : input.monthlyAmount,
        input.currency,
        nextOrder,
        now,
        now,
      );
    return this.getPiggyBank(id)!;
  }

  updatePiggyBank(
    id: string,
    fields: Partial<{
      name: string;
      emoji: string;
      kind: PiggyKind;
      targetAmount: number;
      monthlyAmount: number;
      onHold: boolean;
    }>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      values.push(fields.name);
    }
    if (fields.emoji !== undefined) {
      sets.push('emoji = ?');
      values.push(fields.emoji);
    }
    if (fields.kind !== undefined) {
      sets.push('kind = ?');
      values.push(fields.kind === 'lump' ? 'lump' : 'monthly');
    }
    if (fields.targetAmount !== undefined) {
      sets.push('target_amount = ?');
      values.push(fields.targetAmount);
    }
    if (fields.monthlyAmount !== undefined) {
      sets.push('monthly_amount = ?');
      values.push(fields.monthlyAmount);
    }
    if (fields.onHold !== undefined) {
      sets.push('on_hold = ?');
      values.push(fields.onHold ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE piggy_banks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deletePiggyBank(id: string): void {
    this.db.prepare('DELETE FROM piggy_banks WHERE id = ?').run(id);
  }

  /** Every recorded set-aside, across all piggy banks and months. */
  listPiggyContributions(): PiggyContribution[] {
    return this.db
      .prepare(
        'SELECT piggy_id AS piggyId, month, amount, status FROM piggy_contributions',
      )
      .all() as PiggyContribution[];
  }

  /**
   * Rewrites one month's ledger for one piggy bank — the current month is
   * re-settled on every budget read, so it must overwrite, not accumulate.
   */
  setPiggyContribution(
    piggyId: string,
    month: string,
    amount: number,
    status: 'funded' | 'skipped',
  ): void {
    this.db
      .prepare(
        `INSERT INTO piggy_contributions (piggy_id, month, amount, status, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (piggy_id, month) DO UPDATE SET
           amount = excluded.amount, status = excluded.status`,
      )
      .run(piggyId, month, amount, status, new Date().toISOString());
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

  // --- Merchant recurrence --------------------------------------------------
  // How often a recurring charge bills, keyed by a cleaned merchant name.

  listMerchantFrequencies(): { merchantKey: string; frequency: string }[] {
    return this.db
      .prepare('SELECT merchant_key AS merchantKey, frequency FROM merchant_recurrence')
      .all() as { merchantKey: string; frequency: string }[];
  }

  setMerchantFrequency(merchantKey: string, frequency: string): void {
    this.db
      .prepare(
        `INSERT INTO merchant_recurrence (merchant_key, frequency, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (merchant_key) DO UPDATE SET frequency = excluded.frequency`,
      )
      .run(merchantKey, frequency, new Date().toISOString());
  }

  clearMerchantFrequency(merchantKey: string): void {
    this.db
      .prepare('DELETE FROM merchant_recurrence WHERE merchant_key = ?')
      .run(merchantKey);
  }

  // --- Cancelled subscriptions ----------------------------------------------
  // Subscriptions the user has explicitly marked cancelled. `cancelled_at` is
  // the moment the mark was set — the UI flags any charge after that as a
  // possible "the cancellation didn't take" recurrence.

  listCancelledSubs(): { merchantKey: string; cancelledAt: string }[] {
    return this.db
      .prepare(
        'SELECT merchant_key AS merchantKey, cancelled_at AS cancelledAt FROM cancelled_subscriptions',
      )
      .all() as { merchantKey: string; cancelledAt: string }[];
  }

  markSubCancelled(merchantKey: string): void {
    this.db
      .prepare(
        `INSERT INTO cancelled_subscriptions (merchant_key, cancelled_at)
         VALUES (?, ?)
         ON CONFLICT (merchant_key) DO UPDATE SET cancelled_at = excluded.cancelled_at`,
      )
      .run(merchantKey, new Date().toISOString());
  }

  unmarkSubCancelled(merchantKey: string): void {
    this.db
      .prepare('DELETE FROM cancelled_subscriptions WHERE merchant_key = ?')
      .run(merchantKey);
  }

  // --- Budget tweaks --------------------------------------------------------
  // Manual expected-income override (single value in `meta`) and a per-month
  // savings set-aside. Both feed into the Variable Spending calculation.

  /** The user's manual "Expected income" override, or null when unset. */
  getExpectedIncomeOverride(): number | null {
    const raw = this.getMeta('expected_income_override');
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  setExpectedIncomeOverride(value: number | null): void {
    if (value == null || !Number.isFinite(value)) {
      this.deleteMeta('expected_income_override');
      return;
    }
    this.setMeta('expected_income_override', String(value));
  }

  /** Every per-month savings entry — small dict, returned in full to the UI. */
  listMonthlySavings(): { month: string; amount: number }[] {
    return this.db
      .prepare('SELECT month, amount FROM monthly_savings')
      .all() as { month: string; amount: number }[];
  }

  setMonthlySavings(month: string, amount: number): void {
    if (amount <= 0) {
      this.db.prepare('DELETE FROM monthly_savings WHERE month = ?').run(month);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO monthly_savings (month, amount) VALUES (?, ?)
         ON CONFLICT (month) DO UPDATE SET amount = excluded.amount`,
      )
      .run(month, amount);
  }

  /** ILS expense totals per category within [start, end) — ISO date strings. */
  monthlySpending(
    start: string,
    end: string,
    excludeDescPatterns: string[] = [],
  ): { category: string; total: number }[] {
    const params: Record<string, unknown> = { start, end };
    const exclude = this.buildExcludeClause(excludeDescPatterns, params);
    return this.db
      .prepare(
        `SELECT category, SUM(-amount) AS total
         FROM txn_effective
         WHERE category IS NOT NULL AND amount < 0 AND currency = 'ILS'
           AND date >= @start AND date < @end ${exclude}
         GROUP BY category`,
      )
      .all(params) as { category: string; total: number }[];
  }

  /**
   * ILS money in for [start, end) — positive amounts categorised as Income or
   * Transfers only. Positive amounts in expense categories are partial refunds
   * offsetting a purchase, so they are deliberately left out.
   */
  monthlyInflow(
    start: string,
    end: string,
    excludeDescPatterns: string[] = [],
  ): number {
    const params: Record<string, unknown> = { start, end };
    const exclude = this.buildExcludeClause(excludeDescPatterns, params);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM txn_effective
         WHERE amount > 0 AND currency = 'ILS'
           AND category IN ('Income', 'Transfers')
           AND date >= @start AND date < @end ${exclude}`,
      )
      .get(params) as { total: number };
    return row.total;
  }

  /**
   * Builds the SQL fragment that excludes transactions whose description
   * contains any of the given substrings (case-insensitive). Patterns shorter
   * than 2 chars are dropped — they would match almost everything. Adds the
   * matching @p0, @p1, ... bindings to `params` in place.
   */
  private buildExcludeClause(
    patterns: string[],
    params: Record<string, unknown>,
  ): string {
    const clean = patterns
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length >= 2);
    if (clean.length === 0) return '';
    const parts: string[] = [];
    clean.forEach((p, i) => {
      const key = `excl${i}`;
      params[key] = `%${p}%`;
      parts.push(`LOWER(description) LIKE @${key}`);
    });
    return `AND NOT (${parts.join(' OR ')})`;
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
         FROM txn_effective
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
         FROM txn_effective
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
         FROM txn_effective
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

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
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

  /**
   * `finished_at` of the most recent successful scrape for a connection, used
   * to compute an incremental start date for the next sync. Returns undefined
   * when the connection has no successful scrape yet (first-ever sync).
   */
  lastSuccessfulScrapeAt(connectionId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT finished_at AS finishedAt FROM scrape_runs
         WHERE connection_id = ? AND status = 'success' AND finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(connectionId) as { finishedAt: string } | undefined;
    return row?.finishedAt;
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

  /**
   * Closes any run still marked `running`. A run is only `running` while the
   * sidecar that owns it is alive (its live status is in memory). On a fresh
   * start that process is gone, so such a row is stale — e.g. the app quit
   * mid-sync. Left alone it shows as "syncing" forever; here it is reconciled
   * to an error. Returns the number of runs closed.
   */
  reconcileInterruptedRuns(): number {
    const now = new Date().toISOString();
    const changed = this.db
      .prepare(
        "UPDATE scrape_runs SET status = 'error', finished_at = ?, " +
          "message = 'Sync was interrupted before it finished.' " +
          "WHERE status = 'running'",
      )
      .run(now).changes;
    this.db
      .prepare("UPDATE connections SET last_status = 'error' WHERE last_status = 'running'")
      .run();
    return changed;
  }

  // --- Loans ---------------------------------------------------------------
  // Each loan is stored as its original terms only — start date, principal,
  // term, rate type, and a CPI snapshot at start when linked. The current
  // outstanding is recomputed at read time off the cached BOI/CBS rates, so
  // the figure stays current without a "balance" column to keep in sync.

  private static readonly LOAN_COLS =
    'id, name, principal, start_date AS startDate, term_months AS termMonths, ' +
    'is_prime AS isPrime, is_cpi_linked AS isCpiLinked, rate_value AS rateValue, ' +
    'cpi_start AS cpiStart, currency, excluded, notes, ' +
    'connection_id AS connectionId, external_id AS externalId, ' +
    'created_at AS createdAt, updated_at AS updatedAt';

  listLoans(): Loan[] {
    const rows = this.db
      .prepare(`SELECT ${Repo.LOAN_COLS} FROM loans ORDER BY created_at`)
      .all() as LoanRow[];
    return rows.map(toLoan);
  }

  getLoan(id: string): Loan | undefined {
    const row = this.db
      .prepare(`SELECT ${Repo.LOAN_COLS} FROM loans WHERE id = ?`)
      .get(id) as LoanRow | undefined;
    return row ? toLoan(row) : undefined;
  }

  createLoan(
    input: Omit<Loan, 'id' | 'createdAt' | 'updatedAt' | 'connectionId' | 'externalId'>
      & { connectionId?: string | null; externalId?: string | null },
  ): Loan {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO loans
           (id, name, principal, start_date, term_months, is_prime, is_cpi_linked,
            rate_value, cpi_start, currency, excluded, notes,
            connection_id, external_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.principal,
        input.startDate,
        input.termMonths,
        input.isPrime ? 1 : 0,
        input.isCpiLinked ? 1 : 0,
        input.rateValue,
        input.cpiStart,
        input.currency,
        input.excluded ? 1 : 0,
        input.notes,
        input.connectionId ?? null,
        input.externalId ?? null,
        now,
        now,
      );
    return this.getLoan(id)!;
  }

  /**
   * Upserts a loan scraped from a bank's loans page, keyed by the connection
   * + bank-side loan id. Re-syncs update the same row instead of inserting.
   * The `excluded` and `notes` columns are preserved across syncs so the
   * user's choices are not clobbered by the scraper.
   */
  upsertBankLoan(
    connectionId: string,
    input: Omit<Loan, 'id' | 'connectionId' | 'createdAt' | 'updatedAt' |
      'excluded' | 'notes' | 'cpiStart'> & { cpiStart?: number | null },
  ): Loan {
    const existing = this.db
      .prepare(
        `SELECT id FROM loans WHERE connection_id = ? AND external_id = ?`,
      )
      .get(connectionId, input.externalId) as { id: string } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE loans SET
             name = ?, principal = ?, start_date = ?, term_months = ?,
             is_prime = ?, is_cpi_linked = ?, rate_value = ?,
             currency = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.name,
          input.principal,
          input.startDate,
          input.termMonths,
          input.isPrime ? 1 : 0,
          input.isCpiLinked ? 1 : 0,
          input.rateValue,
          input.currency,
          now,
          existing.id,
        );
      return this.getLoan(existing.id)!;
    }
    return this.createLoan({
      ...input,
      connectionId,
      cpiStart: input.cpiStart ?? null,
      excluded: false,
      notes: null,
    });
  }

  updateLoan(
    id: string,
    fields: Partial<Omit<Loan, 'id' | 'createdAt' | 'updatedAt'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
    if (fields.principal !== undefined) { sets.push('principal = ?'); values.push(fields.principal); }
    if (fields.startDate !== undefined) { sets.push('start_date = ?'); values.push(fields.startDate); }
    if (fields.termMonths !== undefined) { sets.push('term_months = ?'); values.push(fields.termMonths); }
    if (fields.isPrime !== undefined) { sets.push('is_prime = ?'); values.push(fields.isPrime ? 1 : 0); }
    if (fields.isCpiLinked !== undefined) { sets.push('is_cpi_linked = ?'); values.push(fields.isCpiLinked ? 1 : 0); }
    if (fields.rateValue !== undefined) { sets.push('rate_value = ?'); values.push(fields.rateValue); }
    if (fields.cpiStart !== undefined) { sets.push('cpi_start = ?'); values.push(fields.cpiStart); }
    if (fields.currency !== undefined) { sets.push('currency = ?'); values.push(fields.currency); }
    if (fields.excluded !== undefined) { sets.push('excluded = ?'); values.push(fields.excluded ? 1 : 0); }
    if (fields.notes !== undefined) { sets.push('notes = ?'); values.push(fields.notes); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db
      .prepare(`UPDATE loans SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  deleteLoan(id: string): void {
    this.db.prepare('DELETE FROM loans WHERE id = ?').run(id);
  }

  setLoanExcluded(id: string, excluded: boolean): void {
    this.db
      .prepare('UPDATE loans SET excluded = ? WHERE id = ?')
      .run(excluded ? 1 : 0, id);
  }

  // --- Rate cache (BOI prime, CBS CPI) -------------------------------------
  // Memoises a published rate by (series, period). The TTL is enforced by the
  // caller — this layer just stores and retrieves the last-fetched value plus
  // its timestamp, so a stale-but-cached value is still available when the
  // live fetch fails.

  getCachedRate(
    series: string,
    period: string,
  ): { value: number; fetchedAt: string } | undefined {
    return this.db
      .prepare(
        'SELECT value, fetched_at AS fetchedAt FROM rate_cache WHERE series = ? AND period = ?',
      )
      .get(series, period) as { value: number; fetchedAt: string } | undefined;
  }

  cacheRate(series: string, period: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO rate_cache (series, period, value, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (series, period) DO UPDATE SET
           value = excluded.value, fetched_at = excluded.fetched_at`,
      )
      .run(series, period, value, new Date().toISOString());
  }

  // --- Categories ----------------------------------------------------------
  // Replaces what used to be a static list in categorize.ts. The categorizer
  // (LLM + rules), the budget engine and the frontend all read this table so
  // a user-added category is first-class everywhere.

  private static readonly CATEGORY_COLS =
    'name, emoji, color, cat_group AS catGroup, sort_order AS sortOrder, ' +
    'is_builtin AS isBuiltin, created_at AS createdAt';

  listCategories(): Category[] {
    const rows = this.db
      .prepare(
        `SELECT ${Repo.CATEGORY_COLS} FROM categories
         ORDER BY sort_order, name`,
      )
      .all() as CategoryRow[];
    return rows.map(toCategory);
  }

  getCategory(name: string): Category | undefined {
    const row = this.db
      .prepare(`SELECT ${Repo.CATEGORY_COLS} FROM categories WHERE name = ?`)
      .get(name) as CategoryRow | undefined;
    return row ? toCategory(row) : undefined;
  }

  createCategory(input: Omit<Category, 'isBuiltin' | 'createdAt'>): Category {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO categories
           (name, emoji, color, cat_group, sort_order, is_builtin, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        input.name,
        input.emoji,
        input.color,
        input.catGroup,
        input.sortOrder,
        now,
      );
    return this.getCategory(input.name)!;
  }

  updateCategory(
    name: string,
    fields: Partial<Omit<Category, 'name' | 'isBuiltin' | 'createdAt'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.emoji !== undefined) { sets.push('emoji = ?'); values.push(fields.emoji); }
    if (fields.color !== undefined) { sets.push('color = ?'); values.push(fields.color); }
    if (fields.catGroup !== undefined) { sets.push('cat_group = ?'); values.push(fields.catGroup); }
    if (fields.sortOrder !== undefined) { sets.push('sort_order = ?'); values.push(fields.sortOrder); }
    if (sets.length === 0) return;
    values.push(name);
    this.db
      .prepare(`UPDATE categories SET ${sets.join(', ')} WHERE name = ?`)
      .run(...values);
  }

  /**
   * Deletes a custom category. Reassigns its transactions and budgets to
   * 'Other' so nothing dangles. Built-in categories cannot be deleted —
   * callers should check `isBuiltin` and refuse first.
   */
  deleteCategory(name: string): void {
    const row = this.getCategory(name);
    if (!row || row.isBuiltin) return;
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE transactions SET category = 'Other' WHERE category = ?`)
        .run(name);
      this.db
        .prepare(`UPDATE category_cache SET category = 'Other' WHERE category = ?`)
        .run(name);
      this.db
        .prepare(`UPDATE merchant_rules SET category = 'Other' WHERE category = ?`)
        .run(name);
      this.db.prepare(`DELETE FROM budgets WHERE category = ?`).run(name);
      this.db.prepare(`DELETE FROM categories WHERE name = ?`).run(name);
    })();
  }
}

export interface Category {
  name: string;
  emoji: string;
  /** Accent colour as a hex string, e.g. "#5CC773". */
  color: string;
  /** Spending umbrella the budget and group breakdowns use. */
  catGroup: 'essential' | 'fixed' | 'variable';
  sortOrder: number;
  /** True for the seeded categories — they cannot be deleted, only edited. */
  isBuiltin: boolean;
  createdAt: string;
}

interface CategoryRow {
  name: string;
  emoji: string;
  color: string;
  catGroup: string;
  sortOrder: number;
  isBuiltin: number;
  createdAt: string;
}

function toCategory(row: CategoryRow): Category {
  const group: Category['catGroup'] =
    row.catGroup === 'essential' || row.catGroup === 'fixed' ? row.catGroup : 'variable';
  return { ...row, catGroup: group, isBuiltin: row.isBuiltin !== 0 };
}

// SQLite stores the loan booleans as 0|1.
interface LoanRow {
  id: string;
  name: string;
  principal: number;
  startDate: string;
  termMonths: number;
  isPrime: number;
  isCpiLinked: number;
  rateValue: number;
  cpiStart: number | null;
  currency: string;
  excluded: number;
  notes: string | null;
  connectionId: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toLoan(row: LoanRow): Loan {
  return {
    ...row,
    isPrime: row.isPrime !== 0,
    isCpiLinked: row.isCpiLinked !== 0,
    excluded: row.excluded !== 0,
  };
}
