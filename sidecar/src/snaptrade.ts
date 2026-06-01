import { randomUUID } from 'node:crypto';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import type { Account, Position } from 'snaptrade-typescript-sdk';
import type {
  BrokeragePerformanceData,
  BrokerageRangeStats,
  CompanyInfo,
  NormalizedAccount,
  NormalizedHolding,
  PerformancePoint,
  ScrapeOutcome,
} from './scrapers.js';
import {
  clearSnapTradeUser,
  loadSnapTradeUser,
  saveSnapTradeUser,
  type SnapTradeUser,
} from './snaptradeUser.js';
import type { Vault } from './vault.js';

// The SnapTrade SDK throws `SnaptradeError` with the response body in
// `responseBody` — a JSON string like {"detail":"...","code":"1012"}.
function snapErrorBody(err: unknown): { detail?: string; code?: string } | null {
  const raw = (err as { responseBody?: unknown })?.responseBody;
  if (raw && typeof raw === 'object') {
    return raw as { detail?: string; code?: string };
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as { detail?: string; code?: string })
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Turns a SnapTrade SDK error into a human-readable message. */
export function describeSnapError(err: unknown): string {
  const body = snapErrorBody(err);
  if (body?.detail) {
    return body.code ? `${body.detail} (code ${body.code})` : body.detail;
  }
  return (err as { message?: string })?.message ?? String(err);
}

/**
 * Returns the SnapTrade user for these credentials, if Hon already has one —
 * from the persistent store, or migrated from legacy per-connection creds.
 * Does not register a new user.
 */
export function getStoredUser(
  creds: Record<string, string>,
  vault: Vault,
): SnapTradeUser | null {
  const clientId = (creds.clientId ?? '').trim();
  const stored = loadSnapTradeUser(vault, clientId);
  if (stored) return stored;

  // Migrate a user that an older Hon version kept in the connection's creds.
  const userId = (creds.userId ?? '').trim();
  const userSecret = (creds.userSecret ?? '').trim();
  if (userId && userSecret) {
    const user = { userId, userSecret };
    saveSnapTradeUser(vault, clientId, user);
    return user;
  }
  return null;
}

export const SNAPTRADE_COMPANY_ID = 'snaptrade';

// SnapTrade's free tier allows linking up to this many brokerage connections.
export const SNAPTRADE_FREE_TIER_LIMIT = 5;

/** Catalog entry so SnapTrade shows up in the Add Account picker. */
export const snaptradeCompany: CompanyInfo = {
  id: SNAPTRADE_COMPANY_ID,
  name: 'SnapTrade (brokerages)',
  loginFields: ['clientId', 'consumerKey'],
  type: 'brokerage',
  domain: 'snaptrade.com',
};

export function isSnapTrade(companyId: string): boolean {
  return companyId === SNAPTRADE_COMPANY_ID;
}

/** Connection portal link plus the SnapTrade user the app must persist. */
export interface PortalResult {
  userId: string;
  userSecret: string;
  redirectURI: string;
  connectionCount: number;
  atLimit: boolean;
  /**
   * Set when the user was registered but the portal step failed. The caller
   * MUST still persist userId/userSecret — a personal key allows only one
   * user, so a lost secret orphans the key permanently.
   */
  error?: string;
}

export function makeClient(creds: Record<string, string>): Snaptrade {
  const clientId = (creds.clientId ?? '').trim();
  const consumerKey = (creds.consumerKey ?? '').trim();
  if (!clientId || !consumerKey) {
    throw new Error('SnapTrade needs both a Client ID and a Consumer Key.');
  }
  return new Snaptrade({ clientId, consumerKey });
}

/** A brokerage SnapTrade can connect, for the Add Account brokerage picker. */
export interface BrokerageOption {
  slug: string;
  name: string;
  logoUrl?: string;
}

/** Lists every brokerage SnapTrade currently supports for new connections. */
export async function listBrokerages(
  creds: Record<string, string>,
): Promise<BrokerageOption[]> {
  const snaptrade = makeClient(creds);
  const res = await snaptrade.referenceData.listAllBrokerages();
  return res.data
    .filter((b) => b.enabled !== false && !!b.slug)
    .map((b) => ({
      slug: b.slug as string,
      name: b.display_name || b.name || (b.slug as string),
      logoUrl: b.aws_s3_square_logo_url || b.aws_s3_logo_url || undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when an error is SnapTrade's "personal keys can only register one user". */
function isOneUserLimit(err: unknown): boolean {
  const body = snapErrorBody(err);
  return body?.code === '1012' || /only register one user/i.test(body?.detail ?? '');
}

/** True when SnapTrade reports the reporting/performance feature is not
 *  enabled for this plan/connection (HTTP 403, code 1141). Distinct from a
 *  transient failure so the caller can persist the disabled state and stop
 *  calling the dead endpoint. */
export function isFeatureDisabled(err: unknown): boolean {
  const body = snapErrorBody(err);
  return body?.code === '1141'
    || /feature is not enabled/i.test(body?.detail ?? '');
}

async function registerOnce(
  snaptrade: Snaptrade,
): Promise<{ userId: string; userSecret: string }> {
  const userId = `hon-${randomUUID()}`;
  const res = await snaptrade.authentication.registerSnapTradeUser({ userId });
  const userSecret = res.data.userSecret ?? '';
  if (!userSecret) throw new Error('SnapTrade did not return a user secret.');
  return { userId: res.data.userId ?? userId, userSecret };
}

/**
 * Registers a fresh SnapTrade user. A personal key allows exactly one user, so
 * if the slot is already taken by an orphan (a user whose secret Hon has lost —
 * e.g. its connection was removed), delete it and register again. Without this
 * the key would be permanently stuck returning 400.
 */
async function registerFreshUser(
  snaptrade: Snaptrade,
): Promise<{ userId: string; userSecret: string }> {
  try {
    return await registerOnce(snaptrade);
  } catch (err) {
    if (!isOneUserLimit(err)) throw err;
  }

  // Clear whatever orphaned user holds the key's single slot.
  const list = await snaptrade.authentication.listSnapTradeUsers();
  const orphans = list.data;
  for (const orphan of orphans) {
    if (typeof orphan === 'string') {
      await snaptrade.authentication.deleteSnapTradeUser({ userId: orphan });
    }
  }

  // Deletion is processed asynchronously, so retry registration briefly.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await registerOnce(snaptrade);
    } catch (err) {
      if (attempt === 4 || !isOneUserLimit(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error('SnapTrade could not register a user.');
}

/** True if `userId` is still registered with SnapTrade (not deleted). */
async function userIsRegistered(snaptrade: Snaptrade, userId: string): Promise<boolean> {
  try {
    const list = await snaptrade.authentication.listSnapTradeUsers();
    return list.data.includes(userId);
  } catch {
    // Can't verify — assume valid rather than needlessly re-registering.
    return true;
  }
}

/**
 * Returns a usable SnapTrade user, fully self-healing: reuses the stored user
 * if it still exists, drops it and registers a fresh one if it was deleted,
 * and clears any orphan blocking registration. The user never needs to run a
 * cleanup script.
 */
async function resolveUser(
  snaptrade: Snaptrade,
  creds: Record<string, string>,
  vault: Vault,
  clientId: string,
): Promise<SnapTradeUser> {
  const stored = getStoredUser(creds, vault);
  if (stored && (await userIsRegistered(snaptrade, stored.userId))) {
    return stored;
  }
  if (stored) clearSnapTradeUser(vault, clientId); // stale — was deleted

  const fresh = await registerFreshUser(snaptrade);
  saveSnapTradeUser(vault, clientId, fresh);
  return fresh;
}

/**
 * Returns a Connection Portal URL the user opens to link a brokerage, reusing
 * the persistent SnapTrade user (registering one on first use). The portal URL
 * expires in 5 minutes. Passing `broker` (a brokerage slug) opens the portal
 * straight at that brokerage; `customRedirect` is where the portal sends the
 * user once the connection completes.
 */
export async function createPortalLink(
  creds: Record<string, string>,
  vault: Vault,
  broker?: string,
  customRedirect?: string,
): Promise<PortalResult> {
  const snaptrade = makeClient(creds);
  const clientId = (creds.clientId ?? '').trim();

  const { userId, userSecret } = await resolveUser(snaptrade, creds, vault, clientId);

  // The user is persisted. Any failure past this point must still surface
  // userId/userSecret so the caller can persist them too.
  try {
    const connectionCount = await countConnections(snaptrade, userId, userSecret);

    const login = await snaptrade.authentication.loginSnapTradeUser({
      userId,
      userSecret,
      ...(broker ? { broker } : {}),
      ...(customRedirect ? { customRedirect } : {}),
    });
    const redirectURI = (login.data as { redirectURI?: string }).redirectURI;
    if (!redirectURI) {
      throw new Error('SnapTrade did not return a connection portal URL.');
    }

    return {
      userId,
      userSecret,
      redirectURI,
      connectionCount,
      atLimit: connectionCount >= SNAPTRADE_FREE_TIER_LIMIT,
    };
  } catch (err) {
    return {
      userId,
      userSecret,
      redirectURI: '',
      connectionCount: 0,
      atLimit: false,
      error: describeSnapError(err),
    };
  }
}

/**
 * Pulls every linked brokerage account (and its balance) from SnapTrade. The
 * user must have linked at least one brokerage through the connection portal.
 */
export async function runSnapTradeSync(
  creds: Record<string, string>,
  vault: Vault,
  opts: { skipPerformance?: boolean; skipActivities?: boolean } = {},
  onProgress?: (message: string) => void,
): Promise<ScrapeOutcome> {
  const user = getStoredUser(creds, vault);
  if (!user) {
    return {
      success: false,
      accounts: [],
      errorType: 'NEEDS_LINK',
      errorMessage:
        'No brokerage linked yet. Use “Link a brokerage” to connect one through SnapTrade.',
    };
  }
  const { userId, userSecret } = user;

  let snaptrade: Snaptrade;
  try {
    snaptrade = makeClient(creds);
  } catch (err) {
    return {
      success: false,
      accounts: [],
      errorType: 'CONFIG',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    onProgress?.('Fetching your brokerage accounts from SnapTrade…');
    const res = await snaptrade.accountInformation.listUserAccounts({ userId, userSecret });
    if (res.status !== 200) {
      throw new Error(`SnapTrade returned HTTP ${res.status} listing accounts.`);
    }
    const raw = res.data;

    // Fan out per-account holdings + activity fetches concurrently instead of
    // awaiting each account in series (5 accounts × ~3s each would block ~15s).
    // Promise.all preserves order, so the accounts array stays deterministic.
    const accounts: NormalizedAccount[] = await Promise.all(raw.map(async (account) => {
      const accountId = account.id;
      onProgress?.(`Fetching holdings for ${accountLabel(account)}…`);
      const [holdings, inceptionDate] = await Promise.all([
        fetchHoldings(snaptrade, userId, userSecret, accountId),
        opts.skipActivities
          ? Promise.resolve(undefined)
          : fetchEarliestActivityDate(snaptrade, userId, userSecret, accountId),
      ]);
      return normalizeSnapTradeAccount(account, holdings, inceptionDate);
    }));

    if (accounts.length === 0) {
      return {
        success: false,
        accounts: [],
        errorType: 'EMPTY',
        errorMessage:
          'SnapTrade returned no accounts. Link a brokerage, or give it a moment to finish syncing.',
      };
    }

    let brokeragePerformance: BrokeragePerformanceData | undefined;
    let performanceDisabled = false;
    if (!opts.skipPerformance) {
      onProgress?.('Fetching historical performance from SnapTrade…');
      const perf = await fetchPerformanceHistory(snaptrade, userId, userSecret);
      brokeragePerformance = perf.data;
      performanceDisabled = perf.disabled;
    }
    return { success: true, accounts, brokeragePerformance, performanceDisabled };
  } catch (err) {
    return {
      success: false,
      accounts: [],
      errorType: 'EXCEPTION',
      errorMessage: describeSnapTradeError(err),
    };
  }
}

export async function countConnections(
  snaptrade: Snaptrade,
  userId: string,
  userSecret: string,
): Promise<number> {
  try {
    const res = await snaptrade.connections.listBrokerageAuthorizations({ userId, userSecret });
    return res.data.length;
  } catch {
    return 0;
  }
}

/**
 * Pulls SnapTrade's full historical equity timeline for every linked account.
 * One call covers up to 10 years back so the web app's 1M / 3M / YTD / 1Y /
 * ALL toggles can slice client-side without re-hitting the API. Returns
 * `undefined` on any failure — the rest of the sync keeps working.
 */
const RANGE_KEYS = ['1M', '3M', 'YTD', '1Y', 'ALL'] as const;
type RangeKey = (typeof RANGE_KEYS)[number];

/** Picks the start date for a named timeframe; ALL is 10 years. */
function rangeStartDate(range: RangeKey, end: Date): Date {
  if (range === 'ALL') {
    const d = new Date(end);
    d.setFullYear(d.getFullYear() - 10);
    return d;
  }
  if (range === 'YTD') return new Date(end.getFullYear(), 0, 1);
  const months = range === '1M' ? 1 : range === '3M' ? 3 : 12;
  const d = new Date(end);
  d.setMonth(d.getMonth() - months);
  return d;
}

/** Pulls one timeframe's reporting payload. Logs and returns null on error. */
async function fetchRangeReport(
  snaptrade: Snaptrade,
  userId: string,
  userSecret: string,
  range: RangeKey,
  end: Date,
): Promise<{ raw: unknown | null; disabled: boolean }> {
  const start = rangeStartDate(range, end);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const res = await snaptrade.transactionsAndReporting.getReportingCustomRange({
      userId,
      userSecret,
      startDate: fmt(start),
      endDate: fmt(end),
      // Detailed mode (denser sampling for the equity timeline) only matters
      // for the ALL window — that's the one we actually draw. Skipping it on
      // shorter windows keeps the parallel fetch fast.
      detailed: range === 'ALL',
    });
    return { raw: res.data ?? {}, disabled: false };
  } catch (err) {
    const disabled = isFeatureDisabled(err);
    process.stdout.write(
      `snaptrade performance ${range} failed: ${describeSnapError(err)}` +
        (disabled ? ' [feature disabled]' : '') + '\n',
    );
    return { raw: null, disabled };
  }
}

function extractRangeStats(raw: unknown): BrokerageRangeStats {
  const d = (raw ?? {}) as {
    rateOfReturn?: number | null;
    dividendIncome?: number | null;
    // SnapTrade's PerformanceCustom nests this as a NetContributions object
    // whose numeric value lives under `.contributions` (NOT `.total`, which
    // never existed — the old read always nulled out). `.total` is kept as a
    // defensive fallback since the SDK types the payload loosely.
    contributions?: { contributions?: number | null; total?: number | null } | number | null;
  };
  let contributions: number | null = null;
  if (typeof d.contributions === 'object' && d.contributions) {
    contributions = d.contributions.contributions ?? d.contributions.total ?? null;
  } else if (typeof d.contributions === 'number') {
    contributions = d.contributions;
  }
  return {
    rateOfReturn: d.rateOfReturn ?? null,
    dividendIncome: d.dividendIncome ?? null,
    contributions,
  };
}

/**
 * Pulls SnapTrade's reporting payload for every timeframe the UI exposes —
 * one call per range, in parallel. The equity timeline comes from the ALL
 * window (sliced client-side for 1M / 3M / YTD / 1Y); the per-range rate of
 * return, dividend income and contributions populate `byRange`, so the
 * matching tile updates instantly when the user flips the pill.
 */
async function fetchPerformanceHistory(
  snaptrade: Snaptrade,
  userId: string,
  userSecret: string,
): Promise<{ data?: BrokeragePerformanceData; disabled: boolean }> {
  const end = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const fetched = await Promise.all(
    RANGE_KEYS.map(async (r) =>
      [r, await fetchRangeReport(snaptrade, userId, userSecret, r, end)] as const),
  );

  // ALL anchors the equity series; if it failed, the chart has nothing to
  // draw and we report the whole fetch as a miss. Yahoo backfill will pick
  // up the slack downstream.
  const allEntry = fetched.find(([r]) => r === 'ALL');

  // Report the feature disabled when the ALL range specifically hit the
  // 403/1141 wall (it's the range that anchors the chart). Requiring EVERY
  // range to fail meant a plan that disables only the ALL/detailed window
  // never persisted the flag and re-hit the dead endpoint every sync.
  const disabled = allEntry
    ? allEntry[1].disabled
    : fetched.every(([, res]) => res.disabled);
  const allData = allEntry ? (allEntry[1].raw as
    {
      totalEquityTimeframe?: unknown;
      contributionTimeframeCumulative?: unknown;
      rateOfReturn?: number | null;
      dividendIncome?: number | null;
      contributions?: { contributions?: number | null; total?: number | null } | number | null;
    } | null) : null;
  if (!allData) return { data: undefined, disabled };

  const byRange: Record<string, BrokerageRangeStats> = {};
  for (const [r, res] of fetched) {
    if (res.raw) byRange[r] = extractRangeStats(res.raw);
  }

  const totalEquity = mapPoints(allData.totalEquityTimeframe);
  const allRange = byRange.ALL ?? extractRangeStats(allData);
  const startDate = fmt(rangeStartDate('ALL', end));
  const endDate = fmt(end);
  if (totalEquity.length === 0) {
    process.stdout.write(
      `snaptrade performance: empty totalEquityTimeframe (${startDate}..${endDate})\n`,
    );
  }

  return {
    data: {
      totalEquity,
      contributionsCumulative: mapPoints(allData.contributionTimeframeCumulative),
      rateOfReturn: allRange.rateOfReturn,
      dividendIncome: allRange.dividendIncome,
      contributions: allRange.contributions,
      currency: totalEquity[0]?.currency,
      rangeStart: startDate,
      rangeEnd: endDate,
      byRange,
    },
    disabled,
  };
}

function mapPoints(arr: unknown): PerformancePoint[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p): PerformancePoint | null => {
      const point = p as { date?: string; value?: number; currency?: string };
      if (!point.date || typeof point.value !== 'number') return null;
      return { date: point.date, value: point.value, currency: point.currency };
    })
    .filter((p): p is PerformancePoint => p !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Pulls the securities held in one brokerage account. A failed fetch (a
 * brokerage still doing its initial sync, an unsupported account type) must
 * not sink the whole sync — the error is logged and the list returns empty.
 */
/**
 * Earliest activity date SnapTrade has for the account — the user's first
 * trade / deposit / transfer. The Insights chart uses it as the brokerage
 * "inception date" so ALL means "since I started", not 10 years of Yahoo
 * pretend-history. Returns undefined when there are no activities yet, the
 * dates can't be parsed, or the call errors (in which case the rest of the
 * sync keeps working).
 */
async function fetchEarliestActivityDate(
  snaptrade: Snaptrade,
  userId: string,
  userSecret: string,
  accountId: string,
): Promise<string | undefined> {
  try {
    // Wide window — SnapTrade caps internally per their plan, but 25 years
    // is well past any realistic brokerage account age.
    const end = new Date();
    const start = new Date(end);
    start.setFullYear(start.getFullYear() - 25);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const res = await snaptrade.transactionsAndReporting.getActivities({
      userId,
      userSecret,
      accounts: accountId,
      startDate: fmt(start),
      endDate: fmt(end),
    });
    const rows = res.data;
    let earliest: string | undefined;
    let sampleKeys: string[] = [];
    for (const r of rows) {
      if (sampleKeys.length === 0 && r && typeof r === 'object') {
        sampleKeys = Object.keys(r).slice(0, 20);
      }
      // The library types `trade_date` and `settlement_date` as string |
      // Date | undefined. Trade date is the canonical "when this happened"
      // for portfolio history; settlement is the bookkeeping date. Prefer
      // trade_date; fall back to settlement_date for activities without it.
      const raw = (r as any).trade_date
        ?? (r as any).settlement_date
        ?? (r as any).tradeDate
        ?? (r as any).settlementDate;
      const iso = typeof raw === 'string'
        ? raw.slice(0, 10)
        : raw instanceof Date && !Number.isNaN(raw.valueOf())
          ? raw.toISOString().slice(0, 10)
          : null;
      if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
      if (!earliest || iso < earliest) earliest = iso;
    }
    // Write to stderr so the line lands in the sidecar.log file
    // (web.mjs tees stderr → ~/Library/.../Hon/sidecar.log; stdout is
    // inherit and only the launching terminal sees it).
    process.stderr.write(
      `snaptrade activities ${accountId}: ${rows.length} rows, `
      + `earliest=${earliest ?? 'NONE'}`
      + (rows.length && !earliest ? `, sample keys=[${sampleKeys.join(',')}]` : '')
      + '\n',
    );
    return earliest;
  } catch (err) {
    process.stderr.write(
      `snaptrade activities ${accountId}: ${describeSnapError(err)}\n`,
    );
    return undefined;
  }
}

/**
 * Map a single SnapTrade Position to a NormalizedHolding.
 *
 * Returns null when the position is a cash-equivalent sweep fund
 * (`cash_equivalent === true`) — those are already counted in the account's
 * cash balance, so mapping them as holdings would double-count vs the
 * balance-derived Cash row in the UI.
 *
 * Also returns null when the position lacks a usable ticker or unit count
 * (i.e. it is genuinely unparseable).
 */
export function normalizePosition(p: Position): NormalizedHolding | null {
  // SnapTrade flags money-market sweep funds with cash_equivalent=true.
  // The account balance already counts them, so mapping them as separate
  // holdings would double-count vs the balance-derived Cash row in the UI.
  if (p.cash_equivalent === true) return null;

  // SnapTrade nests the security info in `symbol.symbol` (a
  // UniversalSymbol). Some brokerages return the universal symbol
  // directly under `symbol`, so try both.
  const inner = p.symbol?.symbol ?? p.symbol;
  const ticker =
    inner?.symbol || inner?.raw_symbol || p.symbol?.description;
  const units = typeof p.units === 'number'
    ? p.units
    : typeof p.fractional_units === 'number'
      ? p.fractional_units
      : null;
  if (!ticker || units == null) return null;
  return {
    symbol: String(ticker),
    description: inner?.description ?? p.symbol?.description ?? undefined,
    units,
    price: typeof p.price === 'number' ? p.price : undefined,
    currency: p.currency?.code ?? inner?.currency?.code ?? 'USD',
    costBasis:
      typeof p.average_purchase_price === 'number'
        ? p.average_purchase_price
        : undefined,
    // open_pnl is a position TOTAL, not per-unit. Per the SnapTrade SDK's own
    // JSDoc the field is unreliable — they recommend computing P&L from
    // average_purchase_price and current market price instead. Hon uses it
    // only as a last-resort fallback in holdingStats() (InsightsView.tsx),
    // which is safe because the preferred path is the per-unit calculation.
    openPnl: typeof p.open_pnl === 'number' ? p.open_pnl : undefined,
  };
}

async function fetchHoldings(
  snaptrade: Snaptrade,
  userId: string,
  userSecret: string,
  accountId: string,
): Promise<NormalizedHolding[]> {
  try {
    const res = await snaptrade.accountInformation.getUserAccountPositions({
      userId,
      userSecret,
      accountId,
    });
    const positions = res.data;
    const normalized = positions
      .map(normalizePosition)
      .filter((h): h is NormalizedHolding => h !== null);

    const cashEquivCount = positions.filter((p) => p.cash_equivalent === true).length;
    if (cashEquivCount > 0) {
      process.stdout.write(
        `snaptrade holdings: skipped ${cashEquivCount} cash-equivalent position(s) for ${accountId} ` +
          `(balance already accounts for these)\n`,
      );
    }

    if (positions.length > 0 && normalized.length === 0) {
      // Brokerage returned positions but every one was unparseable — log a
      // sample so we can tell whether the shape changed.
      process.stdout.write(
        `snaptrade holdings: ${positions.length} positions for ${accountId} ` +
          `but none parseable; sample=${JSON.stringify(positions[0]).slice(0, 400)}\n`,
      );
    }
    return normalized;
  } catch (err) {
    process.stdout.write(
      `snaptrade holdings fetch failed for ${accountId}: ${describeSnapError(err)}\n`,
    );
    return [];
  }
}

function accountLabel(account: { name?: string | null; institution_name?: string }): string {
  const institution = account.institution_name?.trim();
  const name = account.name?.trim();
  if (institution && name) {
    return name.includes(institution) ? name : `${institution} · ${name}`;
  }
  return name || institution || 'Brokerage account';
}

/**
 * Build a NormalizedAccount from a SnapTrade Account and its already-fetched
 * holdings. Kept pure (no SDK calls) so the balance-derivation logic is
 * unit-testable in isolation — the per-account map in runSnapTradeSync owns the
 * async fetches and delegates the rest here.
 *
 * When the brokerage reports a total balance we use it (a reported 0 is real,
 * so we test for a number, not truthiness). Otherwise we derive one from the
 * priced positions — but only when they share a single currency, since you
 * can't sum mixed-currency positions without FX rates, and only when at least
 * one is priced (else the reduce is a meaningless 0). A derived 0 (fully closed)
 * or negative (margin debit / net short) net is valid and is kept, not discarded.
 */
export function normalizeSnapTradeAccount(
  account: Account,
  holdings: NormalizedHolding[],
  inceptionDate: string | undefined,
): NormalizedAccount {
  const amount = account.balance?.total?.amount;
  let balance = typeof amount === 'number' ? amount : undefined;
  let currency = account.balance?.total?.currency ?? 'USD';
  if (balance === undefined && holdings.length > 0) {
    const currencies = new Set(holdings.map((h) => h.currency));
    if (currencies.size === 1) {
      const priced = holdings.filter((h) => h.price != null);
      if (priced.length > 0) {
        balance = priced.reduce((s, h) => s + h.units * h.price!, 0);
        currency = holdings[0]!.currency;
      }
    }
  }
  return {
    accountNumber: account.number || account.id,
    label: accountLabel(account),
    balance,
    currency,
    transactions: [],
    holdings,
    inceptionDate,
  };
}

function describeSnapTradeError(err: unknown): string {
  if (err && typeof err === 'object' && 'responseBody' in err) {
    const body = (err as { responseBody?: { detail?: string } }).responseBody;
    if (body?.detail) return body.detail;
  }
  return err instanceof Error ? err.message : String(err);
}
