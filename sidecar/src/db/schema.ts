// Drizzle ORM schema — a TYPED QUERY LAYER over the database that db.ts's
// migrations build. It deliberately does NOT own DDL: tables/indexes/the
// txn_effective view are created by ./migrations.ts (the single source of
// truth). Drizzle here gives the Repo type-safe queries instead of hand-written
// SQL strings.
//
// Keep this in lockstep with ./migrations.ts. tests/schema.parity.test.ts
// asserts every table + column here matches the live schema, so drift fails CI.
//
// SQLite has no boolean type: 0/1 columns are modelled with
// `integer(..., { mode: 'boolean' })` so reads come back as real booleans and
// the old hand coercion (toConnection/toCategory/coerceTxnRow…) is no longer
// needed. Tri-state flags (excluded_manual, savings) stay nullable, so they
// read back as `boolean | null`.

import { sql } from 'drizzle-orm';
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
  text,
} from 'drizzle-orm/sqlite-core';

/** 0/1 NOT NULL flag with a default. */
const boolFlag = (col: string, def = false) =>
  integer(col, { mode: 'boolean' }).notNull().default(def);

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull(),
  lastScrapeAt: text('last_scrape_at'),
  lastStatus: text('last_status'),
  historyMonths: integer('history_months').notNull().default(12),
  // Watermark: earliest date a successful sync has already fetched from. Drives
  // the runner's incremental-vs-backfill choice (see scrapeWindow.ts).
  fetchedSince: text('fetched_since'),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull(),
  accountNumber: text('account_number').notNull(),
  label: text('label'),
  balance: real('balance'),
  currency: text('currency').notNull().default('ILS'),
  updatedAt: text('updated_at').notNull(),
  excluded: boolFlag('excluded'),
  inceptionDate: text('inception_date'),
});

export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  externalId: text('external_id').notNull(),
  date: text('date').notNull(),
  processedDate: text('processed_date'),
  amount: real('amount').notNull(),
  currency: text('currency').notNull().default('ILS'),
  description: text('description').notNull(),
  memo: text('memo'),
  kind: text('kind'),
  status: text('status'),
  category: text('category'),
  rawJson: text('raw_json'),
  createdAt: text('created_at').notNull(),
  loanId: text('loan_id'),
  // Tri-state: null = follow the live rule, true/false = explicit override.
  excludedManual: integer('excluded_manual', { mode: 'boolean' }),
  savings: integer('savings', { mode: 'boolean' }),
  // User-set display title (shows in place of `description`, which stays the
  // grouping/categorization key) and free-form notes. Both nullable.
  customTitle: text('custom_title'),
  notes: text('notes'),
});

export const scrapeRuns = sqliteTable('scrape_runs', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  status: text('status').notNull(),
  message: text('message'),
  accountsCount: integer('accounts_count').notNull().default(0),
  transactionsCount: integer('transactions_count').notNull().default(0),
});

export const categoryCache = sqliteTable('category_cache', {
  descriptionKey: text('description_key').primaryKey(),
  category: text('category').notNull(),
  source: text('source').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const budgets = sqliteTable('budgets', {
  category: text('category').primaryKey(),
  monthlyAmount: real('monthly_amount').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const credentials = sqliteTable('credentials', {
  connectionId: text('connection_id').primaryKey(),
  blob: text('blob').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const merchantRules = sqliteTable('merchant_rules', {
  description: text('description').primaryKey(),
  category: text('category').notNull(),
  createdAt: text('created_at').notNull(),
});

// Built-in substring categorization rules (migration v41). `pattern` is a
// lowercase needle matched via INSTR(LOWER(description), pattern); `priority`
// ascending is first-match-wins; `source` distinguishes 'builtin' from a
// future user-added 'user'. Created + seeded by migrations.ts — this is the
// typed query layer over it.
export const categoryRules = sqliteTable('category_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pattern: text('pattern').notNull(),
  category: text('category').notNull(),
  priority: integer('priority').notNull(),
  source: text('source').notNull().default('builtin'),
  createdAt: text('created_at').notNull(),
});

export const manualAssets = sqliteTable('manual_assets', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  value: real('value').notNull(),
  currency: text('currency').notNull().default('ILS'),
  details: text('details'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  excluded: boolFlag('excluded'),
});

// Post-v24 shape: N:M expense↔refund links with a per-row allocated amount.
export const transactionLinks = sqliteTable('transaction_links', {
  id: text('id').primaryKey(),
  expenseId: text('expense_id').notNull(),
  refundId: text('refund_id').notNull(),
  amount: real('amount').notNull(),
  createdAt: text('created_at').notNull(),
});

export const merchantRecurrence = sqliteTable('merchant_recurrence', {
  merchantKey: text('merchant_key').primaryKey(),
  frequency: text('frequency').notNull(),
  createdAt: text('created_at').notNull(),
});

export const splitwiseLinks = sqliteTable('splitwise_links', {
  transactionId: text('transaction_id').primaryKey(),
  expenseId: text('expense_id').notNull(),
  groupId: text('group_id'),
  currency: text('currency').notNull(),
  owedToMe: real('owed_to_me').notNull(),
  counterparties: text('counterparties').notNull(),
  paidAmount: real('paid_amount').notNull().default(0),
  paidState: text('paid_state').notNull().default('open'),
  createdAt: text('created_at').notNull(),
  syncedAt: text('synced_at'),
});

export const piggyBanks = sqliteTable('piggy_banks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  emoji: text('emoji').notNull().default('🐷'),
  targetAmount: real('target_amount').notNull(),
  monthlyAmount: real('monthly_amount').notNull(),
  currency: text('currency').notNull().default('ILS'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  onHold: boolFlag('on_hold'),
  kind: text('kind').notNull().default('monthly'),
});

export const piggyContributions = sqliteTable(
  'piggy_contributions',
  {
    piggyId: text('piggy_id').notNull(),
    month: text('month').notNull(),
    amount: real('amount').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.piggyId, t.month] })],
);

export const holdings = sqliteTable('holdings', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  symbol: text('symbol').notNull(),
  description: text('description'),
  units: real('units').notNull(),
  price: real('price'),
  currency: text('currency').notNull().default('USD'),
  costBasis: real('cost_basis'),
  openPnl: real('open_pnl'),
  updatedAt: text('updated_at').notNull(),
  value: real('value'),
});

export const accountValueSnapshots = sqliteTable(
  'account_value_snapshots',
  {
    accountId: text('account_id').notNull(),
    date: text('date').notNull(),
    value: real('value').notNull(),
    currency: text('currency').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.date] })],
);

