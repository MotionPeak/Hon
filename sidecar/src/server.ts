import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DbHandle } from './db.js';
import { Repo } from './repo.js';
import { ScrapeRunner } from './runner.js';
import { companyCatalog, isSupportedCompany } from './scrapers.js';
import { createPortalLink, listBrokerages, describeSnapError } from './snaptrade.js';
import { migrateLegacySnapTradeUsers } from './snaptradeUser.js';
import {
  verifyKey,
  fetchPickList,
  planSplit,
  createExpense,
  deleteExpense,
  refreshSplitwise,
} from './splitwise.js';
import { getLogo } from './logos.js';
import { Vault } from './vault.js';
import { LlmManager } from './llm.js';
import { Categorizer, CATEGORIES } from './categorize.js';
import { buildBudgetReport } from './budget.js';
import { persistPiggyMonth } from './piggy.js';
import { InsightsGenerator } from './insights.js';
import { SubscriptionMatcher } from './subscriptions.js';
import { totalInILS } from './fx.js';
import { lookupVehicle } from './vehicle.js';

const START = Date.now();
const VERSION = '0.2.0';

// --- Configuration (passed in by the Hon app, with dev-friendly fallbacks) ---
const token = process.env.HON_TOKEN ?? '';
const dataDir =
  process.env.HON_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Hon');
const port = Number(process.env.HON_PORT ?? 0); // 0 => OS picks a free port
// The interface to bind. Loopback by default — nothing leaves the machine.
// A NAS/server deployment sets HON_HOST=0.0.0.0 so the LAN (or a VPN such as
// Tailscale) can reach it.
const host = process.env.HON_HOST ?? '127.0.0.1';
const isLoopbackHost =
  host === '127.0.0.1' || host === 'localhost' || host === '::1';

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}
function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

// --- Database ---------------------------------------------------------------
let dbHandle: DbHandle | null = null;
let dbStatus = 'unopened';
let repo: Repo | null = null;
let runner: ScrapeRunner | null = null;
// Password-protected credential store for the web app (no macOS Keychain).
let vault: Vault | null = null;
try {
  dbHandle = openDatabase(dataDir);
  repo = new Repo(dbHandle.db);
  vault = new Vault(repo);
  runner = new ScrapeRunner(repo, dataDir, vault);
  dbStatus = `ok (schema v${dbHandle.schemaVersion})`;
  log(`database ready at ${dbHandle.path}`);
} catch (err) {
  dbStatus = `error: ${(err as Error).message}`;
  log(`database error: ${(err as Error).message}`);
}

// On-device LLM (model download + load). Independent of the database.
const llm = new LlmManager(dataDir);

// Transaction categorization (rules + LLM). Needs the database.
const categorizer: Categorizer | null = repo ? new Categorizer(repo, llm) : null;

// Budget insights (LLM free-text). Needs the database.
const insights: InsightsGenerator | null = repo ? new InsightsGenerator(repo, llm) : null;

// Detects renamed subscriptions (LLM). Works off names sent by the web app.
const subscriptionMatcher = new SubscriptionMatcher(llm);

// The interactive web app (served at `/`). It carries no data of its own —
// its JavaScript fetches the API with the token taken from the URL.
const webAppHtml = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', 'public', 'app.html'), 'utf8');
  } catch {
    return '<!doctype html><title>Hon</title><p>Web app page not found.</p>';
  }
})();

// --- HTTP server ------------------------------------------------------------
const app = Fastify({ logger: false });

// Every request must carry the bearer token the app generated this launch.
// The web app page itself is exempt (it holds no data); its scripts then
// authenticate every API call with the token passed in the page URL.
app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'GET' && req.url === '/') return;
  // Institution logos carry no private data and are loaded by <img> tags,
  // which cannot send an Authorization header — so they are exempt.
  if (req.method === 'GET' && req.url.startsWith('/logo/')) return;
  // The post-connection landing page is opened by SnapTrade in a browser,
  // which carries no token. It is a static page with no private data.
  if (req.method === 'GET' && req.url.startsWith('/snaptrade/done')) return;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(webAppHtml));

app.get('/health', async () => ({
  ok: true,
  name: 'hon-sidecar',
  version: VERSION,
  uptimeMs: Date.now() - START,
  db: dbStatus,
  pid: process.pid,
}));

