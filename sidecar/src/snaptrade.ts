import { randomUUID } from 'node:crypto';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import type { CompanyInfo, NormalizedAccount, ScrapeOutcome } from './scrapers.js';
import {
  clearSnapTradeUser,
  loadSnapTradeUser,
  saveSnapTradeUser,
  type SnapTradeUser,
} from './snaptradeUser.js';

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
function getStoredUser(
  creds: Record<string, string>,
  dataDir: string,
): SnapTradeUser | null {
  const clientId = (creds.clientId ?? '').trim();
  const stored = loadSnapTradeUser(dataDir, clientId);
  if (stored) return stored;

  // Migrate a user that an older Hon version kept in the connection's creds.
  const userId = (creds.userId ?? '').trim();
  const userSecret = (creds.userSecret ?? '').trim();
  if (userId && userSecret) {
    const user = { userId, userSecret };
    saveSnapTradeUser(dataDir, clientId, user);
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

function makeClient(creds: Record<string, string>): Snaptrade {
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
  return (res.data ?? [])
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
  const orphans = Array.isArray(list.data) ? list.data : [];
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
    return Array.isArray(list.data) && list.data.includes(userId);
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
  dataDir: string,
  clientId: string,
): Promise<SnapTradeUser> {
  const stored = getStoredUser(creds, dataDir);
  if (stored && (await userIsRegistered(snaptrade, stored.userId))) {
    return stored;
  }
  if (stored) clearSnapTradeUser(dataDir, clientId); // stale — was deleted

  const fresh = await registerFreshUser(snaptrade);
  saveSnapTradeUser(dataDir, clientId, fresh);
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
  dataDir: string,
  broker?: string,
  customRedirect?: string,
): Promise<PortalResult> {
  const snaptrade = makeClient(creds);
  const clientId = (creds.clientId ?? '').trim();

  const { userId, userSecret } = await resolveUser(snaptrade, creds, dataDir, clientId);

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
  dataDir: string,
  onProgress?: (message: string) => void,
): Promise<ScrapeOutcome> {
  const user = getStoredUser(creds, dataDir);
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
    const raw = Array.isArray(res.data) ? res.data : [];

    const accounts: NormalizedAccount[] = raw.map((account) => {
      const amount = account.balance?.total?.amount;
      return {
        accountNumber: account.number || account.id,
        label: accountLabel(account),
        balance: typeof amount === 'number' ? amount : undefined,
        currency: account.balance?.total?.currency ?? 'USD',
        transactions: [],
      };
    });

    if (accounts.length === 0) {
      return {
        success: false,
        accounts: [],
        errorType: 'EMPTY',
        errorMessage:
          'SnapTrade returned no accounts. Link a brokerage, or give it a moment to finish syncing.',
      };
    }
    return { success: true, accounts };
  } catch (err) {
    return {
      success: false,
      accounts: [],
      errorType: 'EXCEPTION',
      errorMessage: describeSnapTradeError(err),
    };
  }
}

async function countConnections(
  snaptrade: Snaptrade,
  userId: string,
  userSecret: string,
): Promise<number> {
  try {
    const res = await snaptrade.connections.listBrokerageAuthorizations({ userId, userSecret });
    return Array.isArray(res.data) ? res.data.length : 0;
  } catch {
    return 0;
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

function describeSnapTradeError(err: unknown): string {
  if (err && typeof err === 'object' && 'responseBody' in err) {
    const body = (err as { responseBody?: { detail?: string } }).responseBody;
    if (body?.detail) return body.detail;
  }
  return err instanceof Error ? err.message : String(err);
}