export const brokeragePerformance = sqliteTable('brokerage_performance', {
  connectionId: text('connection_id').primaryKey(),
  dataJson: text('data_json').notNull(),
  fetchedAt: text('fetched_at').notNull(),
});

export const cancelledSubscriptions = sqliteTable('cancelled_subscriptions', {
  merchantKey: text('merchant_key').primaryKey(),
  cancelledAt: text('cancelled_at').notNull(),
});

export const holdingValueSnapshots = sqliteTable(
  'holding_value_snapshots',
  {
    accountId: text('account_id').notNull(),
    symbol: text('symbol').notNull(),
    date: text('date').notNull(),
    units: real('units').notNull(),
    price: real('price'),
    value: real('value').notNull(),
    currency: text('currency').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.symbol, t.date] })],
);

export const loans = sqliteTable('loans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  principal: real('principal').notNull(),
  startDate: text('start_date').notNull(),
  termMonths: integer('term_months').notNull(),
  isPrime: boolFlag('is_prime'),
  isCpiLinked: boolFlag('is_cpi_linked'),
  rateValue: real('rate_value').notNull(),
  cpiStart: real('cpi_start'),
  currency: text('currency').notNull().default('ILS'),
  excluded: boolFlag('excluded'),
  notes: text('notes'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  connectionId: text('connection_id'),
  externalId: text('external_id'),
  nameOverridden: boolFlag('name_overridden'),
});

export const rateCache = sqliteTable(
  'rate_cache',
  {
    series: text('series').notNull(),
    period: text('period').notNull(),
    value: real('value').notNull(),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.series, t.period] })],
);

export const categories = sqliteTable('categories', {
  name: text('name').primaryKey(),
  emoji: text('emoji').notNull().default('🏷️'),
  color: text('color').notNull().default('#8C8FA8'),
  catGroup: text('cat_group').notNull().default('variable'),
  sortOrder: integer('sort_order').notNull().default(100),
  isBuiltin: boolFlag('is_builtin'),
  createdAt: text('created_at').notNull(),
});

export const monthlySavings = sqliteTable('monthly_savings', {
  month: text('month').primaryKey(),
  amount: real('amount').notNull(),
  transferred: boolFlag('transferred'),
});

export const merchantSplits = sqliteTable('merchant_splits', {
  merchantKey: text('merchant_key').primaryKey(),
  splitCount: integer('split_count').notNull(),
  createdAt: text('created_at').notNull(),
});

export const categorySplits = sqliteTable('category_splits', {
  category: text('category').primaryKey(),
  splitCount: integer('split_count').notNull(),
  // Optional absolute "my share" of the category's recurring charge (e.g. rent
  // is ₪7,500 but I pay ₪2,250). When set it overrides the equal split_count
  // divisor everywhere the bill's amount is used. NULL = fall back to ÷N.
  shareAmount: real('share_amount'),
  createdAt: text('created_at').notNull(),
});

export const vouchers = sqliteTable('vouchers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  balance: real('balance').notNull(),
  currency: text('currency').notNull().default('ILS'),
  expiresOn: text('expires_on'),
  notes: text('notes'),
  excluded: boolFlag('excluded'),
  connectionId: text('connection_id'),
  externalId: text('external_id'),
  nameOverridden: boolFlag('name_overridden'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const splitwiseRepayments = sqliteTable('splitwise_repayments', {
  transactionId: text('transaction_id').primaryKey(),
  counterpartyId: text('counterparty_id').notNull(),
  counterpartyName: text('counterparty_name').notNull(),
  currency: text('currency').notNull(),
  amount: real('amount').notNull(),
  createdAt: text('created_at').notNull(),
});

// Read-only view (created by migration v24, last recreated by v40). `.existing()`
// means Drizzle treats it as already-present and only uses these column types for
// typed SELECTs — it will never try to (re)create it. Column shape mirrors the
// view's projection.
export const txnEffective = sqliteView('txn_effective', {
  id: text('id').notNull(),
  accountId: text('account_id').notNull(),
  date: text('date').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').notNull(),
  description: text('description').notNull(),
  category: text('category'),
}).existing();

// Re-export sql so callers importing the schema have the escape hatch handy
// for the few genuinely set-based aggregates (analytics, the view CTEs).
export { sql };