app.get('/companies', async () => ({ companies: companyCatalog() }));

// --- Credential vault -------------------------------------------------------

app.get('/vault/status', async (_req, reply) => {
  if (!vault) return reply.code(503).send({ error: 'database unavailable' });
  return { exists: vault.exists(), unlocked: vault.unlocked };
});

app.post('/vault/unlock', async (req, reply) => {
  if (!vault) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as { passphrase?: string };
  try {
    vault.unlock(body.passphrase ?? '');
    // Fold any plaintext SnapTrade users from older versions into the vault.
    migrateLegacySnapTradeUsers(vault, dataDir);
    return { ok: true, exists: vault.exists(), unlocked: true };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/vault/lock', async (_req, reply) => {
  if (!vault) return reply.code(503).send({ error: 'database unavailable' });
  vault.lock();
  return { ok: true };
});

app.get('/connections', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { connections: repo.listConnections() };
});

// Serves an institution's logo, fetched from its own website and cached.
// An explicit `?domain=` is used for SnapTrade brokerages, which are not in
// the scraper catalog (e.g. Interactive Brokers).
app.get('/logo/:companyId', async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const q = req.query as { domain?: string };
  let domain = q.domain;
  if (domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
    return reply.code(400).send({ error: 'bad domain' });
  }
  if (!domain) {
    domain = companyCatalog().find((c) => c.id === companyId)?.domain;
  }
  if (!domain) return reply.code(404).send({ error: 'no logo' });
  const logo = await getLogo(dataDir, companyId, domain);
  if (!logo) return reply.code(404).send({ error: 'logo not found' });
  reply.header('Cache-Control', 'public, max-age=604800');
  return reply.type(logo.contentType).send(logo.body);
});

app.post('/connections', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as {
    companyId?: string;
    displayName?: string;
    credentials?: Record<string, string>;
  };
  if (!body.companyId || !isSupportedCompany(body.companyId)) {
    return reply.code(400).send({ error: 'unknown or unsupported companyId' });
  }
  const displayName = (body.displayName ?? '').trim() || body.companyId;
  const connection = repo.createConnection(body.companyId, displayName);

  // The web app supplies credentials here so they can be stored in the vault;
  // the Swift app omits them (it keeps them in the macOS Keychain instead).
  if (body.credentials && typeof body.credentials === 'object') {
    if (!vault?.unlocked) {
      repo.deleteConnection(connection.id);
      return reply.code(409).send({ error: 'the credential vault is locked' });
    }
    vault.saveCredentials(connection.id, body.credentials);
  }
  return { connection };
});

app.delete('/connections/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  repo.deleteConnection(id);
  return { ok: true };
});

// Stores (or replaces) the vault credentials for an existing connection — the
// web app uses this for connections that were first created by the Swift app.
app.put('/connections/:id/credentials', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  if (!repo.getConnection(id)) return reply.code(404).send({ error: 'connection not found' });
  const body = (req.body ?? {}) as { credentials?: Record<string, string> };
  if (!body.credentials || typeof body.credentials !== 'object') {
    return reply.code(400).send({ error: 'credentials are required' });
  }
  if (!vault?.unlocked) {
    return reply.code(409).send({ error: 'the credential vault is locked' });
  }
  vault.saveCredentials(id, body.credentials);
  return { ok: true };
});

app.post('/connections/:id/scrape', async (req, reply) => {
  if (!repo || !runner) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  const connection = repo.getConnection(id);
  if (!connection) return reply.code(404).send({ error: 'connection not found' });

  const body = (req.body ?? {}) as {
    credentials?: Record<string, string>;
    monthsBack?: number;
    interactive?: boolean;
  };
  // The Swift app sends credentials in the request (from the Keychain); the
  // web app omits them, so they are loaded from the vault instead.
  let credentials = body.credentials;
  if (!credentials || typeof credentials !== 'object') {
    if (!vault?.unlocked) {
      return reply.code(409).send({ error: 'the credential vault is locked' });
    }
    credentials = vault.loadCredentials(id);
    if (!credentials) {
      return reply.code(400).send({ error: 'no stored credentials for this connection' });
    }
  }
  // Each scraper returns whatever history it actually holds, so asking for a
  // long window simply means "as far back as the institution allows".
  const monthsBack =
    typeof body.monthsBack === 'number' && Number.isFinite(body.monthsBack)
      ? Math.max(1, Math.min(24, Math.round(body.monthsBack)))
      : 12;

  const runId = runner.start({
    connectionId: connection.id,
    companyId: connection.companyId,
    credentials,
    monthsBack,
    interactive: body.interactive === true,
  });
  return { runId };
});

