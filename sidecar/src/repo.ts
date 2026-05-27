import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  BrokeragePerformanceData,
  NormalizedAccount,
  NormalizedHolding,
} from './scrapers.js';
import type { Loan } from './loans.js';
import { matchPaymentToLoan } from './loanMatcher.js';

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
  /** User-set "when I actually started investing here" date (YYYY-MM-DD).
   *  Used by the Insights brokerage chart to clip pretend pre-link history
   *  from the Yahoo / Maya backfill. Null means "no override — show all". */
  inceptionDate: string | null;
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
  /** Bank-reported market value, when the scraper passes one through. */
  value: number | null;
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
  voucherCount: number;
  byCurrency: { currency: string; total: number; accountCount: number }[];
}

/**
 * A voucher or gift card the user holds — Shufersal Tav Hazahav, Pluxee /
 * Sodexo, Cibus, employer holiday vouchers, etc. Contributes to net worth
 * unless `excluded` is set. Like loans, the row supports both hand-entered
 * vouchers (`connectionId` null) and rows synced from a provider portal in
 * the future (`connectionId` + `externalId` keyed for upsert).
 */
export interface Voucher {
  id: string;
  name: string;
  provider: string;
  balance: number;
  currency: string;
  /** YYYY-MM-DD; null when the voucher does not expire (or is unknown). */
  expiresOn: string | null;
  notes: string | null;
  /** When true, the voucher is left out of the net-worth total. */
  excluded: boolean;
  connectionId: string | null;
  externalId: string | null;
  /**
   * True once the user has renamed the voucher in Hon. The provider sync
   * (when added) will preserve `name` and `notes` instead of clobbering.
   */
  nameOverridden: boolean;
  createdAt: string;
  updatedAt: string;
}

type VoucherRow = Omit<Voucher, 'excluded' | 'nameOverridden'> & {
  excluded: number;
  nameOverridden: number;
};

