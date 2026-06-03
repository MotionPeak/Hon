import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type {
  BrokeragePerformanceData,
  NormalizedAccount,
  NormalizedHolding,
} from './scrapers.js';
import type { Loan } from './loans.js';
import { matchPaymentToLoan } from './loanMatcher.js';
import { makeDb, schema, type HonDb } from './db/client.js';
import { makeLog } from './log.js';

const repoLog = makeLog('repo');

// Typed table handles from the Drizzle schema. Aliased to short names so the
// query bodies below read close to SQL. The schema is the typed query layer
// over the database db.ts migrates — see src/db/schema.ts.
const {
  meta: metaT,
  connections: connectionsT,
  accounts: accountsT,
  transactions: transactionsT,
  scrapeRuns: scrapeRunsT,
  categoryCache: categoryCacheT,
  budgets: budgetsT,
  credentials: credentialsT,
  merchantRules: merchantRulesT,
  manualAssets: manualAssetsT,
  transactionLinks: transactionLinksT,
  merchantRecurrence: merchantRecurrenceT,
  splitwiseLinks: splitwiseLinksT,
  piggyBanks: piggyBanksT,
  piggyContributions: piggyContributionsT,
  holdings: holdingsT,
  accountValueSnapshots: accountValueSnapshotsT,
  brokeragePerformance: brokeragePerformanceT,
  cancelledSubscriptions: cancelledSubscriptionsT,
  holdingValueSnapshots: holdingValueSnapshotsT,
  loans: loansT,
  rateCache: rateCacheT,
  categories: categoriesT,
  monthlySavings: monthlySavingsT,
  merchantSplits: merchantSplitsT,
  categorySplits: categorySplitsT,
  vouchers: vouchersT,
  splitwiseRepayments: splitwiseRepaymentsT,
  txnEffective: txnEffectiveV,
} = schema;

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
  /**
   * Months of transaction history to fetch each sync. Default 12.
   * Range [1, 24] is enforced at the API + repo layer (see
   * server.ts PATCH /history-months and repo.setConnectionHistoryMonths);
   * no DB CHECK constraint.
   */
  historyMonths: number;
}

// (Connection rows now come back from Drizzle; `hasCredentials` is coerced from
// the computed-column 0/1 inline in connectionSelect's callers.)

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

// (Account rows now come back from Drizzle with `excluded` as a real boolean.)

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
  /** Manual "exclude from cycle" override. Tri-state: true forces excluded,
   *  false forces included, null defers to the card-bill rule. Stored as an
   *  INTEGER (1/0/null); coerced to boolean on read (see `coerceTxnRow`). */
  excludedManual?: boolean | null;
  /** "Savings" mark — money moved to savings; out of spend, tallied as saved.
   *  Mutually exclusive with excludedManual. Stored as INTEGER (1/0/null);
   *  coerced to boolean on read. */
  savings?: boolean | null;
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

// (Vouchers now come back from Drizzle; `excluded`/`nameOverridden` are
// boolean-mode columns so no 0/1 coercion is needed.)

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