app.get('/scrape/:runId', async (req, reply) => {
  if (!repo || !runner) return reply.code(503).send({ error: 'database unavailable' });
  const { runId } = req.params as { runId: string };

  const live = runner.getStatus(runId);
  if (live) return { run: live };

  const persisted = repo.getRun(runId);
  if (!persisted) return reply.code(404).send({ error: 'run not found' });
  return {
    run: {
      runId: persisted.id,
      connectionId: persisted.connectionId,
      status: persisted.status,
      message: persisted.message ?? '',
      accountsCount: persisted.accountsCount,
      transactionsCount: persisted.transactionsCount,
      startedAt: persisted.startedAt,
      finishedAt: persisted.finishedAt ?? undefined,
    },
  };
});

app.post('/scrape/:runId/otp', async (req, reply) => {
  if (!runner) return reply.code(503).send({ error: 'database unavailable' });
  const { runId } = req.params as { runId: string };
  const body = (req.body ?? {}) as { code?: string };
  const code = (body.code ?? '').trim();
  if (!code) {
    return reply.code(400).send({ error: 'code is required' });
  }
  if (!runner.submitOtp(runId, code)) {
    return reply.code(404).send({ error: 'no run is waiting for a code' });
  }
  return { ok: true };
});

// Registers the SnapTrade user (first time) and returns a Connection Portal
// URL the app opens so the user can link a brokerage. The Swift app passes
// credentials directly; the web app passes a connectionId (vault-backed).
app.post('/snaptrade/portal', async (req, reply) => {
  const body = (req.body ?? {}) as {
    credentials?: Record<string, string>;
    connectionId?: string;
    broker?: string;
    customRedirect?: string;
  };

  let credentials = body.credentials;
  if ((!credentials || typeof credentials !== 'object') && body.connectionId) {
    if (!vault?.unlocked) {
      return reply.code(409).send({ error: 'the credential vault is locked' });
    }
    credentials = vault.loadCredentials(body.connectionId);
  }
  if (!credentials || typeof credentials !== 'object') {
    return reply.code(400).send({ error: 'credentials are required' });
  }
  // The SnapTrade user this registers is persisted encrypted in the vault.
  if (!vault?.unlocked) {
    return reply.code(409).send({ error: 'the credential vault is locked' });
  }

  try {
    const portal = await createPortalLink(
      credentials, vault, body.broker, body.customRedirect);
    return { portal };
  } catch (err) {
    return reply.code(400).send({ error: describeSnapError(err) });
  }
});

// Lists every brokerage SnapTrade supports, so the Add Account flow can show
// them with logos. Needs only the developer credentials (no SnapTrade user).
app.post('/snaptrade/brokerages', async (req, reply) => {
  const body = (req.body ?? {}) as {
    credentials?: Record<string, string>;
    connectionId?: string;
  };

  let credentials = body.credentials;
  if ((!credentials || typeof credentials !== 'object') && body.connectionId) {
    if (!vault?.unlocked) {
      return reply.code(409).send({ error: 'the credential vault is locked' });
    }
    credentials = vault.loadCredentials(body.connectionId);
  }
  if (!credentials || typeof credentials !== 'object') {
    return reply.code(400).send({ error: 'credentials are required' });
  }

  try {
    return { brokerages: await listBrokerages(credentials) };
  } catch (err) {
    return reply.code(400).send({ error: describeSnapError(err) });
  }
});