function toVoucher(row: VoucherRow): Voucher {
  return {
    ...row,
    excluded: row.excluded !== 0,
    nameOverridden: row.nameOverridden !== 0,
  };
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
                a.excluded, a.inception_date AS inceptionDate
         FROM accounts a
         JOIN connections c ON c.id = a.connection_id
         ORDER BY c.display_name, a.account_number`,
      )
      .all() as AccountRowDb[];
    return rows.map((r) => ({ ...r, excluded: r.excluded !== 0 }));
  }

  /** Sets (or clears, when null) the user-defined inception date for an
   *  account — the "when I actually started investing here" boundary used by
   *  the brokerage chart to clip synthetic Yahoo/Maya pre-link history. */
  setAccountInceptionDate(id: string, inceptionDate: string | null): void {
    this.db
      .prepare('UPDATE accounts SET inception_date = ?, updated_at = ? WHERE id = ?')
      .run(inceptionDate, new Date().toISOString(), id);
  }

  /** Every brokerage position across all accounts. */
  listHoldings(): HoldingRow[] {
    return this.db
      .prepare(
        `SELECT account_id AS accountId, symbol, description, units, price,
                currency, cost_basis AS costBasis, open_pnl AS openPnl,
                value, updated_at AS updatedAt
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
    // refundId/refundForId hint that a transaction participates in *some*
    // refund link, for UI decoration; the full per-allocation detail comes
    // from `listTransactionLinks()`. With N:M linking, an expense or refund
    // can have multiple peers — these subqueries pick one (the largest
    // allocation) so the column stays scalar.
    return this.db
      .prepare(
        `SELECT ${TXN_COLS},
                (SELECT refund_id FROM transaction_links
                   WHERE expense_id = transactions.id
                   ORDER BY amount DESC LIMIT 1) AS refundId,
                (SELECT expense_id FROM transaction_links
                   WHERE refund_id = transactions.id
                   ORDER BY amount DESC LIMIT 1) AS refundForId
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

  listTransactionLinks(): { expenseId: string; refundId: string; amount: number }[] {
    return this.db
      .prepare(
        `SELECT expense_id AS expenseId, refund_id AS refundId, amount
         FROM transaction_links`,
      )
      .all() as { expenseId: string; refundId: string; amount: number }[];
  }

  /**
   * Adds (or updates) one allocation: links `amount` of a refund/inflow
   * transaction to an expense. Multiple expenses can share one refund — the
   * sum of allocations is capped at the refund's magnitude by validation in
   * the API layer; this method is unchecked and idempotent on (expense,
   * refund), updating the amount when called again.
   */
  setTransactionLink(expenseId: string, refundId: string, amount: number): void {
    this.db
      .prepare(
        `INSERT INTO transaction_links (id, expense_id, refund_id, amount, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (expense_id, refund_id) DO UPDATE SET amount = excluded.amount`,
      )
      .run(randomUUID(), expenseId, refundId, amount, new Date().toISOString());
  }

  /** Removes one specific (expense, refund) allocation. */
  deleteTransactionLink(expenseId: string, refundId?: string): void {
    if (refundId) {
      this.db
        .prepare('DELETE FROM transaction_links WHERE expense_id = ? AND refund_id = ?')
        .run(expenseId, refundId);
    } else {
      this.db.prepare('DELETE FROM transaction_links WHERE expense_id = ?').run(expenseId);
    }
  }

  /** Returns the unallocated portion of a refund — `ABS(amount) − Σ allocations`. */
  refundRemaining(refundId: string): number {
    const refund = this.db
      .prepare('SELECT amount FROM transactions WHERE id = ?')
      .get(refundId) as { amount: number } | undefined;
    if (!refund) return 0;
    const used = (this.db
      .prepare('SELECT COALESCE(SUM(amount), 0) AS used FROM transaction_links WHERE refund_id = ?')
      .get(refundId) as { used: number }).used;
    return Math.max(0, Math.abs(refund.amount) - used);
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
    const voucherTotals = this.db
      .prepare(
        `SELECT currency, COALESCE(SUM(balance), 0) AS total, COUNT(*) AS n
         FROM vouchers WHERE excluded = 0 GROUP BY currency`,
      )
      .all() as { currency: string; total: number; n: number }[];

    // Net worth spans scraped accounts, manually-valued assets, and vouchers,
    // so the per-currency totals merge all three before any FX conversion.
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
    for (const row of voucherTotals) {
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
    const voucherCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    ).n;
    return { connectionCount, accountCount, manualAssetCount, voucherCount, byCurrency };
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
          cost_basis, open_pnl, value, updated_at)
       VALUES
         (@id, @accountId, @symbol, @description, @units, @price, @currency,
          @costBasis, @openPnl, @value, @updatedAt)`,
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
    // Loan-matcher helpers — hoisted out of the per-transaction loop so
    // SQLite only compiles these statements once per scrape, not once per txn.
    const selectTxnLoanId = this.db.prepare<[string, string]>(
      'SELECT id, loan_id FROM transactions WHERE account_id = ? AND external_id = ?',
    );
    const updateTxnLoanId = this.db.prepare<[string, string]>(
      'UPDATE transactions SET loan_id = ? WHERE id = ?',
    );
    // Compute the loans for this connection once; the inner loop is pure.
    const loansForConn = this.listLoans().filter((l) => l.connectionId === connectionId);

    let txnCount = 0;
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    // Sets the provider-discovered inception date only when the account
    // doesn't already have one (SET ... WHERE inception_date IS NULL). A
    // user-set override always wins.
    const fillInception = this.db.prepare(
      'UPDATE accounts SET inception_date = ? '
      + 'WHERE id = ? AND inception_date IS NULL',
    );

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

        // Provider-reported "first activity" date — SnapTrade fills this
        // from getActivities; other connectors can supply it too. Only
        // populates the column when the user hasn't already pinned a date
        // themselves.
        if (account.inceptionDate) {
          fillInception.run(account.inceptionDate, row.id);
        }

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
              value: h.value ?? null,
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
          // Prefer the bank-reported value; only fall back to units × price
          // when the scraper didn't supply one (legacy SnapTrade path).
          for (const h of account.holdings) {
            const value = h.value != null ? h.value
              : (h.price != null ? h.units * h.price : null);
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

          // Auto-link bank-loan payments. loansForConn is computed once
          // above; the matcher is pure. Skip rows that already carry a
          // loan_id so a user's manual link isn't clobbered on re-sync.
          if (loansForConn.length > 0) {
            const dbTxn = selectTxnLoanId.get(row.id, txn.externalId) as
              | { id: string; loan_id: string | null }
              | undefined;
            if (dbTxn && !dbTxn.loan_id) {
              const match = matchPaymentToLoan(
                { description: txn.description, amount: txn.amount },
                loansForConn,
              );
              if (match) {
                updateTxnLoanId.run(match, dbTxn.id);
              }
            }
          }
        }

        // Cancellation sweep: a pending row that was here before but isn't in
        // this scrape was cancelled at the bank (Max drops them when the
        // merchant voids a hold, for example). Scoped to the last 90 days so
        // we never delete an old pending row that simply fell outside the
        // current scrape window. Completed rows are never auto-deleted —
        // those represent actual recorded history.
        const scrapedExternalIds = new Set(
          account.transactions.map((t) => t.externalId),
        );
        const stalePending = this.db
          .prepare(
            `SELECT id, external_id FROM transactions
             WHERE account_id = ? AND status = 'pending'
               AND date >= date('now', '-90 days')`,
          )
          .all(row.id) as { id: string; external_id: string }[];
        for (const sp of stalePending) {
          if (!scrapedExternalIds.has(sp.external_id)) {
            this.db.prepare('DELETE FROM transactions WHERE id = ?').run(sp.id);
          }
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

  // --- Vouchers -------------------------------------------------------------
  // Gift cards and prepaid vouchers — Shufersal Tav Hazahav, Pluxee/Sodexo,
  // Cibus, employer gift sums. Each row holds a current balance that the
  // user maintains; when a provider scraper lands the row carries a
  // connection_id + external_id and updates upsert-in-place.

  private static readonly VOUCHER_COLS =
    'id, name, provider, balance, currency, ' +
    'expires_on AS expiresOn, notes, excluded, ' +
    'connection_id AS connectionId, external_id AS externalId, ' +
    'name_overridden AS nameOverridden, ' +
    'created_at AS createdAt, updated_at AS updatedAt';

  listVouchers(): Voucher[] {
    const rows = this.db
      .prepare(`SELECT ${Repo.VOUCHER_COLS} FROM vouchers ORDER BY created_at`)
      .all() as VoucherRow[];
    return rows.map(toVoucher);
  }

  getVoucher(id: string): Voucher | undefined {
    const row = this.db
      .prepare(`SELECT ${Repo.VOUCHER_COLS} FROM vouchers WHERE id = ?`)
      .get(id) as VoucherRow | undefined;
    return row ? toVoucher(row) : undefined;
  }

  createVoucher(input: {
    name: string;
    provider: string;
    balance: number;
    currency: string;
    expiresOn?: string | null;
    notes?: string | null;
    excluded?: boolean;
    connectionId?: string | null;
    externalId?: string | null;
    nameOverridden?: boolean;
  }): Voucher {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO vouchers
           (id, name, provider, balance, currency, expires_on, notes,
            excluded, connection_id, external_id, name_overridden,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.provider,
        input.balance,
        input.currency,
        input.expiresOn ?? null,
        input.notes ?? null,
        input.excluded ? 1 : 0,
        input.connectionId ?? null,
        input.externalId ?? null,
        input.nameOverridden ? 1 : 0,
        now,
        now,
      );
    return this.getVoucher(id)!;
  }

  updateVoucher(
    id: string,
    fields: Partial<{
      name: string;
      provider: string;
      balance: number;
      currency: string;
      expiresOn: string | null;
      notes: string | null;
      excluded: boolean;
      nameOverridden: boolean;
    }>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      values.push(fields.name);
      // A rename via this code path is a user edit; flip the override flag
      // so a future provider sync leaves the new name alone. (Matches the
      // loans semantics.)
      if (fields.nameOverridden === undefined) {
        sets.push('name_overridden = ?');
        values.push(1);
      }
    }
    if (fields.nameOverridden !== undefined) {
      sets.push('name_overridden = ?');
      values.push(fields.nameOverridden ? 1 : 0);
    }
    if (fields.provider !== undefined) { sets.push('provider = ?'); values.push(fields.provider); }
    if (fields.balance !== undefined) { sets.push('balance = ?'); values.push(fields.balance); }
    if (fields.currency !== undefined) { sets.push('currency = ?'); values.push(fields.currency); }
    if (fields.expiresOn !== undefined) { sets.push('expires_on = ?'); values.push(fields.expiresOn); }
    if (fields.notes !== undefined) { sets.push('notes = ?'); values.push(fields.notes); }
    if (fields.excluded !== undefined) { sets.push('excluded = ?'); values.push(fields.excluded ? 1 : 0); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db
      .prepare(`UPDATE vouchers SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  deleteVoucher(id: string): void {
    this.db.prepare('DELETE FROM vouchers WHERE id = ?').run(id);
  }

  /**
   * Upserts a voucher scraped from a provider portal. Looks up by
   * (provider, externalId) so re-syncs update the same row even when no
   * Hon connection is involved (Shufersal Tav Hazahav today). Preserves
   * `excluded`, `notes`, and `name` when the user has overridden it — same
   * semantics as bank-loan upsert.
   */
  upsertScrapedVoucher(input: {
    name: string;
    provider: string;
    balance: number;
    currency: string;
    expiresOn?: string | null;
    externalId: string;
  }): Voucher {
    const existing = this.db
      .prepare(
        `SELECT id, name_overridden AS nameOverridden FROM vouchers
         WHERE provider = ? AND external_id = ?`,
      )
      .get(input.provider, input.externalId) as
      | { id: string; nameOverridden: number }
      | undefined;
    const now = new Date().toISOString();
    if (existing) {
      if (existing.nameOverridden) {
        // Keep the user-renamed `name`; everything else refreshes.
        this.db
          .prepare(
            `UPDATE vouchers SET
               balance = ?, currency = ?, expires_on = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.balance,
            input.currency,
            input.expiresOn ?? null,
            now,
            existing.id,
          );
      } else {
        this.db
          .prepare(
            `UPDATE vouchers SET
               name = ?, balance = ?, currency = ?, expires_on = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.name,
            input.balance,
            input.currency,
            input.expiresOn ?? null,
            now,
            existing.id,
          );
      }
      return this.getVoucher(existing.id)!;
    }
    return this.createVoucher({
      name: input.name,
      provider: input.provider,
      balance: input.balance,
      currency: input.currency,
      expiresOn: input.expiresOn ?? null,
      notes: null,
      excluded: false,
      externalId: input.externalId,
    });
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

  // --- Merchant splits ------------------------------------------------------
  // Bills the user shares with N other people: split_count is the divisor
  // (e.g. 3 = "I pay 1/3 of every charge"). Used by the Fixed bills view to
  // show the user's actual share alongside the full bill.

  listMerchantSplits(): { merchantKey: string; splitCount: number }[] {
    return this.db
      .prepare(
        'SELECT merchant_key AS merchantKey, split_count AS splitCount FROM merchant_splits',
      )
      .all() as { merchantKey: string; splitCount: number }[];
  }

  setMerchantSplit(merchantKey: string, splitCount: number): void {
    this.db
      .prepare(
        `INSERT INTO merchant_splits (merchant_key, split_count, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (merchant_key) DO UPDATE SET split_count = excluded.split_count`,
      )
      .run(merchantKey, splitCount, new Date().toISOString());
  }

  clearMerchantSplit(merchantKey: string): void {
    this.db
      .prepare('DELETE FROM merchant_splits WHERE merchant_key = ?')
      .run(merchantKey);
  }

  // --- Category splits ------------------------------------------------------
  // Per-category divisor (e.g. Utilities ÷ 3 when shared with roommates).
  // The Fixed-bills view multiplies every row in the category by 1/N and
  // adjusts section totals + the headline reservation accordingly.

  listCategorySplits(): { category: string; splitCount: number }[] {
    return this.db
      .prepare(
        'SELECT category, split_count AS splitCount FROM category_splits',
      )
      .all() as { category: string; splitCount: number }[];
  }

  setCategorySplit(category: string, splitCount: number): void {
    this.db
      .prepare(
        `INSERT INTO category_splits (category, split_count, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (category) DO UPDATE SET split_count = excluded.split_count`,
      )
      .run(category, splitCount, new Date().toISOString());
  }

  clearCategorySplit(category: string): void {
    this.db
      .prepare('DELETE FROM category_splits WHERE category = ?')
      .run(category);
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
  listMonthlySavings(): { month: string; amount: number; transferred: boolean }[] {
    const rows = this.db
      .prepare('SELECT month, amount, transferred FROM monthly_savings')
      .all() as { month: string; amount: number; transferred: number }[];
    return rows.map((r) => ({ ...r, transferred: r.transferred !== 0 }));
  }

  setMonthlySavings(month: string, amount: number, transferred: boolean): void {
    if (amount <= 0) {
      this.db.prepare('DELETE FROM monthly_savings WHERE month = ?').run(month);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO monthly_savings (month, amount, transferred) VALUES (?, ?, ?)
         ON CONFLICT (month) DO UPDATE SET
           amount = excluded.amount,
           transferred = excluded.transferred`,
      )
      .run(month, amount, transferred ? 1 : 0);
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
    'name_overridden AS nameOverridden, ' +
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

  /** Sets (or clears) the loan link on a single transaction. Validates
   *  that loanId, when provided, exists — callers can rely on the row
   *  being a valid foreign key without SQLite enforcing it. */
  setTransactionLoan(txnId: string, loanId: string | null): void {
    if (loanId !== null && !this.getLoan(loanId)) {
      throw new Error(`unknown loan id: ${loanId}`);
    }
    this.db
      .prepare('UPDATE transactions SET loan_id = ? WHERE id = ?')
      .run(loanId, txnId);
  }

  /** Every transaction linked to this loan, newest-first. */
  listLoanPayments(loanId: string): TxnRow[] {
    return this.db
      .prepare(
        `SELECT ${TXN_COLS}
         FROM transactions
         WHERE loan_id = ?
         ORDER BY date DESC, id DESC`,
      )
      .all(loanId) as TxnRow[];
  }

  createLoan(
    input: Omit<Loan, 'id' | 'createdAt' | 'updatedAt' | 'connectionId' | 'externalId' | 'nameOverridden'>
      & { connectionId?: string | null; externalId?: string | null; nameOverridden?: boolean },
  ): Loan {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO loans
           (id, name, principal, start_date, term_months, is_prime, is_cpi_linked,
            rate_value, cpi_start, currency, excluded, notes,
            connection_id, external_id, name_overridden, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.nameOverridden ? 1 : 0,
        now,
        now,
      );
    return this.getLoan(id)!;
  }

  /**
   * Upserts a loan scraped from a bank's loans page, keyed by the connection
   * + bank-side loan id. Re-syncs update the same row instead of inserting.
   * The `excluded`, `notes`, and (when `name_overridden=1`) `name` columns
   * are preserved across syncs so the user's edits are not clobbered by the
   * scraper. Every other field — principal, rate, term — is overwritten
   * because the bank is the source of truth for those.
   */
  upsertBankLoan(
    connectionId: string,
    input: Omit<Loan, 'id' | 'connectionId' | 'createdAt' | 'updatedAt' |
      'excluded' | 'notes' | 'cpiStart' | 'nameOverridden'> & { cpiStart?: number | null },
  ): Loan {
    const existing = this.db
      .prepare(
        `SELECT id, name_overridden AS nameOverridden FROM loans
         WHERE connection_id = ? AND external_id = ?`,
      )
      .get(connectionId, input.externalId) as
      | { id: string; nameOverridden: number }
      | undefined;
    const now = new Date().toISOString();
    if (existing) {
      // Renames the user made via the UI live in the same column the scraper
      // would otherwise overwrite. Skip the name set when the override flag
      // is on so a re-sync does not blow the rename away.
      if (existing.nameOverridden) {
        this.db
          .prepare(
            `UPDATE loans SET
               principal = ?, start_date = ?, term_months = ?,
               is_prime = ?, is_cpi_linked = ?, rate_value = ?,
               currency = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
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
      } else {
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
      }
      return this.getLoan(existing.id)!;
    }
    const loan = this.createLoan({
      ...input,
      connectionId,
      cpiStart: input.cpiStart ?? null,
      excluded: false,
      notes: null,
      nameOverridden: false,
    });

    // Backfill the 12-month window of this connection's transactions:
    // every negative-amount, loan_id=null row that matches the new loan
    // gets attached so the Loans card has history straight away instead
    // of waiting for the next month's payment to land.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const candidates = this.db
      .prepare(
        `SELECT t.id, t.description, t.amount
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.connection_id = ?
           AND t.loan_id IS NULL
           AND t.amount < 0
           AND t.date >= ?`,
      )
      .all(connectionId, cutoffIso) as
      { id: string; description: string; amount: number }[];
    const loansOnConn = this.listLoans().filter((l) => l.connectionId === connectionId);
    const update = this.db.prepare('UPDATE transactions SET loan_id = ? WHERE id = ?');
    for (const c of candidates) {
      const match = matchPaymentToLoan(c, loansOnConn);
      if (match) update.run(match, c.id);
    }

    return loan;
  }

  updateLoan(
    id: string,
    fields: Partial<Omit<Loan, 'id' | 'createdAt' | 'updatedAt'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      values.push(fields.name);
      // Any rename through this code path is a user-driven edit; flip the
      // override flag so the next bank-loan upsert leaves the new name alone.
      // Callers that need a non-overriding update (e.g. the scraper) go
      // through `upsertBankLoan`, not here.
      if (fields.nameOverridden === undefined) {
        sets.push('name_overridden = ?');
        values.push(1);
      }
    }
    if (fields.nameOverridden !== undefined) {
      sets.push('name_overridden = ?');
      values.push(fields.nameOverridden ? 1 : 0);
    }
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
   * Deletes a category. Reassigns every transaction, cache entry and merchant
   * rule tagged with it to 'Other' so nothing dangles. 'Other' itself is the
   * fallback target and cannot be removed — callers should guard. Built-ins
   * are deletable too (the user owns their category set); the deletion is a
   * regular drop without re-seeding.
   */
  deleteCategory(name: string): void {
    if (name === 'Other') return;
    const row = this.getCategory(name);
    if (!row) return;
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

  /** How many transactions currently carry this category. Used by the UI to
   *  show the impact of a delete before the user confirms. */
  countTransactionsInCategory(name: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE category = ?')
      .get(name) as { n: number };
    return row.n;
  }
}

export interface Category {
  name: string;
  emoji: string;
  /** Accent colour as a hex string, e.g. "#5CC773". */
  color: string;
  /** Spending umbrella the budget and group breakdowns use. `income` is the
   *  fourth bucket — categories in it represent inflows and are excluded
   *  from every spending sum. */
  catGroup: 'essential' | 'fixed' | 'variable' | 'income';
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
    row.catGroup === 'essential' || row.catGroup === 'fixed' || row.catGroup === 'income'
      ? row.catGroup : 'variable';
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
  nameOverridden: number;
  createdAt: string;
  updatedAt: string;
}

function toLoan(row: LoanRow): Loan {
  return {
    ...row,
    isPrime: row.isPrime !== 0,
    isCpiLinked: row.isCpiLinked !== 0,
    excluded: row.excluded !== 0,
    nameOverridden: row.nameOverridden !== 0,
  };
}
