import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { NormalizedAccount, NormalizedHolding } from './scrapers.js';

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

/** A savings goal — a thing the user is setting money aside for each month. */
export interface PiggyBank {
  id: string;
  name: string;
  emoji: string;
  targetAmount: number;
  monthlyAmount: number;
  currency: string;
  sortOrder: number;
  onHold: boolean;
  createdAt: string;
  updatedAt: string;
}

// SQLite has no boolean type, so `onHold` arrives as 0 | 1.
type PiggyBankRow = Omit<PiggyBank, 'onHold'> & { onHold: number };

function toPiggyBank(row: PiggyBankRow): PiggyBank {
  return { ...row, onHold: row.onHold !== 0 };
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
    'id, name, emoji, target_amount AS targetAmount, monthly_amount AS monthlyAmount, ' +
    'currency, sort_order AS sortOrder, on_hold AS onHold, ' +
    'created_at AS createdAt, updated_at AS updatedAt';

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
           (id, name, emoji, target_amount, monthly_amount, currency, sort_order,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.emoji,
        input.targetAmount,
        input.monthlyAmount,
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

  /** ILS expense totals per category within [start, end) — ISO date strings. */
  monthlySpending(start: string, end: string): { category: string; total: number }[] {
    return this.db
      .prepare(
        `SELECT category, SUM(-amount) AS total
         FROM txn_effective
         WHERE category IS NOT NULL AND amount < 0 AND currency = 'ILS'
           AND date >= @start AND date < @end
         GROUP BY category`,
      )
      .all({ start, end }) as { category: string; total: number }[];
  }

  /**
   * ILS money in for [start, end) — positive amounts categorised as Income or
   * Transfers only. Positive amounts in expense categories are partial refunds
   * offsetting a purchase, so they are deliberately left out.
   */
  monthlyInflow(start: string, end: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM txn_effective
         WHERE amount > 0 AND currency = 'ILS'
           AND category IN ('Income', 'Transfers')
           AND date >= @start AND date < @end`,
      )
      .get({ start, end }) as { total: number };
    return row.total;
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
}
