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
import { getLogo } from './logos.js';
import { Vault } from './vault.js';
import { LlmManager } from './llm.js';
import { Categorizer, CATEGORIES } from './categorize.js';
import { buildBudgetReport } from './budget.js';
import { buildAnalytics } from './analytics.js';
import { InsightsGenerator } from './insights.js';
import { totalInILS } from './fx.js';

const START = Date.now();
const VERSION = '0.2.0';

// --- Configuration (passed in by the Hon app, with dev-friendly fallbacks) ---
const token = process.env.HON_TOKEN ?? '';
const dataDir =
  process.env.HON_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Hon');
const port = Number(process.env.HON_PORT ?? 0); // 0 => OS picks a free port

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
try {
  dbHandle = openDatabase(dataDir);
  repo = new Repo(dbHandle.db);
  runner = new ScrapeRunner(repo, dataDir);
  dbStatus = `ok (schema v${dbHandle.schemaVersion})`;
  log(`database ready at ${dbHandle.path}`);
} catch (err) {
  dbStatus = `error: ${(err as Error).message}`;
  log(`database error: ${(err as Error).message}`);
}

// Password-protected credential store for the web app (no macOS Keychain).
const vault: Vault | null = repo ? new Vault(repo) : null;

// On-device LLM (model download + load). Independent of the database.
const llm = new LlmManager(dataDir);

// Transaction categorization (rules + LLM). Needs the database.
const categorizer: Categorizer | null = repo ? new Categorizer(repo, llm) : null;

// Budget insights (LLM free-text). Needs the database.
const insights: InsightsGenerator | null = repo ? new InsightsGenerator(repo, llm) : null;

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
app.get('/logo/:companyId', async (req, reply) => {
  const { companyId } = req.params as { companyId: string };
  const company = companyCatalog().find((c) => c.id === companyId);
  if (!company?.domain) return reply.code(404).send({ error: 'no logo' });
  const logo = await getLogo(dataDir, companyId, company.domain);
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
  const monthsBack =
    typeof body.monthsBack === 'number' && Number.isFinite(body.monthsBack)
      ? Math.max(1, Math.min(12, Math.round(body.monthsBack)))
      : 3;

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

  try {
    const portal = await createPortalLink(
      credentials, dataDir, body.broker, body.customRedirect);
    // Persist the SnapTrade user identifiers so future syncs can use them.
    if (body.connectionId && vault?.unlocked) {
      vault.saveCredentials(body.connectionId, {
        ...credentials,
        userId: portal.userId,
        userSecret: portal.userSecret,
      });
    }
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
  return { summary: { ...summary, netWorthILS } };
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

app.post('/categorize', async (_req, reply) => {
  if (!categorizer) return reply.code(503).send({ error: 'database unavailable' });
  categorizer.start();
  return { ok: true };
});

app.get('/categorize', async (_req, reply) => {
  if (!categorizer) return reply.code(503).send({ error: 'database unavailable' });
  return categorizer.getStatus();
});

app.get('/budget', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return buildBudgetReport(repo);
});

app.get('/analytics', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return buildAnalytics(repo);
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

app.post('/insights', async (_req, reply) => {
  if (!insights) return reply.code(503).send({ error: 'database unavailable' });
  insights.start();
  return { ok: true };
});

app.get('/insights', async (_req, reply) => {
  if (!insights) return reply.code(503).send({ error: 'database unavailable' });
  return insights.getStatus();
});

async function main(): Promise<void> {
  try {
    await app.listen({ host: '127.0.0.1', port });
    const addr = app.server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    emit({ event: 'ready', port: actualPort, pid: process.pid, version: VERSION });
    log(`listening on 127.0.0.1:${actualPort}`);
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