// Landing page SnapTrade's portal redirects to once a brokerage is connected
// (used by the web app; the macOS app uses a hon:// deep link instead).
app.get('/snaptrade/done', async (_req, reply) =>
  reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Hon — Connected</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center;
    justify-content:center; background:#14131c; color:#ece9f5;
    font-family:-apple-system,system-ui,sans-serif; }
  .box { text-align:center; max-width:380px; padding:32px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#ffffff8c; font-size:14px; line-height:1.5; }
</style></head>
<body><div class="box">
  <h1>Brokerage connected</h1>
  <p>Your brokerage is linked. You can close this tab and return to Hon,
  then press Sync.</p>
</div></body></html>`));

app.get('/accounts', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { accounts: repo.listAccounts() };
});

// Sets an account balance by hand. Credit-card scrapers do not report a
// balance, and a manual figure also lets the user correct a stale one.
app.patch('/accounts/:id/balance', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { balance?: number };
  const balance = Number(body.balance);
  if (!Number.isFinite(balance)) {
    return reply.code(400).send({ error: 'a numeric balance is required' });
  }
  if (!repo.listAccounts().some((a) => a.id === id)) {
    return reply.code(404).send({ error: 'account not found' });
  }
  repo.setAccountBalance(id, balance);
  return { ok: true };
});

app.get('/transactions', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const q = req.query as { accountId?: string; limit?: string };
  const limit = q.limit ? Math.max(1, Math.min(1000, Number(q.limit) || 200)) : 200;
  return { transactions: repo.listTransactions({ accountId: q.accountId, limit }) };
});

app.get('/summary', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const summary = repo.summary();
  // A single net-worth figure, every currency converted to ILS. Null when the
  // FX lookup fails — the app then falls back to the per-currency breakdown.
  const netWorthILS = await totalInILS(summary.byCurrency);

  // Break the net worth down by source: bank / card / brokerage accounts and
  // each kind of manual asset, every bucket converted to ILS.
  const typeOf = new Map(companyCatalog().map((c) => [c.id, c.type]));
  const buckets = new Map<string, Map<string, number>>();
  const addToBucket = (key: string, currency: string, amount: number): void => {
    const byCur = buckets.get(key) ?? new Map<string, number>();
    byCur.set(currency, (byCur.get(currency) ?? 0) + amount);
    buckets.set(key, byCur);
  };
  for (const acct of repo.listAccounts()) {
    addToBucket(typeOf.get(acct.companyId) ?? 'bank', acct.currency, acct.balance ?? 0);
  }
  for (const asset of repo.listManualAssets()) {
    addToBucket(`asset:${asset.kind}`, asset.currency, asset.value);
  }
  const sources: { key: string; amount: number }[] = [];
  for (const [key, byCur] of buckets) {
    const amount = await totalInILS(
      [...byCur].map(([currency, total]) => ({ currency, total })),
    );
    if (amount != null && Math.abs(amount) >= 0.5) sources.push({ key, amount });
  }
  sources.sort((a, b) => b.amount - a.amount);

  return { summary: { ...summary, netWorthILS, sources } };
});

// Moves one transaction to a different category. With `applyToMerchant`, the
// choice is saved as a rule so transactions from the same business — past and
// future — categorize the same way.
app.patch('/transactions/:id/category', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { category?: string; applyToMerchant?: boolean };
  if (!body.category || !(CATEGORIES as readonly string[]).includes(body.category)) {
    return reply.code(400).send({ error: 'unknown category' });
  }
  const txn = repo.getTransaction(id);
  if (!txn) return reply.code(404).send({ error: 'transaction not found' });

  repo.updateTransactionCategory(id, body.category);
  if (body.applyToMerchant) {
    repo.setMerchantRule(txn.description, body.category);
    repo.applyMerchantRule(txn.description, body.category);
  }
  return { ok: true };
});

// How often a merchant recurs. 'monthly'/'bimonthly'/'yearly' tag a recurring
// expense (for monthly-equivalent cost); 'income' tags a recurring income
// source (a salary) so the budget projection anchors on it.
const RECURRENCE_FREQUENCIES = ['monthly', 'bimonthly', 'yearly', 'income'];

app.get('/merchant-frequencies', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const frequencies: Record<string, string> = {};
  for (const row of repo.listMerchantFrequencies()) {
    frequencies[row.merchantKey] = row.frequency;
  }
  return { frequencies };
});

app.put('/merchant-frequency', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as { key?: string; frequency?: string };
  const key = (body.key ?? '').trim();
  if (!key) return reply.code(400).send({ error: 'a merchant key is required' });
  // 'none' clears the tag — used to un-mark a recurring income source.
  if (body.frequency === 'none') {
    repo.clearMerchantFrequency(key);
    return { ok: true };
  }
  if (!body.frequency || !RECURRENCE_FREQUENCIES.includes(body.frequency)) {
    return reply.code(400).send({ error: 'unknown frequency' });
  }
  repo.setMerchantFrequency(key, body.frequency);
  return { ok: true };
});

// Links an expense to a refunding/reimbursing transaction, so the refund is
// folded into the expense and not double-counted across the app.
app.put('/transactions/:id/link', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { refundId?: string };
  if (!body.refundId) return reply.code(400).send({ error: 'refundId is required' });
  if (body.refundId === id) {
    return reply.code(400).send({ error: 'a transaction cannot refund itself' });
  }
  if (!repo.getTransaction(id)) {
    return reply.code(404).send({ error: 'expense not found' });
  }
  if (!repo.getTransaction(body.refundId)) {
    return reply.code(404).send({ error: 'refund transaction not found' });
  }
  repo.setTransactionLink(id, body.refundId);
  return { ok: true };
});

app.delete('/transactions/:id/link', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  repo.deleteTransactionLink(id);
  return { ok: true };
});

// --- Splitwise --------------------------------------------------------------
// Splits a Hon transaction onto Splitwise and tracks repayment. The API key is
// kept encrypted in the vault alongside the user id it belongs to — needed to
// tell, in a settle-up payment, which direction the money flowed.

interface SplitwiseAccount {
  apiKey: string;
  userId: number;
  name: string;
}

function loadSplitwiseAccount(): SplitwiseAccount | null {
  if (!vault?.unlocked) return null;
  const blob = vault.loadSecret('splitwise-account');
  if (!blob) return null;
  try {
    const acct = JSON.parse(blob) as SplitwiseAccount;
    return acct?.apiKey && acct?.userId ? acct : null;
  } catch {
    return null;
  }
}

app.get('/splitwise/status', async (_req, reply) => {
  if (!vault) return reply.code(503).send({ error: 'database unavailable' });
  const acct = loadSplitwiseAccount();
  return { connected: !!acct, user: acct ? { id: acct.userId, name: acct.name } : null };
});

app.post('/splitwise/connect', async (req, reply) => {
  if (!vault) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault.unlocked) return reply.code(409).send({ error: 'the credential vault is locked' });
  const body = (req.body ?? {}) as { apiKey?: string };
  const apiKey = (body.apiKey ?? '').trim();
  if (!apiKey) return reply.code(400).send({ error: 'an API key is required' });
  try {
    const user = await verifyKey(apiKey);
    vault.saveSecret(
      'splitwise-account',
      JSON.stringify({ apiKey, userId: user.id, name: user.name }),
    );
    return { connected: true, user: { id: user.id, name: user.name } };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/splitwise/disconnect', async (_req, reply) => {
  if (!vault) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault.unlocked) return reply.code(409).send({ error: 'the credential vault is locked' });
  vault.clearSecret('splitwise-account');
  return { ok: true };
});

// Friends and groups the user can split with, plus their own Splitwise id so
// the web app can include the user in the split.
app.get('/splitwise/groups', async (_req, reply) => {
  if (!vault) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault.unlocked) return reply.code(409).send({ error: 'the credential vault is locked' });
  const acct = loadSplitwiseAccount();
  if (!acct) return reply.code(400).send({ error: 'Splitwise is not connected' });
  try {
    const picks = await fetchPickList(acct.apiKey);
    return {
      friends: picks.friends,
      groups: picks.groups,
      me: { id: acct.userId, name: acct.name },
    };
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Every transaction↔expense link with its current paid state — read straight
// from the local database, so it needs no Splitwise round-trip.
app.get('/splitwise/links', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { links: repo.listSplitwiseLinks() };
});

// Re-pulls balances from Splitwise and recomputes every link's paid state.
app.post('/splitwise/refresh', async (_req, reply) => {
  if (!repo || !vault) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault.unlocked) return reply.code(409).send({ error: 'the credential vault is locked' });
  const acct = loadSplitwiseAccount();
  if (!acct) return reply.code(400).send({ error: 'Splitwise is not connected' });
  try {
    return await refreshSplitwise(acct.apiKey, acct.userId, repo);
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/splitwise/expense', async (req, reply) => {
  if (!repo || !vault) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault.unlocked) return reply.code(409).send({ error: 'the credential vault is locked' });
  const acct = loadSplitwiseAccount();
  if (!acct) return reply.code(400).send({ error: 'Splitwise is not connected' });

  const body = (req.body ?? {}) as {
    transactionId?: string;
    groupId?: number | null;
    shares?: { userId?: number; name?: string; owed?: number }[];
  };
  const txn = body.transactionId ? repo.getTransaction(body.transactionId) : undefined;
  if (!txn) return reply.code(404).send({ error: 'transaction not found' });
  if (repo.getSplitwiseLink(txn.id)) {
    return reply.code(409).send({ error: 'this transaction is already on Splitwise' });
  }
  const cost = Math.abs(txn.amount);
  if (!(cost > 0)) {
    return reply.code(400).send({ error: 'this transaction has no amount to split' });
  }

  // Everyone on the split except the user; planSplit makes the user owe the rest.
  const others = (body.shares ?? [])
    .filter((s) => typeof s.userId === 'number' && s.userId !== acct.userId)
    .map((s) => ({
      id: s.userId as number,
      name: (s.name ?? '').trim() || `User ${s.userId}`,
      owed: Number(s.owed) || 0,
    }));
  if (others.length === 0) {
    return reply.code(400).send({ error: 'pick at least one person to split with' });
  }

  const groupId = typeof body.groupId === 'number' && body.groupId > 0 ? body.groupId : 0;
  try {
    const plan = planSplit(cost, acct.userId, others);
    const expenseId = await createExpense(acct.apiKey, {
      cost,
      description: txn.description,
      date: txn.date,
      currencyCode: txn.currency,
      groupId,
      users: plan.users,
    });
    const link = repo.createSplitwiseLink({
      transactionId: txn.id,
      expenseId,
      groupId: groupId > 0 ? String(groupId) : null,
      currency: txn.currency,
      owedToMe: plan.owedToMe,
      counterparties: plan.counterparties,
    });
    return { link };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Deletes a transaction's linked expense from Splitwise too — so it disappears
// for everyone it was shared with — then drops the local link. The local link
// is kept when the Splitwise delete fails, so the user can retry.
app.delete('/splitwise/expense/:transactionId', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { transactionId } = req.params as { transactionId: string };
  const link = repo.getSplitwiseLink(transactionId);
  const acct = loadSplitwiseAccount();
  if (link && acct) {
    try {
      await deleteExpense(acct.apiKey, link.expenseId);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  }
  repo.deleteSplitwiseLink(transactionId);
  return { ok: true };
});

// --- Manual assets ----------------------------------------------------------
// Cars, property, cash — assets the user values by hand. They carry no
// credentials and need no vault, so any token-bearing request may manage them.

const ASSET_KINDS = new Set(['car', 'property', 'cash', 'pension', 'crypto', 'other']);

app.get('/assets', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { assets: repo.listManualAssets() };
});

app.post('/assets', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as {
    kind?: string;
    name?: string;
    value?: number;
    currency?: string;
    details?: Record<string, unknown> | null;
  };
  if (!body.kind || !ASSET_KINDS.has(body.kind)) {
    return reply.code(400).send({ error: 'unknown asset kind' });
  }
  const name = (body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'a name is required' });
  const value = Number(body.value);
  if (!Number.isFinite(value)) {
    return reply.code(400).send({ error: 'a numeric value is required' });
  }
  const currency = (body.currency ?? 'ILS').toUpperCase();
  const details = body.details && typeof body.details === 'object' ? body.details : null;
  const asset = repo.createManualAsset({ kind: body.kind, name, value, currency, details });
  return { asset };
});

app.put('/assets/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  if (!repo.getManualAsset(id)) return reply.code(404).send({ error: 'asset not found' });
  const body = (req.body ?? {}) as {
    name?: string;
    value?: number;
    details?: Record<string, unknown> | null;
  };
  const fields: { name?: string; value?: number; details?: Record<string, unknown> | null } = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return reply.code(400).send({ error: 'a name is required' });
    fields.name = name;
  }
  if (body.value !== undefined) {
    const value = Number(body.value);
    if (!Number.isFinite(value)) {
      return reply.code(400).send({ error: 'a numeric value is required' });
    }
    fields.value = value;
  }
  if (body.details !== undefined) {
    fields.details = body.details && typeof body.details === 'object' ? body.details : null;
  }
  repo.updateManualAsset(id, fields);
  return { asset: repo.getManualAsset(id) };
});

app.delete('/assets/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  repo.deleteManualAsset(id);
  return { ok: true };
});

// Resolves an Israeli licence plate to the car's make/model/year via the
// government open-data portal. Registration specs only — no Israeli API
// returns a market valuation, so the app estimates value itself.
app.get('/vehicle/:plate', async (req, reply) => {
  const { plate } = req.params as { plate: string };
  try {
    const vehicle = await lookupVehicle(plate);
    return vehicle ? { found: true, vehicle } : { found: false };
  } catch {
    return reply.code(502).send({ error: 'vehicle lookup failed' });
  }
});

app.get('/llm', async () => llm.getStatus());

app.post('/llm/download', async (req, reply) => {
  const body = (req.body ?? {}) as { modelId?: string };
  if (!body.modelId) {
    return reply.code(400).send({ error: 'modelId is required' });
  }
  try {
    llm.startDownload(body.modelId);
    return { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/llm/cancel', async () => {
  llm.cancelDownload();
  return { ok: true };
});

// Switches between the on-device model and a remote Ollama server. The API key
// is stored server-side and never echoed back; an absent key keeps the saved
// one, so the browser need not round-trip the secret.
app.post('/llm/provider', async (req) => {
  const body = (req.body ?? {}) as {
    mode?: string;
    ollamaUrl?: string;
    ollamaKey?: string;
    ollamaModel?: string;
  };
  // Only forward fields the request actually carried — an omitted field keeps
  // its stored value, so switching to the local model never wipes the Ollama
  // details (and vice versa).
  const ollama: Record<string, string> = {};
  if (body.ollamaUrl !== undefined) ollama.baseUrl = body.ollamaUrl;
  if (body.ollamaKey !== undefined) ollama.apiKey = body.ollamaKey;
  if (body.ollamaModel !== undefined) ollama.model = body.ollamaModel;
  llm.setProvider({
    mode: body.mode === 'ollama' ? 'ollama' : 'local',
    ollama,
  });
  return llm.getStatus();
});

// Probes an Ollama server (without committing it) so the UI can confirm the
// URL and key work before the user saves them.
app.post('/llm/ollama/test', async (req) => {
  const body = (req.body ?? {}) as { ollamaUrl?: string; ollamaKey?: string };
  return llm.testOllama({
    baseUrl: body.ollamaUrl ?? '',
    ...(body.ollamaKey !== undefined ? { apiKey: body.ollamaKey } : {}),
  });
});

app.post('/categorize', async (_req, reply) => {
  if (!categorizer) return reply.code(503).send({ error: 'database unavailable' });
  categorizer.start();
  return { ok: true };
});

app.get('/categorize', async (_req, reply) => {
  if (!categorizer) return reply.code(503).send({ error: 'database unavailable' });
  return categorizer.getStatus();
});

app.get('/budget', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  // The web app scopes the budget to the user's billing cycle by passing its
  // ISO bounds; fall back to the calendar month when they are absent. It also
  // passes its recurring projection (expected income, smoothed fixed bills) so
  // piggy banks are settled against expected — not just actual — income.
  const q = (req.query ?? {}) as {
    start?: string;
    end?: string;
    expectedIncome?: string;
    expectedFixed?: string;
  };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const range =
    q.start && q.end && iso.test(q.start) && iso.test(q.end)
      ? { start: q.start, end: q.end, label: q.start.slice(0, 7) }
      : undefined;
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) ? n : undefined;
  };
  const expectedIncome = num(q.expectedIncome);
  const expectedFixed = num(q.expectedFixed);
  const projection =
    expectedIncome !== undefined || expectedFixed !== undefined
      ? { expectedIncome, expectedFixed }
      : undefined;
  const report = buildBudgetReport(repo, range, projection);
  // `/budget` is the one caller that commits the piggy ledger — so a report
  // built elsewhere (insights) cannot overwrite it with stale figures.
  persistPiggyMonth(repo, report.piggy);
  return report;
});

app.put('/budgets', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as { category?: string; monthlyAmount?: number };
  if (!body.category) {
    return reply.code(400).send({ error: 'category is required' });
  }
  const amount = Number(body.monthlyAmount);
  if (Number.isFinite(amount) && amount > 0) {
    repo.setBudget(body.category, amount);
  } else {
    repo.deleteBudget(body.category);
  }
  return { ok: true };
});

// Piggy banks — savings goals. The settled this-month status rides along in
// the budget report's `piggy` block; these routes are CRUD only.
app.post('/piggy', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as {
    name?: string;
    emoji?: string;
    targetAmount?: number;
    monthlyAmount?: number;
  };
  const name = (body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'a name is required' });
  const targetAmount = Number(body.targetAmount);
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    return reply.code(400).send({ error: 'a positive target amount is required' });
  }
  const monthlyAmount = Number(body.monthlyAmount);
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) {
    return reply.code(400).send({ error: 'a positive monthly amount is required' });
  }
  const emoji = (body.emoji ?? '').trim() || '🐷';
  const piggy = repo.createPiggyBank({
    name,
    emoji,
    targetAmount,
    monthlyAmount,
    currency: 'ILS',
  });
  return { piggy };
});

app.put('/piggy/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  if (!repo.getPiggyBank(id)) return reply.code(404).send({ error: 'piggy bank not found' });
  const body = (req.body ?? {}) as {
    name?: string;
    emoji?: string;
    targetAmount?: number;
    monthlyAmount?: number;
    onHold?: boolean;
  };
  const fields: Partial<{
    name: string;
    emoji: string;
    targetAmount: number;
    monthlyAmount: number;
    onHold: boolean;
  }> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return reply.code(400).send({ error: 'a name is required' });
    fields.name = name;
  }
  if (body.emoji !== undefined) fields.emoji = body.emoji.trim() || '🐷';
  if (body.targetAmount !== undefined) {
    const v = Number(body.targetAmount);
    if (!Number.isFinite(v) || v <= 0) {
      return reply.code(400).send({ error: 'a positive target amount is required' });
    }
    fields.targetAmount = v;
  }
  if (body.monthlyAmount !== undefined) {
    const v = Number(body.monthlyAmount);
    if (!Number.isFinite(v) || v <= 0) {
      return reply.code(400).send({ error: 'a positive monthly amount is required' });
    }
    fields.monthlyAmount = v;
  }
  if (body.onHold !== undefined) fields.onHold = !!body.onHold;
  repo.updatePiggyBank(id, fields);
  return { piggy: repo.getPiggyBank(id) };
});

app.delete('/piggy/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  repo.deletePiggyBank(id);
  return { ok: true };
});

app.post('/insights', async (_req, reply) => {
  if (!insights) return reply.code(503).send({ error: 'database unavailable' });
  insights.start();
  return { ok: true };
});

app.get('/insights', async (_req, reply) => {
  if (!insights) return reply.code(503).send({ error: 'database unavailable' });
  return insights.getStatus();
});

// Given the user's active and lapsed subscription names, returns which lapsed
// ones are the same service as an active one (a renamed billing descriptor).
app.post('/subscriptions/aliases', async (req, reply) => {
  const body = (req.body ?? {}) as { active?: unknown; dead?: unknown };
  const asNames = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  try {
    return await subscriptionMatcher.match(asNames(body.active), asNames(body.dead));
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

async function main(): Promise<void> {
  // Binding beyond loopback with no token would expose an unauthenticated API
  // to the whole network — refuse rather than do that silently.
  if (!isLoopbackHost && !token) {
    const msg =
      `Refusing to start: HON_HOST is ${host} (not loopback) but HON_TOKEN is ` +
      'empty. That would expose the API without authentication. Set HON_TOKEN ' +
      'to a long random secret first.';
    emit({ event: 'error', message: msg });
    log(msg);
    process.exit(1);
  }
  try {
    await app.listen({ host, port });
    const addr = app.server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    emit({ event: 'ready', port: actualPort, pid: process.pid, version: VERSION });
    log(`listening on ${host}:${actualPort}`);
  } catch (err) {
    emit({ event: 'error', message: (err as Error).message });
    process.exit(1);
  }
}

// --- Lifecycle --------------------------------------------------------------
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  app.close().finally(() => {
    dbHandle?.db.close();
    process.exit(0);
  });
}

// When launched by the Hon app, exit as soon as the app does: the app holds
// our stdin pipe open, so EOF on stdin means the parent is gone.
if (process.env.HON_PARENT_PIPE === '1') {
  process.stdin.on('end', () => shutdown('parent-exited'));
  process.stdin.on('close', () => shutdown('parent-exited'));
  process.stdin.resume();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