// SQLite stores `details` as JSON text; `excluded` is a boolean-mode column so
// Drizzle reads it back as a real boolean (no 0/1 coercion needed).
type ManualAssetRow = Omit<ManualAsset, 'details'> & {
  details: string | null;
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
  return { ...row, details };
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

// (Piggy banks now come back from Drizzle; `onHold` is boolean-mode and `kind`
// is narrowed to the PiggyKind union by Repo.narrowPiggy.)

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
  /** Amount of `owed` covered by linked repayments (set by recomputePaidStates). */
  paid?: number;
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

/** An incoming transaction the user marked as a friend repaying them. */
export interface SplitwiseRepayment {
  transactionId: string;
  counterpartyId: number;
  counterpartyName: string;
  currency: string;
  amount: number;
  createdAt: string;
}

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
  'c.last_status AS lastStatus, c.history_months AS historyMonths, ' +
  '(cr.connection_id IS NOT NULL) AS hasCredentials';

const CONNECTION_FROM =
  'FROM connections c LEFT JOIN credentials cr ON cr.connection_id = c.id';

const RUN_COLS =
  'id, connection_id AS connectionId, started_at AS startedAt, finished_at AS finishedAt, ' +
  'status, message, accounts_count AS accountsCount, transactions_count AS transactionsCount';

const TXN_COLS =
  'id, account_id AS accountId, external_id AS externalId, date, ' +
  'processed_date AS processedDate, amount, currency, description, memo, ' +
  'kind, status, category, created_at AS createdAt, loan_id AS loanId, ' +
  'excluded_manual AS excludedManual, savings';

/** Normalises a tri-state flag to `boolean | null` at the read boundary.
 *  `excludedManual` / `savings` are tri-state in `TxnRow` (and the React
 *  client). Drizzle boolean-mode reads already return real booleans, so this is
 *  a no-op for them; it still maps raw better-sqlite3 0/1 integers (the few
 *  reads left on `this.db`) so callers always see booleans, never 0/1. Without
 *  it the client's `excludedManual === true` checks never match. */
function coerceTxnFlag(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  return v === 1;
}
function coerceTxnRow(r: TxnRow): TxnRow {
  return {
    ...r,
    excludedManual: coerceTxnFlag(r.excludedManual),
    savings: coerceTxnFlag(r.savings),
  };
}

/** All database reads/writes go through this typed repository.
 *
 *  Queries are written with Drizzle ORM (`this.orm`, the typed query layer over
 *  the schema in src/db/schema.ts). The raw better-sqlite3 handle (`this.db`)
 *  is retained for the few genuinely set-based statements where hand-tuned SQL
 *  is clearer than the builder — the analytics CTEs over `txn_effective` and
 *  the hot `saveScrapeResult` upsert loop. Both views address the SAME single
 *  connection; Drizzle is constructed over it, never a second handle. */
export class Repo {
  private readonly orm: HonDb;

  constructor(private readonly db: Database.Database) {
    this.orm = makeDb(db);
  }

  /** `SELECT COUNT(*)` over a whole table — a small helper so the summary
   *  counts read cleanly. `SQLiteTable` is the common supertype of every table
   *  handle in the schema. */
  private countRows(table: SQLiteTable): number {
    return this.orm.select({ n: sql<number>`COUNT(*)` }).from(table).get()?.n ?? 0;
  }

  // --- Connections ----------------------------------------------------------

  /** SELECT ... plus the computed `hasCredentials` (does the vault hold creds
   *  for this connection?) via a LEFT JOIN existence check, mirroring the old
   *  CONNECTION_COLS/CONNECTION_FROM. Drizzle maps snake_case → camelCase from
   *  the schema, and `historyMonths` is a real number. The existence check
   *  comes back as SQLite 0/1, so it is coerced to a real boolean (what the old
   *  `toConnection` did). */
  private connectionSelect() {
    return this.orm
      .select({
        id: connectionsT.id,
        companyId: connectionsT.companyId,
        displayName: connectionsT.displayName,
        createdAt: connectionsT.createdAt,
        lastScrapeAt: connectionsT.lastScrapeAt,
        lastStatus: connectionsT.lastStatus,
        historyMonths: connectionsT.historyMonths,
        hasCredentials: sql<number>`(${credentialsT.connectionId} IS NOT NULL)`,
      })
      .from(connectionsT)
      .leftJoin(credentialsT, eq(credentialsT.connectionId, connectionsT.id));
  }

  listConnections(): Connection[] {
    return this.connectionSelect()
      .orderBy(connectionsT.displayName)
      .all()
      .map((r) => ({ ...r, hasCredentials: r.hasCredentials !== 0 }));
  }

  getConnection(id: string): Connection | undefined {
    const row = this.connectionSelect().where(eq(connectionsT.id, id)).get();
    return row ? { ...row, hasCredentials: row.hasCredentials !== 0 } : undefined;
  }

  createConnection(companyId: string, displayName: string): Connection {
    const id = randomUUID();
    this.orm
      .insert(connectionsT)
      .values({ id, companyId, displayName, createdAt: new Date().toISOString() })
      .run();
    return this.getConnection(id)!;
  }

  deleteConnection(id: string): void {
    this.orm.delete(connectionsT).where(eq(connectionsT.id, id)).run();
  }

  setConnectionStatus(id: string, status: string, scrapeAt?: string): void {
    this.orm
      .update(connectionsT)
      .set(scrapeAt ? { lastStatus: status, lastScrapeAt: scrapeAt } : { lastStatus: status })
      .where(eq(connectionsT.id, id))
      .run();
  }

  /**
   * Updates the per-connection history window used by sync.
   *
   * Validates [1, 24] (matches the API-layer clamp). Throws on out-of-range
   * or non-integer input, and on unknown connection id, so the server
   * route can rely on the throw to translate into a 4xx.
   */
  setConnectionHistoryMonths(id: string, months: number): Connection {
    if (!Number.isInteger(months)) {
      throw new Error(`historyMonths must be an integer, got ${months}`);
    }
    if (months < 1 || months > 24) {
      throw new Error(`historyMonths out of range [1, 24]: ${months}`);
    }
    const result = this.orm
      .update(connectionsT)
      .set({ historyMonths: months })
      .where(eq(connectionsT.id, id))
      .run();
    if (result.changes === 0) {
      throw new Error(`connection not found: ${id}`);
    }
    return this.getConnection(id)!;
  }

  /** The scrape watermark — the earliest date a successful sync has already
   *  fetched from for this connection — or undefined when never recorded. */
  getScrapeFetchedSince(connectionId: string): string | undefined {
    return this.orm
      .select({ fetchedSince: connectionsT.fetchedSince })
      .from(connectionsT)
      .where(eq(connectionsT.id, connectionId))
      .get()?.fetchedSince ?? undefined;
  }

  /** Extends the scrape watermark to the EARLIER of its current value and
   *  `startDate` (YYYY-MM-DD); a later start from an incremental run never
   *  shrinks recorded coverage. Called after every successful scrape. */
  extendScrapeFetchedSince(connectionId: string, startDate: string): void {
    const current = this.getScrapeFetchedSince(connectionId);
    if (current != null && current <= startDate) return;
    this.orm
      .update(connectionsT)
      .set({ fetchedSince: startDate })
      .where(eq(connectionsT.id, connectionId))
      .run();
  }

  // --- Accounts & transactions ---------------------------------------------

  /** Drizzle column map mirroring the legacy `TXN_COLS` bare-SELECT, including
   *  `loanId` (read by the UI even though it is not on `TxnRow`). Boolean-mode
   *  columns (`excludedManual`, `savings`) read back as real booleans, so the
   *  `coerceTxnRow` callers wrap with is effectively a no-op now — kept so the
   *  read boundary stays explicit. */
  private txnColumns() {
    return {
      id: transactionsT.id,
      accountId: transactionsT.accountId,
      externalId: transactionsT.externalId,
      date: transactionsT.date,
      processedDate: transactionsT.processedDate,
      amount: transactionsT.amount,
      currency: transactionsT.currency,
      description: transactionsT.description,
      memo: transactionsT.memo,
      kind: transactionsT.kind,
      status: transactionsT.status,
      category: transactionsT.category,
      createdAt: transactionsT.createdAt,
      loanId: transactionsT.loanId,
      excludedManual: transactionsT.excludedManual,
      savings: transactionsT.savings,
    };
  }

  listAccounts(): AccountRow[] {
    // JOIN onto the connection for company id + display name. `excluded` is a
    // boolean-mode column so Drizzle reads it back as a real boolean — the old
    // `r.excluded !== 0` coercion is gone.
    return this.orm
      .select({
        id: accountsT.id,
        connectionId: accountsT.connectionId,
        companyId: connectionsT.companyId,
        connectionName: connectionsT.displayName,
        accountNumber: accountsT.accountNumber,
        label: accountsT.label,
        balance: accountsT.balance,
        currency: accountsT.currency,
        updatedAt: accountsT.updatedAt,
        excluded: accountsT.excluded,
        inceptionDate: accountsT.inceptionDate,
      })
      .from(accountsT)
      .innerJoin(connectionsT, eq(connectionsT.id, accountsT.connectionId))
      .orderBy(connectionsT.displayName, accountsT.accountNumber)
      .all();
  }

  /** Sets (or clears, when null) the user-defined inception date for an
   *  account — the "when I actually started investing here" boundary used by
   *  the brokerage chart to clip synthetic Yahoo/Maya pre-link history. */
  setAccountInceptionDate(id: string, inceptionDate: string | null): void {
    this.orm
      .update(accountsT)
      .set({ inceptionDate, updatedAt: new Date().toISOString() })
      .where(eq(accountsT.id, id))
      .run();
  }

  /** Every brokerage position across all accounts. */
  listHoldings(): HoldingRow[] {
    return this.orm
      .select({
        accountId: holdingsT.accountId,
        symbol: holdingsT.symbol,
        description: holdingsT.description,
        units: holdingsT.units,
        price: holdingsT.price,
        currency: holdingsT.currency,
        costBasis: holdingsT.costBasis,
        openPnl: holdingsT.openPnl,
        value: holdingsT.value,
        updatedAt: holdingsT.updatedAt,
      })
      .from(holdingsT)
      .orderBy(holdingsT.symbol)
      .all();
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
    const row = this.orm
      .select({
        count: sql<number>`COUNT(*)`,
        firstDate: sql<string | null>`MIN(${holdingValueSnapshotsT.date})`,
        lastDate: sql<string | null>`MAX(${holdingValueSnapshotsT.date})`,
      })
      .from(holdingValueSnapshotsT)
      .where(
        and(
          eq(holdingValueSnapshotsT.accountId, accountId),
          eq(holdingValueSnapshotsT.symbol, symbol),
        ),
      )
      .get()!;
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
    let inserted = 0;
    this.orm.transaction((tx) => {
      for (const point of history) {
        // INSERT OR IGNORE: existing (account, symbol, date) rows are left
        // alone — Hon's own daily syncs are the source of truth.
        const r = tx
          .insert(holdingValueSnapshotsT)
          .values({
            accountId,
            symbol,
            date: point.date,
            units,
            price: point.price,
            value: units * point.price,
            currency: point.currency,
          })
          .onConflictDoNothing()
          .run();
        if (r.changes) inserted += 1;
      }
    });
    return inserted;
  }

  /** Cached SnapTrade performance reports, keyed by connection id. */
  listBrokeragePerformance(): { connectionId: string; data: BrokeragePerformanceData; fetchedAt: string }[] {
    const rows = this.orm
      .select({
        connectionId: brokeragePerformanceT.connectionId,
        dataJson: brokeragePerformanceT.dataJson,
        fetchedAt: brokeragePerformanceT.fetchedAt,
      })
      .from(brokeragePerformanceT)
      .all();
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
    const fetchedAt = new Date().toISOString();
    this.orm
      .insert(brokeragePerformanceT)
      .values({ connectionId, dataJson: JSON.stringify(data), fetchedAt })
      .onConflictDoUpdate({
        target: brokeragePerformanceT.connectionId,
        set: { dataJson: JSON.stringify(data), fetchedAt },
      })
      .run();
  }

  /** Every per-holding price/value snapshot, oldest first. */
  listHoldingSnapshots(): HoldingSnapshotRow[] {
    return this.orm
      .select({
        accountId: holdingValueSnapshotsT.accountId,
        symbol: holdingValueSnapshotsT.symbol,
        date: holdingValueSnapshotsT.date,
        units: holdingValueSnapshotsT.units,
        price: holdingValueSnapshotsT.price,
        value: holdingValueSnapshotsT.value,
        currency: holdingValueSnapshotsT.currency,
      })
      .from(holdingValueSnapshotsT)
      .orderBy(holdingValueSnapshotsT.date)
      .all();
  }

  /** Every recorded brokerage value snapshot, oldest first. */
  listValueSnapshots(): ValueSnapshotRow[] {
    return this.orm
      .select({
        accountId: accountValueSnapshotsT.accountId,
        date: accountValueSnapshotsT.date,
        value: accountValueSnapshotsT.value,
        currency: accountValueSnapshotsT.currency,
      })
      .from(accountValueSnapshotsT)
      .orderBy(accountValueSnapshotsT.date)
      .all();
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
      // SQLite treats a negative LIMIT as unbounded. The month-by-month UIs
      // (Activity/Insights/Recurring/Subscriptions) need every cycle, so an
      // omitted limit returns the full history rather than a recent page.
      .all({ accountId: opts.accountId ?? null, limit: opts.limit ?? -1 })
      .map((r) => coerceTxnRow(r as TxnRow));
  }

  /** Sets one account's balance by hand (scrapers do not report card balances). */
  setAccountBalance(id: string, balance: number): void {
    this.orm
      .update(accountsT)
      .set({ balance, updatedAt: new Date().toISOString() })
      .where(eq(accountsT.id, id))
      .run();
  }

  /** Includes or excludes one account from the net-worth total. */
  setAccountExcluded(id: string, excluded: boolean): void {
    // `excluded` is a boolean-mode column — pass the real boolean.
    this.orm.update(accountsT).set({ excluded }).where(eq(accountsT.id, id)).run();
  }

  // --- Refund / reimbursement links ----------------------------------------

  listTransactionLinks(): { expenseId: string; refundId: string; amount: number }[] {
    return this.orm
      .select({
        expenseId: transactionLinksT.expenseId,
        refundId: transactionLinksT.refundId,
        amount: transactionLinksT.amount,
      })
      .from(transactionLinksT)
      .all();
  }

  /** The allocated amount for one (expense, refund) link, or undefined if the
   *  pair isn't linked. Targeted lookup so callers don't materialize the whole
   *  transaction_links table just to read one row's amount. */
  getTransactionLink(expenseId: string, refundId: string): number | undefined {
    return this.orm
      .select({ amount: transactionLinksT.amount })
      .from(transactionLinksT)
      .where(and(
        eq(transactionLinksT.expenseId, expenseId),
        eq(transactionLinksT.refundId, refundId),
      ))
      .get()?.amount;
  }

  /**
   * Adds (or updates) one allocation: links `amount` of a refund/inflow
   * transaction to an expense. Multiple expenses can share one refund — the
   * sum of allocations is capped at the refund's magnitude by validation in
   * the API layer; this method is unchecked and idempotent on (expense,
   * refund), updating the amount when called again.
   */
  setTransactionLink(expenseId: string, refundId: string, amount: number): void {
    this.orm
      .insert(transactionLinksT)
      .values({ id: randomUUID(), expenseId, refundId, amount, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: [transactionLinksT.expenseId, transactionLinksT.refundId],
        set: { amount },
      })
      .run();
  }

  /** Removes one specific (expense, refund) allocation. */
  deleteTransactionLink(expenseId: string, refundId?: string): void {
    if (refundId) {
      this.orm
        .delete(transactionLinksT)
        .where(
          and(
            eq(transactionLinksT.expenseId, expenseId),
            eq(transactionLinksT.refundId, refundId),
          ),
        )
        .run();
    } else {
      this.orm.delete(transactionLinksT).where(eq(transactionLinksT.expenseId, expenseId)).run();
    }
  }

  /** Returns the unallocated portion of a refund — `ABS(amount) − Σ allocations`. */
  refundRemaining(refundId: string): number {
    const refund = this.orm
      .select({ amount: transactionsT.amount })
      .from(transactionsT)
      .where(eq(transactionsT.id, refundId))
      .get();
    if (!refund) return 0;
    const used = this.orm
      .select({ used: sql<number>`COALESCE(SUM(${transactionLinksT.amount}), 0)` })
      .from(transactionLinksT)
      .where(eq(transactionLinksT.refundId, refundId))
      .get()!.used;
    return Math.max(0, Math.abs(refund.amount) - used);
  }

  getTransaction(id: string): TxnRow | undefined {
    // Mirror listTransactions: include the scalar refundId/refundForId refund-
    // link hints so a single-transaction read has the same shape as the list
    // (the Drizzle txnColumns() variant dropped these, diverging silently).
    const row = this.db
      .prepare(
        `SELECT ${TXN_COLS},
                (SELECT refund_id FROM transaction_links
                   WHERE expense_id = transactions.id
                   ORDER BY amount DESC LIMIT 1) AS refundId,
                (SELECT expense_id FROM transaction_links
                   WHERE refund_id = transactions.id
                   ORDER BY amount DESC LIMIT 1) AS refundForId
         FROM transactions WHERE id = @id`,
      )
      .get({ id });
    return row ? coerceTxnRow(row as TxnRow) : undefined;
  }

  /** Sets one transaction's category (used when the user moves it by hand). */
  updateTransactionCategory(id: string, category: string): void {
    this.orm.update(transactionsT).set({ category }).where(eq(transactionsT.id, id)).run();
  }

  // --- Splitwise links ------------------------------------------------------
  // Maps a Hon transaction to the Splitwise expense created from it. The paid
  // state is recomputed on each Splitwise refresh, not stored by the client.

  /** Drizzle column map for splitwise_links; `counterparties` arrives as the raw
   *  JSON string that `toSplitwiseLink` parses. */
  private swColumns() {
    return {
      transactionId: splitwiseLinksT.transactionId,
      expenseId: splitwiseLinksT.expenseId,
      groupId: splitwiseLinksT.groupId,
      currency: splitwiseLinksT.currency,
      owedToMe: splitwiseLinksT.owedToMe,
      counterparties: splitwiseLinksT.counterparties,
      paidAmount: splitwiseLinksT.paidAmount,
      paidState: splitwiseLinksT.paidState,
      createdAt: splitwiseLinksT.createdAt,
      syncedAt: splitwiseLinksT.syncedAt,
    };
  }

  listSplitwiseLinks(): SplitwiseLink[] {
    const rows = this.orm
      .select(this.swColumns())
      .from(splitwiseLinksT)
      .orderBy(splitwiseLinksT.createdAt)
      .all();
    return rows.map(toSplitwiseLink);
  }

  getSplitwiseLink(transactionId: string): SplitwiseLink | undefined {
    const row = this.orm
      .select(this.swColumns())
      .from(splitwiseLinksT)
      .where(eq(splitwiseLinksT.transactionId, transactionId))
      .get();
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
    const counterparties = JSON.stringify(link.counterparties);
    this.orm
      .insert(splitwiseLinksT)
      .values({
        transactionId: link.transactionId,
        expenseId: link.expenseId,
        groupId: link.groupId,
        currency: link.currency,
        owedToMe: link.owedToMe,
        counterparties,
        paidAmount: 0,
        paidState: 'open',
        createdAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: splitwiseLinksT.transactionId,
        set: {
          expenseId: link.expenseId,
          groupId: link.groupId,
          currency: link.currency,
          owedToMe: link.owedToMe,
          counterparties,
          paidAmount: 0,
          paidState: 'open',
          syncedAt: null,
        },
      })
      .run();
    return this.getSplitwiseLink(link.transactionId)!;
  }

  /** Updates a link's paid figures + per-counterparty paid after a recompute. */
  updateSplitwiseLinkPaid(
    transactionId: string,
    paidAmount: number,
    paidState: string,
    counterparties: SplitwiseCounterparty[],
  ): void {
    this.orm
      .update(splitwiseLinksT)
      .set({
        paidAmount,
        paidState,
        counterparties: JSON.stringify(counterparties),
        syncedAt: new Date().toISOString(),
      })
      .where(eq(splitwiseLinksT.transactionId, transactionId))
      .run();
  }

  deleteSplitwiseLink(transactionId: string): void {
    this.orm.delete(splitwiseLinksT).where(eq(splitwiseLinksT.transactionId, transactionId)).run();
  }

  // --- Splitwise repayments -------------------------------------------------
  // Incoming transactions the user marked as a friend paying them back. These
  // drive paid-state (via recomputePaidStates), replacing Splitwise's settle-up
  // flag. `amount` is captured at mark time from the incoming txn.

  private static toRepayment(row: {
    transactionId: string; counterpartyId: string; counterpartyName: string;
    currency: string; amount: number; createdAt: string;
  }): SplitwiseRepayment {
    return { ...row, counterpartyId: Number(row.counterpartyId) };
  }

  /** Drizzle column map for splitwise_repayments. `counterpartyId` is stored as
   *  TEXT and narrowed to a number by `toRepayment`. */
  private swrColumns() {
    return {
      transactionId: splitwiseRepaymentsT.transactionId,
      counterpartyId: splitwiseRepaymentsT.counterpartyId,
      counterpartyName: splitwiseRepaymentsT.counterpartyName,
      currency: splitwiseRepaymentsT.currency,
      amount: splitwiseRepaymentsT.amount,
      createdAt: splitwiseRepaymentsT.createdAt,
    };
  }

  /** Returns all repayment records ordered by creation time. */
  listRepayments(): SplitwiseRepayment[] {
    const rows = this.orm
      .select(this.swrColumns())
      .from(splitwiseRepaymentsT)
      .orderBy(splitwiseRepaymentsT.createdAt)
      .all();
    return rows.map(Repo.toRepayment);
  }

  /** Returns the repayment linked to the given transaction, or undefined. */
  getRepayment(transactionId: string): SplitwiseRepayment | undefined {
    const row = this.orm
      .select(this.swrColumns())
      .from(splitwiseRepaymentsT)
      .where(eq(splitwiseRepaymentsT.transactionId, transactionId))
      .get();
    return row ? Repo.toRepayment(row) : undefined;
  }

  /** Inserts (or replaces on conflict) a repayment record. */
  createRepayment(r: {
    transactionId: string;
    counterpartyId: number;
    counterpartyName: string;
    currency: string;
    amount: number;
  }): SplitwiseRepayment {
    const counterpartyId = String(r.counterpartyId);
    this.orm
      .insert(splitwiseRepaymentsT)
      .values({
        transactionId: r.transactionId,
        counterpartyId,
        counterpartyName: r.counterpartyName,
        currency: r.currency,
        amount: r.amount,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: splitwiseRepaymentsT.transactionId,
        set: {
          counterpartyId,
          counterpartyName: r.counterpartyName,
          currency: r.currency,
          amount: r.amount,
        },
      })
      .run();
    return this.getRepayment(r.transactionId)!;
  }

  /** Removes the repayment record for the given transaction. */
  deleteRepayment(transactionId: string): void {
    this.orm
      .delete(splitwiseRepaymentsT)
      .where(eq(splitwiseRepaymentsT.transactionId, transactionId))
      .run();
  }

  /** Pool of money each person has repaid, keyed `counterpartyId|currency`. */
  getRepaymentPool(): Map<string, number> {
    const rows = this.orm
      .select({
        counterpartyId: splitwiseRepaymentsT.counterpartyId,
        currency: splitwiseRepaymentsT.currency,
        amount: sql<number>`SUM(${splitwiseRepaymentsT.amount})`,
      })
      .from(splitwiseRepaymentsT)
      .groupBy(splitwiseRepaymentsT.counterpartyId, splitwiseRepaymentsT.currency)
      .all();
    const pool = new Map<string, number>();
    for (const row of rows) pool.set(`${row.counterpartyId}|${row.currency}`, row.amount);
    return pool;
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

    const connectionCount = this.countRows(connectionsT);
    const accountCount = this.countRows(accountsT);
    const manualAssetCount = this.countRows(manualAssetsT);
    const voucherCount = this.countRows(vouchersT);
    return { connectionCount, accountCount, manualAssetCount, voucherCount, byCurrency };
  }

  /** Upserts every account + transaction from a scrape, in one transaction. */
  saveScrapeResult(
    connectionId: string,
    accounts: NormalizedAccount[],
    opts?: { reconcileBalances?: boolean },
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
    // Upsert (not plain INSERT) on (account_id, symbol): a scrape can return two
    // lots of the same symbol, or a broker can list a symbol twice — a plain
    // INSERT would hit the UNIQUE(account_id, symbol) constraint and, inside the
    // batch transaction below, roll back the entire scrape. The conflict target
    // mirrors the snapshot upserts right below; last write wins.
    const insertHolding = this.db.prepare(
      `INSERT INTO holdings
         (id, account_id, symbol, description, units, price, currency,
          cost_basis, open_pnl, value, updated_at)
       VALUES
         (@id, @accountId, @symbol, @description, @units, @price, @currency,
          @costBasis, @openPnl, @value, @updatedAt)
       ON CONFLICT (account_id, symbol) DO UPDATE SET
         description = excluded.description, units = excluded.units,
         price = excluded.price, currency = excluded.currency,
         cost_basis = excluded.cost_basis, open_pnl = excluded.open_pnl,
         value = excluded.value, updated_at = excluded.updated_at`,
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
    // Snapshot date keys must be the Israel calendar day (transactions are
    // stored in Israel time too) — a UTC slice files a late-evening Israeli
    // sync under the wrong day and collides/overwrites the prior snapshot.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

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
            // Per-row guard: a single malformed holding (e.g. a non-finite
            // units/price binding the column rejects) must not roll back the
            // whole scrape. Skip + log the bad row and keep the rest. The
            // statement-level failure leaves the surrounding transaction valid.
            try {
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
            } catch (err) {
              repoLog.warn('saveScrapeResult.holding.skipped', {
                account: account.accountNumber,
                symbol: h.symbol,
                message: (err as Error).message,
              });
            }
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
          // Per-row guard: a single malformed transaction (the classic case is
          // a non-finite `amount` the `amount REAL NOT NULL` column rejects at
          // bind time) must not abort the whole scrape. Skip + log it and carry
          // on. A statement that throws here leaves the enclosing transaction
          // valid, so every well-formed row still commits.
          try {
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
          } catch (err) {
            repoLog.warn('saveScrapeResult.transaction.skipped', {
              account: account.accountNumber,
              externalId: txn.externalId,
              message: (err as Error).message,
            });
            continue;
          }
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

      // Stale-account reconciliation (pension only — opts.reconcileBalances).
      // Pension portals key an account on its rendered display label; when that
      // text changes between syncs the account upserts under a NEW
      // account_number, orphaning the old row — which keeps its last balance and
      // DOUBLE-COUNTS in net worth (audit M6). This method only runs on a
      // successful scrape, so when the scrape returned at least one account we
      // null the balance of any of this connection's accounts that weren't in it.
      // Null, not delete: ON DELETE CASCADE would drop the account's snapshot
      // history, and a partial-but-successful scrape would lose a real account —
      // a nulled balance falls out of totals (summary SUMs balance, NULL-safe)
      // while the row + history survive and the account self-heals (balance
      // restored by the COALESCE upsert) the next time the provider reports it.
      // Scoped to pension; banks/cards are excluded (a card's incremental window
      // legitimately omits accounts, and bank closures are rare + user-visible).
      if (opts?.reconcileBalances && accounts.length > 0) {
        const scraped = new Set(accounts.map((a) => a.accountNumber));
        const existing = this.db
          .prepare('SELECT account_number FROM accounts WHERE connection_id = ? AND balance IS NOT NULL')
          .all(connectionId) as { account_number: string }[];
        const retire = this.db.prepare(
          'UPDATE accounts SET balance = NULL, updated_at = ? WHERE connection_id = ? AND account_number = ?',
        );
        let retired = 0;
        for (const e of existing) {
          if (!scraped.has(e.account_number)) {
            retire.run(now, connectionId, e.account_number);
            retired += 1;
          }
        }
        if (retired > 0) {
          repoLog.info('saveScrapeResult.reconciled', { connectionId, retired });
        }
      }
    })();

    return { accounts: accounts.length, transactions: txnCount };
  }

  // --- Manual assets --------------------------------------------------------
  // Cars, property, cash and the like — things the user owns that have no
  // institution to scrape. They count toward net worth via summary().

  listManualAssets(): ManualAsset[] {
    const rows = this.orm
      .select()
      .from(manualAssetsT)
      .orderBy(manualAssetsT.createdAt)
      .all();
    return rows.map(toManualAsset);
  }

  getManualAsset(id: string): ManualAsset | undefined {
    const row = this.orm.select().from(manualAssetsT).where(eq(manualAssetsT.id, id)).get();
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
    this.orm
      .insert(manualAssetsT)
      .values({
        id,
        kind: input.kind,
        name: input.name,
        value: input.value,
        currency: input.currency,
        details: input.details ? JSON.stringify(input.details) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
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
    const set: Partial<typeof manualAssetsT.$inferInsert> = {};
    if (fields.name !== undefined) set.name = fields.name;
    if (fields.value !== undefined) set.value = fields.value;
    if (fields.details !== undefined) {
      set.details = fields.details ? JSON.stringify(fields.details) : null;
    }
    if (fields.excluded !== undefined) set.excluded = fields.excluded;
    if (Object.keys(set).length === 0) return;
    set.updatedAt = new Date().toISOString();
    this.orm.update(manualAssetsT).set(set).where(eq(manualAssetsT.id, id)).run();
  }

  deleteManualAsset(id: string): void {
    this.orm.delete(manualAssetsT).where(eq(manualAssetsT.id, id)).run();
  }

  // --- Vouchers -------------------------------------------------------------
  // Gift cards and prepaid vouchers — Shufersal Tav Hazahav, Pluxee/Sodexo,
  // Cibus, employer gift sums. Each row holds a current balance that the
  // user maintains; when a provider scraper lands the row carries a
  // connection_id + external_id and updates upsert-in-place.

  // `excluded` / `nameOverridden` are boolean-mode columns in the schema, so a
  // plain `.select()` returns real booleans — vouchers carry no JSON column, so
  // the old `toVoucher` coercion is no longer needed on reads.

  listVouchers(): Voucher[] {
    return this.orm.select().from(vouchersT).orderBy(vouchersT.createdAt).all();
  }

  getVoucher(id: string): Voucher | undefined {
    return this.orm.select().from(vouchersT).where(eq(vouchersT.id, id)).get();
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
    this.orm
      .insert(vouchersT)
      .values({
        id,
        name: input.name,
        provider: input.provider,
        balance: input.balance,
        currency: input.currency,
        expiresOn: input.expiresOn ?? null,
        notes: input.notes ?? null,
        excluded: input.excluded ?? false,
        connectionId: input.connectionId ?? null,
        externalId: input.externalId ?? null,
        nameOverridden: input.nameOverridden ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
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
    const set: Partial<typeof vouchersT.$inferInsert> = {};
    if (fields.name !== undefined) {
      set.name = fields.name;
      // A rename via this code path is a user edit; flip the override flag
      // so a future provider sync leaves the new name alone. (Matches the
      // loans semantics.)
      if (fields.nameOverridden === undefined) set.nameOverridden = true;
    }
    if (fields.nameOverridden !== undefined) set.nameOverridden = fields.nameOverridden;
    if (fields.provider !== undefined) set.provider = fields.provider;
    if (fields.balance !== undefined) set.balance = fields.balance;
    if (fields.currency !== undefined) set.currency = fields.currency;
    if (fields.expiresOn !== undefined) set.expiresOn = fields.expiresOn;
    if (fields.notes !== undefined) set.notes = fields.notes;
    if (fields.excluded !== undefined) set.excluded = fields.excluded;
    if (Object.keys(set).length === 0) return;
    set.updatedAt = new Date().toISOString();
    this.orm.update(vouchersT).set(set).where(eq(vouchersT.id, id)).run();
  }

  deleteVoucher(id: string): void {
    this.orm.delete(vouchersT).where(eq(vouchersT.id, id)).run();
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
    const existing = this.orm
      .select({ id: vouchersT.id, nameOverridden: vouchersT.nameOverridden })
      .from(vouchersT)
      .where(and(eq(vouchersT.provider, input.provider), eq(vouchersT.externalId, input.externalId)))
      .get();
    const now = new Date().toISOString();
    if (existing) {
      // Keep the user-renamed `name` when overridden; everything else refreshes.
      const set = existing.nameOverridden
        ? { balance: input.balance, currency: input.currency, expiresOn: input.expiresOn ?? null, updatedAt: now }
        : { name: input.name, balance: input.balance, currency: input.currency, expiresOn: input.expiresOn ?? null, updatedAt: now };
      this.orm.update(vouchersT).set(set).where(eq(vouchersT.id, existing.id)).run();
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

  /** `onHold` is boolean-mode (real boolean from Drizzle); `kind` is free-text
   *  TEXT narrowed to the PiggyKind union at the read boundary. Replaces the old
   *  `toPiggyBank` 0/1 coercion. */
  private static narrowPiggy(row: typeof piggyBanksT.$inferSelect): PiggyBank {
    return { ...row, kind: row.kind === 'lump' ? 'lump' : 'monthly' };
  }

  listPiggyBanks(): PiggyBank[] {
    return this.orm
      .select()
      .from(piggyBanksT)
      .orderBy(piggyBanksT.sortOrder, piggyBanksT.createdAt)
      .all()
      .map(Repo.narrowPiggy);
  }

  getPiggyBank(id: string): PiggyBank | undefined {
    const row = this.orm.select().from(piggyBanksT).where(eq(piggyBanksT.id, id)).get();
    return row ? Repo.narrowPiggy(row) : undefined;
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
      (this.orm
        .select({ n: sql<number>`COALESCE(MAX(${piggyBanksT.sortOrder}), 0)` })
        .from(piggyBanksT)
        .get()?.n ?? 0) + 1;
    this.orm
      .insert(piggyBanksT)
      .values({
        id,
        name: input.name,
        emoji: input.emoji,
        kind: input.kind === 'lump' ? 'lump' : 'monthly',
        targetAmount: input.targetAmount,
        // Lump-sum piggies don't recur, so the column gets the full target
        // — handy if anything ever reads monthlyAmount expecting "what this
        // piggy charges in a fund-able month".
        monthlyAmount: input.kind === 'lump' ? input.targetAmount : input.monthlyAmount,
        currency: input.currency,
        sortOrder: nextOrder,
        createdAt: now,
        updatedAt: now,
      })
      .run();
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
    const set: Partial<typeof piggyBanksT.$inferInsert> = {};
    if (fields.name !== undefined) set.name = fields.name;
    if (fields.emoji !== undefined) set.emoji = fields.emoji;
    if (fields.kind !== undefined) set.kind = fields.kind === 'lump' ? 'lump' : 'monthly';
    if (fields.targetAmount !== undefined) set.targetAmount = fields.targetAmount;
    if (fields.monthlyAmount !== undefined) set.monthlyAmount = fields.monthlyAmount;
    if (fields.onHold !== undefined) set.onHold = fields.onHold;
    if (Object.keys(set).length === 0) return;
    set.updatedAt = new Date().toISOString();
    this.orm.update(piggyBanksT).set(set).where(eq(piggyBanksT.id, id)).run();
  }

  deletePiggyBank(id: string): void {
    this.orm.delete(piggyBanksT).where(eq(piggyBanksT.id, id)).run();
  }

  /** Every recorded set-aside, across all piggy banks and months. */
  listPiggyContributions(): PiggyContribution[] {
    return this.orm
      .select({
        piggyId: piggyContributionsT.piggyId,
        month: piggyContributionsT.month,
        amount: piggyContributionsT.amount,
        status: piggyContributionsT.status,
      })
      .from(piggyContributionsT)
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
    this.orm
      .insert(piggyContributionsT)
      .values({ piggyId, month, amount, status, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: [piggyContributionsT.piggyId, piggyContributionsT.month],
        set: { amount, status },
      })
      .run();
  }

  // --- Categorization -------------------------------------------------------

  /** Distinct transaction descriptions that have no category yet. */
  uncategorizedDescriptions(): string[] {
    return this.orm
      .selectDistinct({ description: transactionsT.description })
      .from(transactionsT)
      .where(isNull(transactionsT.category))
      .all()
      .map((row) => row.description);
  }

  getCachedCategory(key: string): { category: string; source: string } | undefined {
    return this.orm
      .select({ category: categoryCacheT.category, source: categoryCacheT.source })
      .from(categoryCacheT)
      .where(eq(categoryCacheT.descriptionKey, key))
      .get();
  }

  cacheCategory(key: string, category: string, source: string): void {
    const updatedAt = new Date().toISOString();
    this.orm
      .insert(categoryCacheT)
      .values({ descriptionKey: key, category, source, updatedAt })
      .onConflictDoUpdate({
        target: categoryCacheT.descriptionKey,
        set: { category, source, updatedAt },
      })
      .run();
  }

  /** Applies a category to every still-uncategorized transaction with this description. */
  applyCategory(description: string, category: string): number {
    return this.orm
      .update(transactionsT)
      .set({ category })
      .where(and(eq(transactionsT.description, description), isNull(transactionsT.category)))
      .run().changes;
  }

  /**
   * Applies the built-in substring rules (the `category_rules` table) to every
   * still-uncategorized transaction in ONE set-based SQL pass — the database
   * equivalent of the retired `categorizeByRule` JS loop. Raw SQL is the
   * documented escape hatch for set work the ORM can't express (a correlated
   * subquery over an INSTR substring match).
   *
   * `INSTR(LOWER(description), pattern) > 0` is exactly
   * `description.toLowerCase().includes(pattern)`: SQLite's LOWER folds ASCII
   * only, which is what we want here — the needles are lowercase Latin and
   * Hebrew has no case. `ORDER BY priority LIMIT 1` is first-match-wins
   * (specific brands before broad words, e.g. "amazon prime" before "amazon").
   * The `category IS NULL` guard preserves manual overrides / merchant-rule /
   * cache results (same guard as applyCategory); `category IN (SELECT name FROM
   * categories)` skips a rule whose target category the user has since deleted.
   *
   * Returns the number of DISTINCT descriptions newly categorized — the figure
   * the categorizer reports as "N by rules".
   */
  applyBuiltinRules(): number {
    const matchable = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT t.description
           FROM transactions t
           WHERE t.category IS NULL
             AND EXISTS (
               SELECT 1 FROM category_rules r
               WHERE INSTR(LOWER(t.description), r.pattern) > 0
                 AND r.category IN (SELECT name FROM categories)
             )
           GROUP BY t.description
         )`,
      )
      .get() as { n: number };
    this.db
      .prepare(
        `UPDATE transactions
            SET category = (
              SELECT r.category FROM category_rules r
              WHERE INSTR(LOWER(transactions.description), r.pattern) > 0
                AND r.category IN (SELECT name FROM categories)
              ORDER BY r.priority
              LIMIT 1
            )
          WHERE category IS NULL
            AND EXISTS (
              SELECT 1 FROM category_rules r
              WHERE INSTR(LOWER(transactions.description), r.pattern) > 0
                AND r.category IN (SELECT name FROM categories)
            )`,
      )
      .run();
    return matchable.n;
  }

  // --- Merchant rules -------------------------------------------------------
  // A user-set rule mapping an exact transaction description to a category, so
  // future transactions from that business categorize the same way.

  listMerchantRules(): { description: string; category: string }[] {
    return this.orm
      .select({ description: merchantRulesT.description, category: merchantRulesT.category })
      .from(merchantRulesT)
      .all();
  }

  setMerchantRule(description: string, category: string): void {
    this.orm
      .insert(merchantRulesT)
      .values({ description, category, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: merchantRulesT.description, set: { category } })
      .run();
  }

  /**
   * Applies a merchant rule's category to every still-uncategorized
   * transaction with this exact description. Mirrors applyCategory: the
   * `AND category IS NULL` guard stops a new/edited rule from clobbering
   * categories the user set by hand (H-4).
   */
  applyMerchantRule(description: string, category: string): number {
    // Same behaviour as applyCategory — delegate so the `category IS NULL`
    // guard lives in one place and the two can't drift.
    return this.applyCategory(description, category);
  }

  // --- Merchant recurrence --------------------------------------------------
  // How often a recurring charge bills, keyed by a cleaned merchant name.

  listMerchantFrequencies(): { merchantKey: string; frequency: string }[] {
    return this.orm
      .select({
        merchantKey: merchantRecurrenceT.merchantKey,
        frequency: merchantRecurrenceT.frequency,
      })
      .from(merchantRecurrenceT)
      .all();
  }

  setMerchantFrequency(merchantKey: string, frequency: string): void {
    this.orm
      .insert(merchantRecurrenceT)
      .values({ merchantKey, frequency, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: merchantRecurrenceT.merchantKey, set: { frequency } })
      .run();
  }

  clearMerchantFrequency(merchantKey: string): void {
    this.orm
      .delete(merchantRecurrenceT)
      .where(eq(merchantRecurrenceT.merchantKey, merchantKey))
      .run();
  }

  // --- Merchant splits ------------------------------------------------------
  // Bills the user shares with N other people: split_count is the divisor
  // (e.g. 3 = "I pay 1/3 of every charge"). Used by the Fixed bills view to
  // show the user's actual share alongside the full bill.

  listMerchantSplits(): { merchantKey: string; splitCount: number }[] {
    return this.orm
      .select({
        merchantKey: merchantSplitsT.merchantKey,
        splitCount: merchantSplitsT.splitCount,
      })
      .from(merchantSplitsT)
      .all();
  }

  setMerchantSplit(merchantKey: string, splitCount: number): void {
    this.orm
      .insert(merchantSplitsT)
      .values({ merchantKey, splitCount, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: merchantSplitsT.merchantKey, set: { splitCount } })
      .run();
  }

  clearMerchantSplit(merchantKey: string): void {
    this.orm.delete(merchantSplitsT).where(eq(merchantSplitsT.merchantKey, merchantKey)).run();
  }

  // --- Category splits ------------------------------------------------------
  // Per-category divisor (e.g. Utilities ÷ 3 when shared with roommates).
  // The Fixed-bills view multiplies every row in the category by 1/N and
  // adjusts section totals + the headline reservation accordingly.

  listCategorySplits(): { category: string; splitCount: number }[] {
    return this.orm
      .select({ category: categorySplitsT.category, splitCount: categorySplitsT.splitCount })
      .from(categorySplitsT)
      .all();
  }

  setCategorySplit(category: string, splitCount: number): void {
    this.orm
      .insert(categorySplitsT)
      .values({ category, splitCount, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: categorySplitsT.category, set: { splitCount } })
      .run();
  }

  clearCategorySplit(category: string): void {
    this.orm.delete(categorySplitsT).where(eq(categorySplitsT.category, category)).run();
  }

  // --- Cancelled subscriptions ----------------------------------------------
  // Subscriptions the user has explicitly marked cancelled. `cancelled_at` is
  // the moment the mark was set — the UI flags any charge after that as a
  // possible "the cancellation didn't take" recurrence.

  listCancelledSubs(): { merchantKey: string; cancelledAt: string }[] {
    return this.orm
      .select({
        merchantKey: cancelledSubscriptionsT.merchantKey,
        cancelledAt: cancelledSubscriptionsT.cancelledAt,
      })
      .from(cancelledSubscriptionsT)
      .all();
  }

  markSubCancelled(merchantKey: string): void {
    const cancelledAt = new Date().toISOString();
    this.orm
      .insert(cancelledSubscriptionsT)
      .values({ merchantKey, cancelledAt })
      .onConflictDoUpdate({ target: cancelledSubscriptionsT.merchantKey, set: { cancelledAt } })
      .run();
  }

  unmarkSubCancelled(merchantKey: string): void {
    this.orm
      .delete(cancelledSubscriptionsT)
      .where(eq(cancelledSubscriptionsT.merchantKey, merchantKey))
      .run();
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

  /** Every per-month savings entry — small dict, returned in full to the UI.
   *  `transferred` is a boolean-mode column, so Drizzle returns a real boolean. */
  listMonthlySavings(): { month: string; amount: number; transferred: boolean }[] {
    return this.orm
      .select({
        month: monthlySavingsT.month,
        amount: monthlySavingsT.amount,
        transferred: monthlySavingsT.transferred,
      })
      .from(monthlySavingsT)
      .all();
  }

  setMonthlySavings(month: string, amount: number, transferred: boolean): void {
    if (amount <= 0) {
      this.orm.delete(monthlySavingsT).where(eq(monthlySavingsT.month, month)).run();
      return;
    }
    this.orm
      .insert(monthlySavingsT)
      .values({ month, amount, transferred })
      .onConflictDoUpdate({
        target: monthlySavingsT.month,
        set: { amount, transferred },
      })
      .run();
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
           AND id NOT IN (SELECT id FROM transactions WHERE savings = 1)
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
      // Escape LIKE metacharacters (% _ and the escape char itself) so a
      // provider name containing them matches literally, not as a wildcard.
      const escaped = p.replace(/[\\%_]/g, (c) => `\\${c}`);
      params[key] = `%${escaped}%`;
      parts.push(`LOWER(description) LIKE @${key} ESCAPE '\\'`);
    });
    return `AND NOT (${parts.join(' OR ')})`;
  }

  listBudgets(): { category: string; monthlyAmount: number }[] {
    return this.orm
      .select({ category: budgetsT.category, monthlyAmount: budgetsT.monthlyAmount })
      .from(budgetsT)
      .all();
  }

  setBudget(category: string, monthlyAmount: number): void {
    const updatedAt = new Date().toISOString();
    this.orm
      .insert(budgetsT)
      .values({ category, monthlyAmount, updatedAt })
      .onConflictDoUpdate({ target: budgetsT.category, set: { monthlyAmount, updatedAt } })
      .run();
  }

  deleteBudget(category: string): void {
    this.orm.delete(budgetsT).where(eq(budgetsT.category, category)).run();
  }

  categorizationCounts(): { categorized: number; total: number } {
    const total =
      this.orm.select({ n: sql<number>`COUNT(*)` }).from(transactionsT).get()?.n ?? 0;
    const categorized =
      this.orm
        .select({ n: sql<number>`COUNT(*)` })
        .from(transactionsT)
        .where(sql`${transactionsT.category} IS NOT NULL`)
        .get()?.n ?? 0;
    return { categorized, total };
  }

  // --- Analytics ------------------------------------------------------------

  /** Total ILS spending & income per calendar month, from @start onward. */
  monthlyTotals(
    start: string,
    excludeDescPatterns: string[] = [],
  ): { month: string; spending: number; income: number }[] {
    const params: Record<string, unknown> = { start };
    const exclude = this.buildExcludeClause(excludeDescPatterns, params);
    return this.db
      .prepare(
        `SELECT substr(date, 1, 7) AS month,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spending,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income
         FROM txn_effective
         WHERE currency = 'ILS' AND date >= @start ${exclude}
           AND id NOT IN (SELECT id FROM transactions WHERE savings = 1)
         GROUP BY substr(date, 1, 7)
         ORDER BY month`,
      )
      .all(params) as { month: string; spending: number; income: number }[];
  }

  /** ILS expense totals per category in [start, end); uncategorized included. */
  categorySpending(
    start: string,
    end: string,
    excludeDescPatterns: string[] = [],
  ): { category: string; total: number }[] {
    const params: Record<string, unknown> = { start, end };
    const exclude = this.buildExcludeClause(excludeDescPatterns, params);
    return this.db
      .prepare(
        `SELECT COALESCE(category, 'Uncategorized') AS category, SUM(-amount) AS total
         FROM txn_effective
         WHERE amount < 0 AND currency = 'ILS' AND date >= @start AND date < @end ${exclude}
           AND id NOT IN (SELECT id FROM transactions WHERE savings = 1)
         GROUP BY COALESCE(category, 'Uncategorized')`,
      )
      .all(params) as { category: string; total: number }[];
  }

  /** Count and mean of ILS expense transactions in [start, end). */
  expenseStats(
    start: string,
    end: string,
    excludeDescPatterns: string[] = [],
  ): { count: number; avg: number } {
    const params: Record<string, unknown> = { start, end };
    const exclude = this.buildExcludeClause(excludeDescPatterns, params);
    return this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(AVG(-amount), 0) AS avg
         FROM txn_effective
         WHERE amount < 0 AND currency = 'ILS' AND date >= @start AND date < @end ${exclude}
           AND id NOT IN (SELECT id FROM transactions WHERE savings = 1)`,
      )
      .get(params) as { count: number; avg: number };
  }

  // --- Meta & credential vault ---------------------------------------------

  getMeta(key: string): string | undefined {
    return this.orm
      .select({ value: metaT.value })
      .from(metaT)
      .where(eq(metaT.key, key))
      .get()?.value;
  }

  setMeta(key: string, value: string): void {
    this.orm
      .insert(metaT)
      .values({ key, value })
      .onConflictDoUpdate({ target: metaT.key, set: { value } })
      .run();
  }

  deleteMeta(key: string): void {
    this.orm.delete(metaT).where(eq(metaT.key, key)).run();
  }

  private perfDisabledKey(connectionId: string): string {
    return `snaptrade:perf-disabled:${connectionId}`;
  }

  /** ISO timestamp of when SnapTrade performance was last seen disabled for
   *  this connection, or null if currently considered available. */
  getPerformanceDisabledAt(connectionId: string): string | null {
    return this.getMeta(this.perfDisabledKey(connectionId)) ?? null;
  }

  /** Records (ISO string) or clears (null) the performance-disabled marker. */
  setPerformanceDisabled(connectionId: string, when: string | null): void {
    if (when === null) this.deleteMeta(this.perfDisabledKey(connectionId));
    else this.setMeta(this.perfDisabledKey(connectionId), when);
  }

  getCredentialBlob(connectionId: string): string | undefined {
    return this.orm
      .select({ blob: credentialsT.blob })
      .from(credentialsT)
      .where(eq(credentialsT.connectionId, connectionId))
      .get()?.blob;
  }

  saveCredentialBlob(connectionId: string, blob: string): void {
    const updatedAt = new Date().toISOString();
    this.orm
      .insert(credentialsT)
      .values({ connectionId, blob, updatedAt })
      .onConflictDoUpdate({ target: credentialsT.connectionId, set: { blob, updatedAt } })
      .run();
  }

  // --- Scrape runs ----------------------------------------------------------

  createRun(connectionId: string): ScrapeRunRow {
    const id = randomUUID();
    this.orm
      .insert(scrapeRunsT)
      .values({ id, connectionId, startedAt: new Date().toISOString(), status: 'running' })
      .run();
    return this.getRun(id)!;
  }

  getRun(id: string): ScrapeRunRow | undefined {
    return this.orm.select().from(scrapeRunsT).where(eq(scrapeRunsT.id, id)).get();
  }

  /**
   * `finished_at` of the most recent successful scrape for a connection, used
   * to compute an incremental start date for the next sync. Returns undefined
   * when the connection has no successful scrape yet (first-ever sync).
   */
  lastSuccessfulScrapeAt(connectionId: string): string | undefined {
    return this.orm
      .select({ finishedAt: scrapeRunsT.finishedAt })
      .from(scrapeRunsT)
      .where(
        and(
          eq(scrapeRunsT.connectionId, connectionId),
          eq(scrapeRunsT.status, 'success'),
          sql`${scrapeRunsT.finishedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(scrapeRunsT.finishedAt))
      .limit(1)
      .get()?.finishedAt ?? undefined;
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
    // `key in fields` (not `!== undefined`) so an explicit null still writes —
    // e.g. updateRun(id, { message: null }) clears the message column.
    const set: Partial<typeof scrapeRunsT.$inferInsert> = {};
    if ('status' in fields) set.status = fields.status;
    if ('message' in fields) set.message = fields.message;
    if ('finishedAt' in fields) set.finishedAt = fields.finishedAt;
    if ('accountsCount' in fields) set.accountsCount = fields.accountsCount;
    if ('transactionsCount' in fields) set.transactionsCount = fields.transactionsCount;
    if (Object.keys(set).length === 0) return;
    this.orm.update(scrapeRunsT).set(set).where(eq(scrapeRunsT.id, id)).run();
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
    const changed = this.orm
      .update(scrapeRunsT)
      .set({
        status: 'error',
        finishedAt: now,
        message: 'Sync was interrupted before it finished.',
      })
      .where(eq(scrapeRunsT.status, 'running'))
      .run().changes;
    this.orm
      .update(connectionsT)
      .set({ lastStatus: 'error' })
      .where(eq(connectionsT.lastStatus, 'running'))
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

  // Loan boolean columns (isPrime/isCpiLinked/excluded/nameOverridden) are all
  // boolean-mode in the schema and the row carries no JSON, so a plain
  // `.select()` returns the `Loan` shape directly — the old `toLoan` 0/1
  // coercion is no longer needed.

  listLoans(): Loan[] {
    return this.orm.select().from(loansT).orderBy(loansT.createdAt).all();
  }

  getLoan(id: string): Loan | undefined {
    return this.orm.select().from(loansT).where(eq(loansT.id, id)).get();
  }

  /** Sets (or clears) the loan link on a single transaction. Validates
   *  that loanId, when provided, exists — callers can rely on the row
   *  being a valid foreign key without SQLite enforcing it. */
  setTransactionLoan(txnId: string, loanId: string | null): void {
    if (loanId !== null && !this.getLoan(loanId)) {
      throw new Error(`unknown loan id: ${loanId}`);
    }
    this.orm.update(transactionsT).set({ loanId }).where(eq(transactionsT.id, txnId)).run();
  }

  /** Sets (or clears) the per-transaction "exclude from cycle" override.
   *  `true` forces the row out of monthly totals; `false` forces it in
   *  even when the client's card-bill rule would have matched; `null`
   *  clears the override and lets the rule decide. */
  setTransactionExcluded(txnId: string, excluded: boolean | null): void {
    if (excluded === true) {
      // Excluding manually and the Savings mark are mutually exclusive.
      this.orm
        .update(transactionsT)
        .set({ excludedManual: true, savings: false })
        .where(eq(transactionsT.id, txnId))
        .run();
      return;
    }
    // null clears the override (rule decides); false forces the row included.
    const value = excluded === null ? null : false;
    this.orm
      .update(transactionsT)
      .set({ excludedManual: value })
      .where(eq(transactionsT.id, txnId))
      .run();
  }

  /** Mark/unmark a transaction as a savings transfer. A savings row is pulled
   *  out of spend (like an excluded row) AND tallied as "saved this cycle".
   *  Marking savings clears any manual exclude — the two are mutually
   *  exclusive. */
  setTransactionSavings(txnId: string, savings: boolean): void {
    this.orm
      .update(transactionsT)
      .set(savings ? { savings: true, excludedManual: null } : { savings: false })
      .where(eq(transactionsT.id, txnId))
      .run();
  }

  /** Every transaction linked to this loan, newest-first. */
  listLoanPayments(loanId: string): TxnRow[] {
    return this.orm
      .select()
      .from(transactionsT)
      .where(eq(transactionsT.loanId, loanId))
      .orderBy(desc(transactionsT.date), desc(transactionsT.id))
      .all()
      .map((r) => coerceTxnRow(r as TxnRow));
  }

  createLoan(
    input: Omit<Loan, 'id' | 'createdAt' | 'updatedAt' | 'connectionId' | 'externalId' | 'nameOverridden'>
      & { connectionId?: string | null; externalId?: string | null; nameOverridden?: boolean },
  ): Loan {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.orm
      .insert(loansT)
      .values({
        id,
        name: input.name,
        principal: input.principal,
        startDate: input.startDate,
        termMonths: input.termMonths,
        isPrime: input.isPrime,
        isCpiLinked: input.isCpiLinked,
        rateValue: input.rateValue,
        cpiStart: input.cpiStart,
        currency: input.currency,
        excluded: input.excluded,
        notes: input.notes,
        connectionId: input.connectionId ?? null,
        externalId: input.externalId ?? null,
        nameOverridden: input.nameOverridden ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
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
               cpi_start = CASE WHEN ? = 1 AND cpi_start IS NULL THEN ? ELSE cpi_start END,
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
            // Backfill the CPI snapshot only when the loan is index-linked and
            // no value was ever captured (older rows scraped before the runner
            // computed it). A non-null stored cpi_start — a manual edit or an
            // earlier snapshot — is preserved so linkage stays pinned to start.
            input.isCpiLinked ? 1 : 0,
            input.cpiStart ?? null,
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
               cpi_start = CASE WHEN ? = 1 AND cpi_start IS NULL THEN ? ELSE cpi_start END,
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
            // Same CPI backfill as the name-overridden branch above: fill the
            // snapshot only when index-linked and never captured; never clobber
            // an existing value.
            input.isCpiLinked ? 1 : 0,
            input.cpiStart ?? null,
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
    // every negative-amount, loan_id=null row that matches ANY of the
    // connection's loans (including the one just created) gets attached.
    // This is deliberately wider than "the new loan only" — pre-existing
    // loans that the matcher couldn't disambiguate before (e.g. multi-
    // loan ties that broke once the new loan added an externalId hit)
    // get a second chance here. Net effect: the Loans card has history
    // straight away instead of waiting for the next month's payment.
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
    const set: Partial<typeof loansT.$inferInsert> = {};
    if (fields.name !== undefined) {
      set.name = fields.name;
      // Any rename through this code path is a user-driven edit; flip the
      // override flag so the next bank-loan upsert leaves the new name alone.
      // Callers that need a non-overriding update (e.g. the scraper) go
      // through `upsertBankLoan`, not here.
      if (fields.nameOverridden === undefined) set.nameOverridden = true;
    }
    if (fields.nameOverridden !== undefined) set.nameOverridden = fields.nameOverridden;
    if (fields.principal !== undefined) set.principal = fields.principal;
    if (fields.startDate !== undefined) set.startDate = fields.startDate;
    if (fields.termMonths !== undefined) set.termMonths = fields.termMonths;
    if (fields.isPrime !== undefined) set.isPrime = fields.isPrime;
    if (fields.isCpiLinked !== undefined) set.isCpiLinked = fields.isCpiLinked;
    if (fields.rateValue !== undefined) set.rateValue = fields.rateValue;
    if (fields.cpiStart !== undefined) set.cpiStart = fields.cpiStart;
    if (fields.currency !== undefined) set.currency = fields.currency;
    if (fields.excluded !== undefined) set.excluded = fields.excluded;
    if (fields.notes !== undefined) set.notes = fields.notes;
    if (Object.keys(set).length === 0) return;
    set.updatedAt = new Date().toISOString();
    this.orm.update(loansT).set(set).where(eq(loansT.id, id)).run();
  }

  deleteLoan(id: string): void {
    this.orm.transaction((tx) => {
      // Null out the FK-less loan_id on this loan's transactions BEFORE deleting
      // the loan row. transactions.loan_id is plain TEXT with no cascade
      // (migration v33 documents this delete-time null-out), so without this the
      // payments keep a dangling id and the matcher/backfill (which only touch
      // rows where loan_id IS NULL) can never re-link them to a future loan.
      tx.update(transactionsT).set({ loanId: null }).where(eq(transactionsT.loanId, id)).run();
      tx.delete(loansT).where(eq(loansT.id, id)).run();
    });
  }

  setLoanExcluded(id: string, excluded: boolean): void {
    this.orm.update(loansT).set({ excluded }).where(eq(loansT.id, id)).run();
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
    return this.orm
      .select({ value: rateCacheT.value, fetchedAt: rateCacheT.fetchedAt })
      .from(rateCacheT)
      .where(and(eq(rateCacheT.series, series), eq(rateCacheT.period, period)))
      .get();
  }

  cacheRate(series: string, period: string, value: number): void {
    const fetchedAt = new Date().toISOString();
    this.orm
      .insert(rateCacheT)
      .values({ series, period, value, fetchedAt })
      .onConflictDoUpdate({
        target: [rateCacheT.series, rateCacheT.period],
        set: { value, fetchedAt },
      })
      .run();
  }

  // --- Categories ----------------------------------------------------------
  // Replaces what used to be a static list in categorize.ts. The categorizer
  // (LLM + rules), the budget engine and the frontend all read this table so
  // a user-added category is first-class everywhere.

  /** `isBuiltin` is a boolean-mode column in the schema, so Drizzle reads it
   *  back as a real boolean and the old `toCategory` coercion is gone. The
   *  declared `catGroup` union is preserved by a narrowing cast at the read
   *  boundary (the column is free-text TEXT in SQLite). */
  private static narrowCategory(row: {
    name: string; emoji: string; color: string; catGroup: string;
    sortOrder: number; isBuiltin: boolean; createdAt: string;
  }): Category {
    const group: Category['catGroup'] =
      row.catGroup === 'essential' || row.catGroup === 'fixed' || row.catGroup === 'income'
        ? row.catGroup : 'variable';
    return { ...row, catGroup: group };
  }

  listCategories(): Category[] {
    return this.orm
      .select()
      .from(categoriesT)
      .orderBy(categoriesT.sortOrder, categoriesT.name)
      .all()
      .map(Repo.narrowCategory);
  }

  getCategory(name: string): Category | undefined {
    const row = this.orm.select().from(categoriesT).where(eq(categoriesT.name, name)).get();
    return row ? Repo.narrowCategory(row) : undefined;
  }

  createCategory(input: Omit<Category, 'isBuiltin' | 'createdAt'>): Category {
    this.orm
      .insert(categoriesT)
      .values({
        name: input.name,
        emoji: input.emoji,
        color: input.color,
        catGroup: input.catGroup,
        sortOrder: input.sortOrder,
        isBuiltin: false,
        createdAt: new Date().toISOString(),
      })
      .run();
    return this.getCategory(input.name)!;
  }

  updateCategory(
    name: string,
    fields: Partial<Omit<Category, 'name' | 'isBuiltin' | 'createdAt'>>,
  ): void {
    // Build a partial update from only the provided fields — column names come
    // from the schema, so there is no hand-mapping of camelCase → snake_case.
    const set: Partial<typeof categoriesT.$inferInsert> = {};
    if (fields.emoji !== undefined) set.emoji = fields.emoji;
    if (fields.color !== undefined) set.color = fields.color;
    if (fields.catGroup !== undefined) set.catGroup = fields.catGroup;
    if (fields.sortOrder !== undefined) set.sortOrder = fields.sortOrder;
    if (Object.keys(set).length === 0) return;
    this.orm.update(categoriesT).set(set).where(eq(categoriesT.name, name)).run();
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
    this.orm.transaction((tx) => {
      tx.update(transactionsT).set({ category: 'Other' }).where(eq(transactionsT.category, name)).run();
      tx.update(categoryCacheT).set({ category: 'Other' }).where(eq(categoryCacheT.category, name)).run();
      tx.update(merchantRulesT).set({ category: 'Other' }).where(eq(merchantRulesT.category, name)).run();
      tx.delete(budgetsT).where(eq(budgetsT.category, name)).run();
      // category_splits is keyed by category name with no FK — without this the
      // split row survives and a later category created with the same name
      // silently inherits the old roommate divisor.
      tx.delete(categorySplitsT).where(eq(categorySplitsT.category, name)).run();
      tx.delete(categoriesT).where(eq(categoriesT.name, name)).run();
    });
  }

  /** How many transactions currently carry this category. Used by the UI to
   *  show the impact of a delete before the user confirms. */
  countTransactionsInCategory(name: string): number {
    const row = this.orm
      .select({ n: sql<number>`COUNT(*)` })
      .from(transactionsT)
      .where(eq(transactionsT.category, name))
      .get();
    return row?.n ?? 0;
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

// (Category rows now come from Drizzle; `isBuiltin` is boolean-mode and the
// `catGroup` union is narrowed by Repo.narrowCategory. Loan rows likewise come
// back fully typed — all four loan booleans are boolean-mode columns — so the
// former CategoryRow/LoanRow shapes and their to* coercers are no longer
// needed.)
