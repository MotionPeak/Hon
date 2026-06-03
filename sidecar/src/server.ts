import Fastify, { type FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import {
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { idParamSchema, isoDateSchema } from '@hon/shared/common';
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  categoryNameParamSchema,
} from '@hon/shared/category';
import {
  loanCreateSchema,
  loanUpdateSchema,
  excludedToggleSchema,
  rateTypeSchema,
} from '@hon/shared/loan';
import { assetCreateSchema, assetUpdateSchema } from '@hon/shared/asset';
import { piggyCreateSchema, piggyUpdateSchema } from '@hon/shared/piggy';
import { voucherCreateSchema, voucherUpdateSchema } from '@hon/shared/voucher';
import {
  budgetSetSchema,
  monthlySavingsSchema,
  incomeOverrideSchema,
} from '@hon/shared/budget';
import {
  txnCategorySchema,
  txnLoanSchema,
  txnExcludedSchema,
  txnSavingsSchema,
  txnLinkSchema,
} from '@hon/shared/transaction';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { rewriteApiPrefix } from './httpRewrite.js';
import { openDatabase, type DbHandle } from './db.js';
import { Repo } from './repo.js';
import { ScrapeRunner } from './runner.js';
import {
  scrapeShufersalGiftCards,
  scrapeBuyMeGiftCards,
  scrapeHitechZoneBalance,
} from './voucherScrapers.js';
import { companyCatalog, isSupportedCompany } from './scrapers.js';
import {
  createPortalLink,
  listBrokerages,
  describeSnapError,
  countConnections,
  getStoredUser,
  makeClient,
} from './snaptrade.js';
import { migrateLegacySnapTradeUsers } from './snaptradeUser.js';
import {
  createDoneRegistry,
  type DoneRegistry,
} from './snaptradeDoneRegistry.js';

// Cleared 10 minutes after a /snaptrade/done callback fires — long
// enough to outlast any reasonable post-portal poll, short enough that
// stale flags can't survive a forgotten tab.
const SNAPTRADE_DONE_TTL_MS = 10 * 60_000;
const snaptradeDoneRegistry: DoneRegistry = createDoneRegistry({
  ttlMs: SNAPTRADE_DONE_TTL_MS,
});
import {
  verifyKey,
  fetchPickList,
  planSplit,
  createExpense,
  deleteExpense,
  refreshSplitwise,
  recomputePaidStates,
} from './splitwise.js';
import { getLogo, isSafeCompanyId, isPublicLogoDomain } from './logos.js';
import { Vault } from './vault.js';
import { LlmManager } from './llm.js';
import { Categorizer, CATEGORIES } from './categorize.js';
import { buildBudgetReport } from './budget.js';
import { persistPiggyMonth } from './piggy.js';
import { InsightsGenerator } from './insights.js';
import { SubscriptionMatcher } from './subscriptions.js';
import { totalInILS, getIlsRates } from './fx.js';
import { lookupVehicle } from './vehicle.js';
import {
  composeRateType,
  computeLoanState,
  currentYyyyMm,
  decomposeRateType,
  fetchCpiForMonth,
  fetchCurrentPrime,
} from './loans.js';

const START = Date.now();
const VERSION = '0.3.0';

// --- Configuration (from the environment, with dev-friendly fallbacks) ---
const token = process.env.HON_TOKEN ?? '';
// Default data directory per OS convention:
//   • macOS   — ~/Library/Application Support/Hon
//   • Windows — %APPDATA%\Hon  (typically C:\Users\<name>\AppData\Roaming\Hon)
//   • Linux   — $XDG_DATA_HOME/Hon, falling back to ~/.local/share/Hon
// The Hon macOS app always passes HON_DATA_DIR; this default is for the dev
// launcher (web.sh) and Linux/Windows deployments.
function defaultDataDir(): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Hon');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Hon');
  }
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'Hon');
}
const dataDir = process.env.HON_DATA_DIR ?? defaultDataDir();
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
// Password-protected credential store for connection credentials.
let vault: Vault | null = null;
try {
  dbHandle = openDatabase(dataDir);
  repo = new Repo(dbHandle.db);
  const interrupted = repo.reconcileInterruptedRuns();
  if (interrupted > 0) log(`reconciled ${interrupted} interrupted run(s) from a previous session`);
  vault = new Vault(repo);
  runner = new ScrapeRunner(repo, dataDir, vault);
  dbStatus = `ok (schema v${dbHandle.schemaVersion})`;
  log(`database ready at ${dbHandle.path}`);
} catch (err) {
  dbStatus = `error: ${(err as Error).message}`;
  log(`database error: ${(err as Error).message}`);
}

// On-device LLM (model download + load). Independent of the database.
// Pass the vault so provider API keys persist encrypted (H-2), not plaintext.
const llm = new LlmManager(dataDir, vault ?? undefined);

// Transaction categorization (rules + LLM). Needs the database.
const categorizer: Categorizer | null = repo ? new Categorizer(repo, llm) : null;

// Budget insights (LLM free-text). Needs the database.
const insights: InsightsGenerator | null = repo ? new InsightsGenerator(repo, llm) : null;

// Detects renamed subscriptions (LLM). Works off names sent by the web app.
const subscriptionMatcher = new SubscriptionMatcher(llm);

// The built React app's entry HTML, read once at startup. web/dist is produced
// by `cd web && npm run build` (the launcher builds it when missing/stale).
const webAppHtml = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', '..', 'web', 'dist', 'index.html'), 'utf8');
  } catch {
    return '<!doctype html><meta charset="utf-8"><title>Hon</title>'
      + '<p style="font-family:system-ui;max-width:30rem;margin:4rem auto">'
      + 'Hon web app not built. Run <code>cd web &amp;&amp; npm run build</code>, '
      + 'then reload.</p>';
  }
})();

// --- HTTP server ------------------------------------------------------------
const app = Fastify({
  logger: false,
  // The React client calls /api/<route>; strip the prefix so it reaches the
  // engine's /<route> handlers (prod equivalent of vite's dev proxy). Runs
  // before routing AND before the onRequest auth hook, so a rewritten
  // /api/loans → /loans is token-gated exactly as before.
  rewriteUrl: (req) => rewriteApiPrefix(req.url ?? '/'),
}).withTypeProvider<ZodTypeProvider>();

// Zod request validation. A route that declares `schema: { body, params,
// querystring }` with zod schemas gets those parsed+typed before the handler
// runs; a parse failure is turned into the engine's standard `{ error }` JSON
// by the error handler below (see setErrorHandler). Routes WITHOUT a schema are
// unaffected — this is incremental. Response serialization is left untouched
// (no response schemas) so existing payload shapes pass through verbatim.
app.setValidatorCompiler(validatorCompiler);

/** Type of the app once the zod provider is attached — handlers read
 *  `request.body`/`params`/`query` as the inferred zod types. */
type App = typeof app;

// GET-only URL prefixes exempt from the bearer token, alongside the exact
// path `/` (the web app shell). All three carry no private data:
//  - `/`               the SPA page itself; its scripts then authenticate
//                      every API call with the token passed in the page URL.
//  - `/logo/`          institution logos, loaded by <img> tags that cannot
//                      send an Authorization header. NOTE: the H-1 review
//                      asked to additionally token-gate /logo/ via a ?t=
//                      query param. That is DEFERRED: the legacy SPA builds
//                      bare /logo/... <img> URLs in several places (bank
//                      picker, brokerage tiles, voucher tiles) with no token
//                      plumbing, so threading ?t= through all of them is broad
//                      and risky. The path-traversal + SSRF holes — the bulk
//                      of H-1 — are already closed by isSafeCompanyId() and the
//                      strict ?domain= hostname check in the /logo route. The
//                      route serves only public favicons (no private data), so
//                      leaving it token-exempt is low risk in the interim.
//  - `/snaptrade/done` the post-connection landing page SnapTrade opens in
//                      a browser, which carries no token.
// Slash-terminated subtrees — startsWith is safe (only their own paths match).
const PUBLIC_ROUTE_PREFIXES = ['/logo/', '/assets/', '/workbox-'];
// Exact paths — matched against the path only, so a sibling like
// /snaptrade/donezo or a future /snaptrade/done-export can't inherit exemption.
// PWA root-level files emitted by vite-plugin-pwa to web/dist root (NOT
// /assets). Public — the browser fetches these before it has a token. The
// matching GET routes are registered below the SPA shell route.
const PWA_ROOT_FILES = [
  'manifest.webmanifest', 'sw.js', 'sw.js.map', 'registerSW.js',
  'icon.svg', 'favicon.ico',
  'pwa-64x64.png', 'pwa-192x192.png', 'pwa-512x512.png',
  'maskable-icon-512x512.png', 'apple-touch-icon-180x180.png',
];
const PUBLIC_ROUTE_EXACT = ['/snaptrade/done', ...PWA_ROOT_FILES.map((f) => `/${f}`)];

/** True for the small set of GET routes that are exempt from the token. */
function isPublicRoute(method: string, url: string): boolean {
  if (method !== 'GET') return false;
  if (url === '/') return true;
  const path = url.split('?')[0];
  if (PUBLIC_ROUTE_EXACT.includes(path)) return true;
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// Constant-time compare of the presented Authorization header against the
// expected `Bearer <token>`. A plain `!==` leaks, via its early-exit timing,
// how many leading bytes matched — enough to recover a secret byte-by-byte over
// many requests. timingSafeEqual avoids that, but it THROWS on length
// mismatch, so we guard equal length first (and bail out for a missing/array
// header). The length check itself is not secret — the token length is fixed.
function tokenMatches(authHeader: string | string[] | undefined): boolean {
  if (typeof authHeader !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const presented = Buffer.from(authHeader);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

// Every request must carry the bearer token the app generated this launch,
// except for the public routes enumerated above.
app.addHook('onRequest', async (req, reply) => {
  if (isPublicRoute(req.method, req.url)) return;
  if (token && !tokenMatches(req.headers.authorization)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

// Translate a zod validation failure into the engine's standard
// `{ error: string }` 400 shape (the same shape the hand-rolled
// `reply.code(400).send({ error })` guards produced), so the React client's
// `ApiError` handling is unchanged. Non-validation errors fall through to
// Fastify's default handling.
app.setErrorHandler((err: FastifyError, _req, reply) => {
  if (hasZodFastifySchemaValidationErrors(err)) {
    const first = err.validation[0];
    const where = err.validationContext ? `${err.validationContext}: ` : '';
    const detail = first?.message ?? 'invalid request';
    return reply.code(400).send({ error: `${where}${detail}` });
  }
  // Preserve any explicit statusCode an upstream threw; default 500.
  const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
  return reply.code(status).send({ error: err.message || 'internal error' });
});

// Serve the React build's hashed assets. Tight scoping (root = web/dist/assets,
// prefix = /assets/) means a request for /assets/<hash>.js maps straight into
// the build dir and can never shadow `/` or any API route. No await — plugins
// registered at top level are picked up at app.listen().
const webAssetsDir = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist', 'assets',
);
app.register(fastifyStatic, {
  root: webAssetsDir,
  prefix: '/assets/',
  cacheControl: true,
  maxAge: '7d',
});

app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(webAppHtml));

// Serve the PWA root files (manifest, service worker, icons) that
// vite-plugin-pwa emits to web/dist ROOT (not /assets). reply.sendFile, decorated
// by the /assets static plugin above, takes a root override. These paths are in
// the public allowlist (PWA_ROOT_FILES) so the browser can fetch them pre-token.
const webDistRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
for (const pwaFile of PWA_ROOT_FILES) {
  app.get(`/${pwaFile}`, (_req, reply) => reply.sendFile(pwaFile, webDistRoot));
}
// Workbox runtime has a content-hashed filename (covered by the public
// '/workbox-' prefix above).
app.get('/workbox-:hash.js', (req, reply) =>
  reply.sendFile(`workbox-${(req.params as { hash: string }).hash}.js`, webDistRoot));

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
    // Move any legacy plaintext LLM provider API keys into the vault and strip
    // them from llm-provider.json (H-2). No-op when there's nothing to migrate.
    llm.migrateProviderKeysToVault();
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
  // companyId is interpolated into a cache filename inside getLogo, so reject
  // anything that could traverse out of the logos directory (H-1). Fail with
  // 400 here so a bad id is an explicit client error, not a silent 404.
  if (!isSafeCompanyId(companyId)) {
    return reply.code(400).send({ error: 'bad companyId' });
  }
  const q = req.query as { domain?: string };
  // `?domain=` is required for SnapTrade brokerages and voucher providers,
  // which are not in the scraper catalog. It is the host Hon will fetch a
  // favicon from, so it is the SSRF-sensitive input: constrain it to a strict
  // hostname shape (labels of [a-z0-9-] joined by dots, no scheme, no path, no
  // port, no userinfo, no `..`). The catalog domain is trusted and used as the
  // fallback when no override is supplied.
  let domain = q.domain;
  if (domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
    return reply.code(400).send({ error: 'bad domain' });
  }
  // SSRF guard (string layer): a supplied ?domain= must be a public brand
  // hostname — never a raw IP / loopback / link-local / *.local / *.internal
  // (H-1). This name check alone can't stop DNS rebinding (a public name whose
  // A record points inward) or a redirect to an internal host, so getLogo →
  // resolveFromWeb resolves every host and re-validates every redirect hop
  // against private/loopback/link-local addresses before fetching (M7/M8, see
  // assertPublicHost/safeFetch in logos.ts). With HON_HOST=0.0.0.0 (LAN mode)
  // /logo is token-exempt, so that resolved-IP check is the real backstop.
  if (domain && !isPublicLogoDomain(domain)) {
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

  // Credentials, when supplied, are stored in the vault. A connection may also
  // be created without them and have them added later.
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
  // The saved browser session is a vault secret, so it is not cleared by the
  // connections-table cascade — drop it explicitly.
  vault?.clearSecret(`session:${id}`);
  return { ok: true };
});

// Stores (or replaces) the vault credentials for an existing connection.
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
    monthsBack?: number;
    interactive?: boolean;
  };
  // Credentials are always loaded from the vault.
  if (!vault?.unlocked) {
    return reply.code(409).send({ error: 'the credential vault is locked' });
  }
  const credentials = vault.loadCredentials(id);
  if (!credentials) {
    return reply.code(400).send({ error: 'no stored credentials for this connection' });
  }
  // Each scraper returns whatever history it actually holds, so asking for a
  // long window simply means "as far back as the institution allows".
  // Per-connection default (historyMonths); body override clamped to [1, 24].
  const monthsBack =
    typeof body.monthsBack === 'number' && Number.isFinite(body.monthsBack)
      ? Math.max(1, Math.min(24, Math.round(body.monthsBack)))
      : connection.historyMonths;

  // Reject a second sync for a connection that already has one in flight —
  // two concurrent scrapes would fight over the same browser/session and
  // double-write transactions (H-7).
  if (runner.isActive(connection.id)) {
    return reply.code(409).send({ error: 'a sync is already running for this connection' });
  }

  const runId = runner.start({
    connectionId: connection.id,
    companyId: connection.companyId,
    credentials,
    monthsBack,
    interactive: body.interactive === true,
  });
  return { runId };
});

app.patch(
  '/connections/:id/history-months',
  {
    schema: {
      params: idParamSchema,
      body: z.object({ historyMonths: z.number().int().min(1).max(24) }),
    },
  },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;

    // 404 first so callers can distinguish "bad id" from "bad value".
    if (!repo.getConnection(id)) {
      return reply.code(404).send({ error: 'connection not found' });
    }

    const connection = repo.setConnectionHistoryMonths(id, req.body.historyMonths);
    return { connection };
  },
);

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
// URL the web app opens so the user can link a brokerage. The developer
// credentials are loaded from the vault for the given connection.
app.post('/snaptrade/portal', async (req, reply) => {
  const body = (req.body ?? {}) as {
    connectionId?: string;
    broker?: string;
    customRedirect?: string;
  };

  if (!body.connectionId) {
    return reply.code(400).send({ error: 'connectionId is required' });
  }
  if (!vault?.unlocked) {
    return reply.code(409).send({ error: 'the credential vault is locked' });
  }
  const credentials = vault.loadCredentials(body.connectionId);
  if (!credentials || typeof credentials !== 'object') {
    return reply.code(400).send({ error: 'credentials are required' });
  }
  // customRedirect is echoed into the third-party portal URL — constrain it to
  // the engine's own loopback origin so a malformed/foreign value can't break
  // the done-callback contract or redirect the browser somewhere unexpected.
  if (body.customRedirect !== undefined) {
    let valid = false;
    try {
      const u = new URL(body.customRedirect);
      valid = (u.protocol === 'http:' || u.protocol === 'https:')
        && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    } catch { valid = false; }
    if (!valid) {
      return reply.code(400).send({ error: 'invalid customRedirect' });
    }
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
    connectionId?: string;
  };

  if (!body.connectionId) {
    return reply.code(400).send({ error: 'connectionId is required' });
  }
  if (!vault?.unlocked) {
    return reply.code(409).send({ error: 'the credential vault is locked' });
  }
  const credentials = vault.loadCredentials(body.connectionId);
  if (!credentials || typeof credentials !== 'object') {
    return reply.code(400).send({ error: 'credentials are required' });
  }

  try {
    return { brokerages: await listBrokerages(credentials) };
  } catch (err) {
    return reply.code(400).send({ error: describeSnapError(err) });
  }
});

// Landing page SnapTrade's portal redirects to once a brokerage is connected.
// The client embeds `?honConn=<connectionId>` into the customRedirect so we
// can record the completion against the Hon connection — the polling caller
// reads this flag and finishes the flow even when SnapTrade just refreshed
// an existing connection (count == baseline).
app.get('/snaptrade/done', async (req, reply) => {
  const q = req.query as { honConn?: string; status?: string } | undefined;
  // Only flip the done flag for a connection that actually exists — this route
  // is token-exempt, so a bare honConn string shouldn't let any loopback caller
  // mark an arbitrary id done.
  if (q?.honConn && typeof q.honConn === 'string' && repo?.getConnection(q.honConn)) {
    snaptradeDoneRegistry.markDone(q.honConn);
  }
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
  <h1>Brokerage linked</h1>
  <p>You can close this tab — Hon is pulling your accounts now.</p>
</div></body></html>`);
});

// Read-only check of how many brokerages the SnapTrade user currently has
// linked. Used by the Link-a-brokerage flow to poll for completion without
// the side effect of minting a new portal URL (which loginSnapTradeUser
// does on every call). Safe to poll every few seconds.
app.get('/snaptrade/connections/:connectionId/count', async (req, reply) => {
  const { connectionId } = req.params as { connectionId: string };
  if (!vault?.unlocked) {
    return reply.code(409).send({ error: 'the credential vault is locked' });
  }
  const credentials = vault.loadCredentials(connectionId);
  if (!credentials || typeof credentials !== 'object') {
    return reply.code(400).send({ error: 'credentials are required' });
  }
  const done = snaptradeDoneRegistry.get(connectionId) !== null;
  try {
    const snaptrade = makeClient(credentials);
    const stored = getStoredUser(credentials, vault);
    if (!stored) {
      // No persisted SnapTrade user yet — the user hasn't opened the
      // portal even once. Count is trivially 0; polling caller sees no
      // increase and waits until baseline is set by a /snaptrade/portal
      // call.
      return { count: 0, done };
    }
    const count = await countConnections(snaptrade, stored.userId, stored.userSecret);
    return { count, done };
  } catch (err) {
    return reply.code(400).send({ error: describeSnapError(err) });
  }
});

app.get('/accounts', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { accounts: repo.listAccounts() };
});

// Brokerage positions and the recorded value history. The web app computes
// the brokerage stats (totals, gain, trends) from these, the same way it
// computes spending analytics client-side.
app.get('/brokerage', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  // FX rates (ILS per unit of X) ride along so the web app can show ILS
  // equivalents for USD/EUR holdings without hard-coding rates; null when
  // the Frankfurter fetch fails — the UI falls back to native amounts.
  const ilsRates = await getIlsRates();
  const performanceDisabled: Record<string, string> = {};
  for (const c of repo.listConnections()) {
    const at = repo.getPerformanceDisabledAt(c.id);
    if (at) performanceDisabled[c.id] = at;
  }
  return {
    holdings: repo.listHoldings(),
    snapshots: repo.listValueSnapshots(),
    holdingSnapshots: repo.listHoldingSnapshots(),
    performance: repo.listBrokeragePerformance(),
    performanceDisabled,
    ilsRates,
  };
});

// Sets an account balance by hand. Credit-card scrapers do not report a
// balance, and a manual figure also lets the user correct a stale one.
app.patch(
  '/accounts/:id/balance',
  { schema: { params: idParamSchema, body: z.object({ balance: z.number().finite() }) } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    const { balance } = req.body;
    if (!repo.listAccounts().some((a) => a.id === id)) {
      return reply.code(404).send({ error: 'account not found' });
    }
    repo.setAccountBalance(id, balance);
    return { ok: true };
  },
);

// Sets (or clears, when body.inceptionDate is null) the user-defined
// "when I actually started investing here" date for a brokerage account.
// The Insights brokerage chart uses this to clip the synthetic Yahoo/Maya
// backfill — so ALL means "since I started", not the 10 years of pretend
// history Yahoo's chart API otherwise paints.
app.patch(
  '/accounts/:id/inception',
  { schema: { params: idParamSchema, body: z.object({ inceptionDate: isoDateSchema.nullable() }) } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    const inceptionDate = req.body.inceptionDate;
    if (!repo.listAccounts().some((a) => a.id === id)) {
      return reply.code(404).send({ error: 'account not found' });
    }
    repo.setAccountInceptionDate(id, inceptionDate);
    return { ok: true };
  },
);

// Includes or excludes one account from the net-worth total. The account stays
// visible on its connection card either way — only the totals change.
app.patch(
  '/accounts/:id/excluded',
  { schema: { params: idParamSchema, body: excludedToggleSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    if (!repo.listAccounts().some((a) => a.id === id)) {
      return reply.code(404).send({ error: 'account not found' });
    }
    repo.setAccountExcluded(id, req.body.excluded);
    return { ok: true };
  },
);

app.get('/transactions', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const q = req.query as { accountId?: string; limit?: string };
  // No limit → full history (the month-by-month UIs window client-side and
  // need every cycle). An explicit limit still paginates.
  // Honor an explicit non-negative integer limit exactly (including 0); only
  // fall back to "no limit" when the param is absent or not a valid count.
  const limitN = Number(q.limit);
  const limit = q.limit !== undefined && Number.isInteger(limitN) && limitN >= 0
    ? limitN
    : undefined;
  return { transactions: repo.listTransactions({ accountId: q.accountId, limit }) };
});

app.get('/summary', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const summary = repo.summary();

  // Loans are debt — they subtract from net worth in the loan's own currency.
  // Computed up front so /summary needs at most one BOI + one CBS fetch per
  // call, no matter how many loans are listed.
  const loans = repo.listLoans();
  const needsPrime = loans.some((l) => !l.excluded && l.isPrime);
  const needsCpi = loans.some((l) => !l.excluded && l.isCpiLinked);
  const prime = needsPrime ? await fetchCurrentPrime(repo) : 0;
  const cpiNow = needsCpi ? await fetchCpiForMonth(repo, currentYyyyMm()) : null;
  const loanDebtByCurrency = new Map<string, number>();
  for (const loan of loans) {
    if (loan.excluded) continue;
    const state = computeLoanState(loan, prime, cpiNow);
    loanDebtByCurrency.set(
      loan.currency,
      (loanDebtByCurrency.get(loan.currency) ?? 0) + state.outstanding,
    );
  }

  // Fold loan debt into the per-currency totals before converting to ILS.
  const byCurrency = summary.byCurrency.map((r) => ({ ...r }));
  for (const [currency, debt] of loanDebtByCurrency) {
    let row = byCurrency.find((r) => r.currency === currency);
    if (!row) {
      row = { currency, total: 0, accountCount: 0 };
      byCurrency.push(row);
    }
    row.total -= debt;
  }

  // A single net-worth figure, every currency converted to ILS. Null when the
  // FX lookup fails — the app then falls back to the per-currency breakdown.
  const netWorthILS = await totalInILS(byCurrency);

  // Break the net worth down by source: bank / card / brokerage accounts and
  // each kind of manual asset, every bucket converted to ILS. Loans contribute
  // a negative `loan` bucket so the breakdown stacks to net worth.
  const typeOf = new Map(companyCatalog().map((c) => [c.id, c.type]));
  const buckets = new Map<string, Map<string, number>>();
  const addToBucket = (key: string, currency: string, amount: number): void => {
    const byCur = buckets.get(key) ?? new Map<string, number>();
    byCur.set(currency, (byCur.get(currency) ?? 0) + amount);
    buckets.set(key, byCur);
  };
  for (const acct of repo.listAccounts()) {
    if (acct.excluded) continue;
    addToBucket(typeOf.get(acct.companyId) ?? 'bank', acct.currency, acct.balance ?? 0);
  }
  for (const asset of repo.listManualAssets()) {
    if (asset.excluded) continue;
    addToBucket(`asset:${asset.kind}`, asset.currency, asset.value);
  }
  for (const [currency, debt] of loanDebtByCurrency) {
    addToBucket('loan', currency, -debt);
  }
  const sources: { key: string; amount: number }[] = [];
  for (const [key, byCur] of buckets) {
    const amount = await totalInILS(
      [...byCur].map(([currency, total]) => ({ currency, total })),
    );
    if (amount != null && Math.abs(amount) >= 0.5) sources.push({ key, amount });
  }
  sources.sort((a, b) => b.amount - a.amount);

  return { summary: { ...summary, byCurrency, netWorthILS, sources } };
});

// Moves one transaction to a different category. With `applyToMerchant`, the
// choice is saved as a rule so transactions from the same business — past and
// future — categorize the same way.
app.patch(
  '/transactions/:id/category',
  { schema: { params: idParamSchema, body: txnCategorySchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    const body = req.body;
    // Accept any category the user has — built-in or one they created in
    // Settings. Fall back to the static CATEGORIES list only if the table is
    // unexpectedly empty (e.g. a brand-new DB before its seed migration ran).
    const liveCats = repo.listCategories().map((c) => c.name);
    const allowed = liveCats.length > 0
      ? liveCats
      : (CATEGORIES as readonly string[]);
    if (!allowed.includes(body.category)) {
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
  },
);

// How often a merchant recurs. 'monthly'/'bimonthly'/'yearly' tag a recurring
// expense (for monthly-equivalent cost); 'income' tags a recurring income
// source (a salary) so the budget projection anchors on it.
// `ignore` flags a fixed-bill merchant the user does NOT want treated as
// recurring (drops it from Expected fixed and the Fixed-bills view, even
// if it has charged in two-plus cycles). Stored as a regular row so the
// flag survives across syncs and devices.
const RECURRENCE_FREQUENCIES = ['monthly', 'bimonthly', 'yearly', 'income', 'ignore'];

app.get('/merchant-frequencies', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const frequencies: Record<string, string> = {};
  for (const row of repo.listMerchantFrequencies()) {
    frequencies[row.merchantKey] = row.frequency;
  }
  return { frequencies };
});

// Per-merchant split count for shared bills (rent split with roommates,
// a utility on a joint name, etc.). split_count >= 1; setting it to 1
// (or passing splitCount: null) clears the override so the merchant
// goes back to "100% yours" everywhere in the UI.
app.get('/merchant-splits', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const splits: Record<string, number> = {};
  for (const row of repo.listMerchantSplits()) splits[row.merchantKey] = row.splitCount;
  return { splits };
});

// The wire field is `key` (the merchant key); `splitCount: null` (or <= 1)
// clears the override — that business rule stays in the handler.
app.put(
  '/merchant-split',
  { schema: { body: z.object({ key: z.string().min(1), splitCount: z.number().int().nullable() }) } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { splitCount } = req.body;
    const key = req.body.key.trim();
    if (!key) return reply.code(400).send({ error: 'a merchant key is required' });
    if (splitCount == null || splitCount === 1) {
      repo.clearMerchantSplit(key);
      return { ok: true };
    }
    if (splitCount < 1 || splitCount > 50) {
      return reply.code(400).send({
        error: 'splitCount must be a whole number between 1 and 50',
      });
    }
    repo.setMerchantSplit(key, splitCount);
    return { ok: true };
  },
);

// Per-category split count (e.g. Utilities ÷ 3 when shared with roommates).
// splitCount >= 1; setting it to 1 or null clears the override.
app.get('/category-splits', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const splits: Record<string, number> = {};
  for (const row of repo.listCategorySplits()) splits[row.category] = row.splitCount;
  return { splits };
});

// `splitCount: null` (or <= 1) clears the override — business rule kept.
app.put(
  '/category-split',
  { schema: { body: z.object({ category: z.string().min(1), splitCount: z.number().int().nullable() }) } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { splitCount } = req.body;
    const category = req.body.category.trim();
    if (!category) return reply.code(400).send({ error: 'a category is required' });
    if (splitCount == null || splitCount === 1) {
      repo.clearCategorySplit(category);
      return { ok: true };
    }
    if (splitCount < 1 || splitCount > 50) {
      return reply.code(400).send({
        error: 'splitCount must be a whole number between 1 and 50',
      });
    }
    repo.setCategorySplit(category, splitCount);
    return { ok: true };
  },
);

app.put(
  '/merchant-frequency',
  { schema: { body: z.object({ key: z.string().min(1), frequency: z.string() }) } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { frequency } = req.body;
    const key = req.body.key.trim();
    if (!key) return reply.code(400).send({ error: 'a merchant key is required' });
    // 'none' clears the tag — used to un-mark a recurring income source.
    if (frequency === 'none') {
      repo.clearMerchantFrequency(key);
      return { ok: true };
    }
    if (!RECURRENCE_FREQUENCIES.includes(frequency)) {
      return reply.code(400).send({ error: 'unknown frequency' });
    }
    repo.setMerchantFrequency(key, frequency);
    return { ok: true };
  },
);

// Links an expense to a refunding/reimbursing transaction, so the refund is
// folded into the expense and not double-counted across the app.
// txnLinkSchema validates the required refundId; `amount` is an optional
// partial-allocation override the route business-validates below (default,
// magnitude cap, unallocated-remainder cap), so it rides along via .extend.
app.put(
  '/transactions/:id/link',
  {
    schema: {
      params: idParamSchema,
      body: txnLinkSchema.extend({ amount: z.number().finite().optional() }),
    },
  },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    const body = req.body;
    if (body.refundId === id) {
      return reply.code(400).send({ error: 'a transaction cannot refund itself' });
    }
    const expense = repo.getTransaction(id);
    if (!expense) return reply.code(404).send({ error: 'expense not found' });
    const refund = repo.getTransaction(body.refundId);
    if (!refund) return reply.code(404).send({ error: 'refund transaction not found' });

    // Direction guard: `txn_effective` folds the refund INTO the expense and
    // drops the refund row, so the legs must point opposite ways — the expense
    // an outflow (amount < 0), the refund an inflow (amount > 0). The web picker
    // already enforces this (ActivityView only offers opposite-sign candidates),
    // but a direct API call could link two outflows or two inflows and corrupt
    // the net-amount view. Reject both bad orientations explicitly.
    if (expense.amount >= 0) {
      return reply.code(400).send({ error: 'the linked expense must be an outflow' });
    }
    if (refund.amount <= 0) {
      return reply.code(400).send({ error: 'the refund must be an inflow' });
    }

    // Validate amount. Omitted → allocate the full unallocated remainder
    // capped at the expense's outstanding magnitude.
    const refundMagnitude = Math.abs(refund.amount);
    const expenseMagnitude = Math.abs(expense.amount);
    const remaining = repo.refundRemaining(body.refundId)
      + (repo.getTransactionLink(id, body.refundId) ?? 0);
    const amount = typeof body.amount === 'number' ? body.amount : Math.min(remaining, expenseMagnitude);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive number' });
    }
    if (amount > refundMagnitude + 0.005) {
      return reply.code(400).send({
        error: `amount exceeds refund magnitude (${refundMagnitude})`,
      });
    }
    if (amount > remaining + 0.005) {
      return reply.code(400).send({
        error: `only ${remaining.toFixed(2)} of this refund is unallocated`,
      });
    }
    repo.setTransactionLink(id, body.refundId, amount);
    return { ok: true, amount };
  },
);

app.delete('/transactions/:id/link', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  // Optional refundId in the query string targets one allocation; omitted
  // removes every refund attached to this expense (back-compat).
  const { refundId } = req.query as { refundId?: string };
  repo.deleteTransactionLink(id, refundId);
  return { ok: true };
});

// Returns every refund→expense allocation. The web app needs this to know
// how much of each refund is still unallocated, since one refund can now
// cover parts of several expenses.
app.get('/transaction-links', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { links: repo.listTransactionLinks() };
});

// Returns the unallocated portion of a refund transaction so the picker can
// show "₪307 left to allocate" next to the amount input.
app.get('/transactions/:id/refund-remaining', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  if (!repo.getTransaction(id)) {
    return reply.code(404).send({ error: 'transaction not found' });
  }
  return { remaining: repo.refundRemaining(id) };
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
  return { links: repo.listSplitwiseLinks(), repayments: repo.listRepayments() };
});

// Re-pulls balances from Splitwise and recomputes every link's paid state.
app.post('/splitwise/refresh', async (_req, reply) => {
  if (!repo || !vault) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault.unlocked) return reply.code(409).send({ error: 'the credential vault is locked' });
  const acct = loadSplitwiseAccount();
  if (!acct) return reply.code(400).send({ error: 'Splitwise is not connected' });
  try {
    return await refreshSplitwise(acct.apiKey, repo);
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
  // A locked vault means we cannot reach Splitwise to delete the remote
  // expense. Deleting only the local link would silently orphan the bill
  // for everyone it is shared with, so refuse — keep the link, surface 409.
  if (link && !acct) {
    return reply
      .code(409)
      .send({ error: 'unlock the credential vault to delete the linked Splitwise expense' });
  }
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

// Marks an incoming transaction as a Splitwise repayment from a counterparty.
app.post('/splitwise/repayment', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as {
    transactionId?: string; counterpartyId?: number; counterpartyName?: string;
  };
  const txn = body.transactionId ? repo.getTransaction(body.transactionId) : undefined;
  if (!txn) return reply.code(404).send({ error: 'transaction not found' });
  if (!(txn.amount > 0)) {
    return reply.code(400).send({ error: 'only an incoming transaction can be a repayment' });
  }
  if (typeof body.counterpartyId !== 'number') {
    return reply.code(400).send({ error: 'a counterparty is required' });
  }
  repo.createRepayment({
    transactionId: txn.id,
    counterpartyId: body.counterpartyId,
    counterpartyName: (body.counterpartyName ?? '').trim() || `User ${body.counterpartyId}`,
    currency: txn.currency,
    amount: txn.amount,
  });
  recomputePaidStates(repo);
  return { links: repo.listSplitwiseLinks(), repayments: repo.listRepayments() };
});

// Removes a repayment mark from a transaction.
app.delete('/splitwise/repayment/:transactionId', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { transactionId } = req.params as { transactionId: string };
  if (!repo.getRepayment(transactionId)) {
    return reply.code(404).send({ error: 'repayment not found' });
  }
  repo.deleteRepayment(transactionId);
  recomputePaidStates(repo);
  return { links: repo.listSplitwiseLinks(), repayments: repo.listRepayments() };
});

// --- Manual assets ----------------------------------------------------------
// Cars, property, cash — assets the user values by hand. They carry no
// credentials and need no vault, so any token-bearing request may manage them.

const ASSET_KINDS = new Set(['car', 'property', 'cash', 'pension', 'crypto', 'other']);

app.get('/assets', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { assets: repo.listManualAssets() };
});

// Shape validation (kind enum, name, finite value, currency, details bag) via
// the shared assetCreateSchema.
app.post('/assets', { schema: { body: assetCreateSchema } }, async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { kind, name, value, currency } = req.body;
  const details = req.body.details ?? null;
  const asset = repo.createManualAsset({ kind, name, value, currency, details });
  return { asset };
});

// assetUpdateSchema validates the partial field shapes (trimmed name, finite
// value, details record, excluded). The 404 + details null-normalize stay.
app.put(
  '/assets/:id',
  { schema: { params: idParamSchema, body: assetUpdateSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    if (!repo.getManualAsset(id)) return reply.code(404).send({ error: 'asset not found' });
    const body = req.body;
    const fields: {
      name?: string;
      value?: number;
      details?: Record<string, unknown> | null;
      excluded?: boolean;
    } = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.value !== undefined) fields.value = body.value;
    if (body.details !== undefined) {
      fields.details = body.details && typeof body.details === 'object' ? body.details : null;
    }
    if (body.excluded !== undefined) fields.excluded = body.excluded;
    repo.updateManualAsset(id, fields);
    return { asset: repo.getManualAsset(id) };
  },
);

app.delete('/assets/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  repo.deleteManualAsset(id);
  return { ok: true };
});

// --- Vouchers --------------------------------------------------------------
// Gift cards and prepaid vouchers — Shufersal Tav Hazahav, Pluxee, Cibus,
// employer gifts. Currently manual entry only; a future provider sync will
// upsert through repo.createVoucher / updateVoucher with the connectionId
// + externalId pair set.

app.get('/vouchers', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { vouchers: repo.listVouchers() };
});

// Shape validation (name, provider, finite balance, currency, optional
// YYYY-MM-DD expiresOn, notes) via the shared voucherCreateSchema.
app.post('/vouchers', { schema: { body: voucherCreateSchema } }, async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { name, provider, balance, currency } = req.body;
  const expiresOn = req.body.expiresOn ?? null;
  const notes = req.body.notes?.trim() || null;
  const voucher = repo.createVoucher({ name, provider, balance, currency, expiresOn, notes });
  return { voucher };
});

// voucherUpdateSchema validates the partial field shapes (trimmed name +
// provider, finite balance, currency, nullable YYYY-MM-DD expiresOn, notes,
// excluded). The 404 + notes null-normalize stay.
app.patch(
  '/vouchers/:id',
  { schema: { params: idParamSchema, body: voucherUpdateSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    if (!repo.getVoucher(id)) return reply.code(404).send({ error: 'voucher not found' });
    const body = req.body;
    const fields: Parameters<typeof repo.updateVoucher>[1] = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.provider !== undefined) fields.provider = body.provider;
    if (body.balance !== undefined) fields.balance = body.balance;
    if (body.currency !== undefined) fields.currency = body.currency;
    if (body.expiresOn !== undefined) fields.expiresOn = body.expiresOn;
    if (body.notes !== undefined) fields.notes = body.notes?.trim() || null;
    if (body.excluded !== undefined) fields.excluded = body.excluded;
    repo.updateVoucher(id, fields);
    return { voucher: repo.getVoucher(id) };
  },
);

app.delete('/vouchers/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  repo.deleteVoucher(id);
  return { ok: true };
});

// --- Voucher sync: Shufersal Tav Hazahav -----------------------------------
// One-off sync flow (not a persistent connection): start a scrape with a
// phone number, the portal SMSs a code, the UI surfaces an OTP prompt, the
// user posts the code, and the scrape finishes with the updated voucher
// list. State for an in-flight sync lives in-memory only; a sidecar restart
// loses any pending sync. The phone number is encrypted in the vault so a
// re-sync skips re-typing it.

interface ShufersalSync {
  status: 'signing-in' | 'awaiting-otp' | 'syncing' | 'success' | 'error';
  message?: string;
  error?: string;
  vouchers?: { id: string; name: string; balance: number; currency: string }[];
  resolveOtp?: (code: string) => void;
  rejectOtp?: (err: Error) => void;
  finished?: boolean;
}

const shufersalSyncs = new Map<string, ShufersalSync>();
const SHUFERSAL_PROVIDER_LABEL = 'Shufersal — תו הזהב';
const SHUFERSAL_PHONE_VAULT_KEY = 'shufersal:phone';

function shortId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

app.get('/vouchers/sync/shufersal/saved-phone', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault || !vault.unlocked) return { phone: null };
  try {
    const phone = vault.loadSecret(SHUFERSAL_PHONE_VAULT_KEY) ?? null;
    return { phone };
  } catch (err) {
    // Vault locked or no value — surface as "no saved phone" without erroring.
    return { phone: null };
  }
});

app.post('/vouchers/sync/shufersal/start', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as { phone?: string; remember?: boolean };
  const phone = String(body.phone || '').trim();
  if (!phone) return reply.code(400).send({ error: 'a phone number is required' });

  const syncId = shortId();
  const state: ShufersalSync = { status: 'signing-in', message: 'Opening Shufersal…' };
  shufersalSyncs.set(syncId, state);

  // Best-effort save of the phone for re-sync convenience; never blocks the
  // scrape if the vault is locked.
  if (body.remember && vault && vault.unlocked) {
    try { vault.saveSecret(SHUFERSAL_PHONE_VAULT_KEY, phone); }
    catch { /* fine, just won't be remembered */ }
  }

  const onOtpNeeded = () =>
    new Promise<string>((resolve, reject) => {
      // The scrape has reached the OTP screen — flip status so the UI's
      // poller knows to render the code-entry step.
      state.status = 'awaiting-otp';
      state.message = 'Enter the code that was SMSed to your phone.';
      state.resolveOtp = (code) => { state.status = 'syncing'; state.message = 'Verifying with Shufersal…'; resolve(code); };
      state.rejectOtp = (err) => reject(err);
    });

  // Fire-and-forget; the HTTP handler returns immediately and the client
  // polls `/status` until OTP is needed and again until completion.
  const debugDir = join(dataDir, 'debug');
  try { mkdirSync(debugDir, { recursive: true }); } catch { /* best effort */ }
  void (async () => {
    try {
      const cards = await scrapeShufersalGiftCards(phone, onOtpNeeded, {
        debugDumpPath: join(debugDir, 'shufersal-dashboard.html'),
      });
      // Upsert each scraped card and gather the resulting voucher rows.
      const created: { id: string; name: string; balance: number; currency: string }[] = [];
      for (const card of cards) {
        const name = card.last4
          ? `${card.brand} ****${card.last4}`
          : card.brand;
        const v = repo!.upsertScrapedVoucher({
          name,
          provider: SHUFERSAL_PROVIDER_LABEL,
          balance: card.balance,
          currency: card.currency,
          expiresOn: card.expiresOn,
          externalId: card.externalId,
        });
        created.push({ id: v.id, name: v.name, balance: v.balance, currency: v.currency });
      }
      state.status = 'success';
      state.message = `Synced ${cards.length} card${cards.length === 1 ? '' : 's'}.`;
      state.vouchers = created;
      state.finished = true;
    } catch (err) {
      state.status = 'error';
      state.error = err instanceof Error ? err.message : String(err);
      state.message = state.error;
      state.finished = true;
    }
  })();

  return { syncId };
});

app.get('/vouchers/sync/shufersal/status/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const state = shufersalSyncs.get(id);
  if (!state) return reply.code(404).send({ error: 'sync not found' });
  return {
    status: state.status,
    message: state.message ?? null,
    error: state.error ?? null,
    vouchers: state.vouchers ?? null,
    finished: !!state.finished,
  };
});

app.post('/vouchers/sync/shufersal/otp', async (req, reply) => {
  const body = (req.body ?? {}) as { syncId?: string; code?: string };
  const syncId = String(body.syncId || '');
  const code = String(body.code || '').trim();
  if (!syncId || !code) return reply.code(400).send({ error: 'syncId and code are required' });
  const state = shufersalSyncs.get(syncId);
  if (!state || !state.resolveOtp) return reply.code(404).send({ error: 'no sync waiting for OTP' });
  state.resolveOtp(code);
  state.resolveOtp = undefined;
  state.rejectOtp = undefined;
  return { ok: true };
});

app.post('/vouchers/sync/shufersal/cancel', async (req, reply) => {
  const body = (req.body ?? {}) as { syncId?: string };
  const syncId = String(body.syncId || '');
  const state = shufersalSyncs.get(syncId);
  if (!state) return reply.code(404).send({ error: 'sync not found' });
  if (state.rejectOtp) state.rejectOtp(new Error('Sync cancelled.'));
  state.status = 'error';
  state.error = 'Cancelled.';
  state.finished = true;
  return { ok: true };
});

// Best-effort cleanup so completed syncs don't pile up across long sessions.
// Hourly is fine: a sync object is a few hundred bytes.
setInterval(() => {
  for (const [id, state] of shufersalSyncs) {
    if (state.finished) shufersalSyncs.delete(id);
  }
}, 60 * 60 * 1000).unref?.();

// --- Voucher sync: BuyMe ---------------------------------------------------
// Same 2-step flow as Shufersal but email-based OTP instead of SMS, so the
// "awaiting code" wait can be a little longer (users may need to flip to
// their email client). The state shape and endpoints mirror Shufersal so
// the front-end's polling/modal pattern stays the same.

interface BuyMeSync {
  status: 'signing-in' | 'awaiting-otp' | 'syncing' | 'success' | 'error';
  message?: string;
  error?: string;
  vouchers?: { id: string; name: string; balance: number; currency: string }[];
  resolveOtp?: (code: string) => void;
  rejectOtp?: (err: Error) => void;
  finished?: boolean;
  /** True once the user (or the cleanup interval) has cancelled the
   *  sync. Gate the post-scrape upsert against this so a slow-completing
   *  scrape can't write a voucher the user said no to. Same shape as
   *  HtzSync.cancelled. */
  cancelled?: boolean;
  /** Browser handle retained for /cancel — closing it interrupts any
   *  in-flight Puppeteer op AND the visible Chrome window. Cleared in
   *  the IIFE's finally so the cleanup interval can GC the whole entry
   *  without holding a dead Browser. */
  browser?: import('puppeteer').Browser;
}

const buymeSyncs = new Map<string, BuyMeSync>();
const BUYME_PROVIDER_LABEL = 'BuyMe';
const BUYME_EMAIL_VAULT_KEY = 'buyme:email';

app.get('/vouchers/sync/buyme/saved-email', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault || !vault.unlocked) return { email: null };
  try {
    const email = vault.loadSecret(BUYME_EMAIL_VAULT_KEY) ?? null;
    return { email };
  } catch {
    return { email: null };
  }
});

app.post('/vouchers/sync/buyme/start', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as { email?: string; remember?: boolean };
  const email = String(body.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply.code(400).send({ error: 'a valid email address is required' });
  }

  const syncId = shortId();
  const state: BuyMeSync = { status: 'signing-in', message: 'Opening BuyMe…' };
  buymeSyncs.set(syncId, state);

  if (body.remember && vault && vault.unlocked) {
    try { vault.saveSecret(BUYME_EMAIL_VAULT_KEY, email); }
    catch { /* fine, just won't be remembered */ }
  }

  const onOtpNeeded = () =>
    new Promise<string>((resolve, reject) => {
      state.status = 'awaiting-otp';
      state.message = 'Check your inbox — paste the 6-digit code BuyMe just emailed you.';
      state.resolveOtp = (code) => { state.status = 'syncing'; state.message = 'Verifying with BuyMe…'; resolve(code); };
      state.rejectOtp = (err) => reject(err);
    });

  const debugDir = join(dataDir, 'debug');
  try { mkdirSync(debugDir, { recursive: true }); } catch { /* best effort */ }
  // Persistent BuyMe profile so cookies survive between syncs — first run
  // does the full email-OTP dance, every later one skips straight to the
  // wallet (also dodges BuyMe's first-device phone-verification wall).
  const buymeProfileDir = join(dataDir, 'browser-profiles', 'buyme');
  void (async () => {
    try {
      const cards = await scrapeBuyMeGiftCards(email, onOtpNeeded, {
        debugDumpPath: join(debugDir, 'buyme-dashboard.html'),
        userDataDir: buymeProfileDir,
        // Stash the browser so /cancel can close it AND interrupt any
        // Puppeteer op (every op throws after browser.close).
        onBrowserReady: (browser) => { state.browser = browser; },
      });
      // The cancel may have arrived after the scrape's success branch
      // completed its main work but before we got here (e.g. during the
      // fastpath that has no rejectOtp to bounce off). Skip the upsert
      // and DON'T overwrite the 'Cancelled.' state already in place.
      if (state.cancelled) return;
      const created: { id: string; name: string; balance: number; currency: string }[] = [];
      for (const card of cards) {
        // BuyMe's scraper packs the gift's display title into `brand`
        // (since cards rarely have a "last 4 digits" notion the way
        // Shufersal does). Use that directly as the Hon-side name.
        const name = card.brand || 'BuyMe gift';
        const v = repo!.upsertScrapedVoucher({
          name,
          provider: BUYME_PROVIDER_LABEL,
          balance: card.balance,
          currency: card.currency,
          expiresOn: card.expiresOn,
          externalId: card.externalId,
        });
        created.push({ id: v.id, name: v.name, balance: v.balance, currency: v.currency });
      }
      state.status = 'success';
      state.message = `Synced ${cards.length} card${cards.length === 1 ? '' : 's'}.`;
      state.vouchers = created;
      state.finished = true;
    } catch (err) {
      // Mirror the HTZ pattern: don't mask the user-visible "Cancelled."
      // with the resulting Puppeteer "Target closed" exception.
      if (state.cancelled) return;
      state.status = 'error';
      state.error = err instanceof Error ? err.message : String(err);
      state.message = state.error;
      state.finished = true;
    } finally {
      state.browser = undefined;
    }
  })();

  return { syncId };
});

app.get('/vouchers/sync/buyme/status/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const state = buymeSyncs.get(id);
  if (!state) return reply.code(404).send({ error: 'sync not found' });
  return {
    status: state.status,
    message: state.message ?? null,
    error: state.error ?? null,
    vouchers: state.vouchers ?? null,
    finished: !!state.finished,
  };
});

app.post('/vouchers/sync/buyme/otp', async (req, reply) => {
  const body = (req.body ?? {}) as { syncId?: string; code?: string };
  const syncId = String(body.syncId || '');
  const code = String(body.code || '').trim();
  if (!syncId || !code) return reply.code(400).send({ error: 'syncId and code are required' });
  const state = buymeSyncs.get(syncId);
  if (!state || !state.resolveOtp) return reply.code(404).send({ error: 'no sync waiting for OTP' });
  state.resolveOtp(code);
  state.resolveOtp = undefined;
  state.rejectOtp = undefined;
  return { ok: true };
});

app.post('/vouchers/sync/buyme/cancel', async (req, reply) => {
  const body = (req.body ?? {}) as { syncId?: string };
  const syncId = String(body.syncId || '');
  const state = buymeSyncs.get(syncId);
  if (!state) return reply.code(404).send({ error: 'sync not found' });
  // Set the final state FIRST. cancelled is the gate the IIFE checks
  // before persisting / overwriting state in its catch.
  state.status = 'error';
  state.error = 'Cancelled.';
  state.finished = true;
  state.cancelled = true;
  // Reject the OTP promise if the scrape is waiting on one — covers the
  // "user clicked cancel while we asked for the 6-digit email code" path.
  if (state.rejectOtp) state.rejectOtp(new Error('Sync cancelled.'));
  // Close the browser. Covers the fastpath case (cached session, no OTP
  // wait) where rejectOtp was never defined — without this, the scrape
  // would run to completion and the IIFE's `if (state.cancelled) return`
  // would protect against the upsert but the visible Chrome window would
  // still be sitting on the user's desktop until the harvest naturally
  // finishes.
  if (state.browser) {
    state.browser.close().catch(() => { /* already closing */ });
    state.browser = undefined;
  }
  return { ok: true };
});

setInterval(() => {
  for (const [id, state] of buymeSyncs) {
    if (state.finished) buymeSyncs.delete(id);
  }
}, 60 * 60 * 1000).unref?.();

// --- Voucher sync: Hi-Tech Zone --------------------------------------------
// Hi-Tech Zone (htz.mltp.co.il) uses a code-only balance lookup gated by
// Google reCAPTCHA. We can't solve reCAPTCHA headlessly, so the scraper
// launches a VISIBLE Chrome window — the user solves the CAPTCHA and
// clicks the שלח (submit) button themselves; puppeteer just fills the
// digital code, then waits for the navigation to /Ballance and parses
// the resulting balance line. There's no email/OTP step, so the
// /htzone/* state is simpler than BuyMe's: just `awaiting-user-action
// → syncing → success | error`.

interface HtzSync {
  status: 'awaiting-user-action' | 'syncing' | 'success' | 'error';
  message?: string;
  error?: string;
  vouchers?: { id: string; name: string; balance: number; currency: string }[];
  finished?: boolean;
  /** True once the user (or the cleanup interval) has cancelled the
   *  sync. Used to gate the post-scrape upsert so a slow-completing
   *  scrape can't write a voucher the user said no to. */
  cancelled?: boolean;
  /** Retained from the scraper's onBrowserReady so /cancel can close
   *  the visible Chrome window AND interrupt any in-flight Puppeteer
   *  op (every op throws after browser.close, which falls into the
   *  scraper's catch and exits cleanly). */
  browser?: import('puppeteer').Browser;
}

const htzSyncs = new Map<string, HtzSync>();
const HTZ_PROVIDER_LABEL = 'Hi-Tech Zone';
const HTZ_CODE_VAULT_KEY = 'htz:code';

app.get('/vouchers/sync/htzone/saved-code', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  if (!vault || !vault.unlocked) return { code: null };
  try {
    const code = vault.loadSecret(HTZ_CODE_VAULT_KEY) ?? null;
    return { code };
  } catch {
    return { code: null };
  }
});

app.post('/vouchers/sync/htzone/start', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as { code?: string; remember?: boolean };
  const code = String(body.code || '').replace(/\D/g, '');
  if (!/^\d{8,9}$/.test(code)) {
    return reply.code(400).send({ error: 'the digital code must be 8 or 9 digits' });
  }

  const syncId = shortId();
  const state: HtzSync = {
    status: 'awaiting-user-action',
    message: 'Opening Hi-Tech Zone — tick the reCAPTCHA in the browser window and click שלח.',
  };
  htzSyncs.set(syncId, state);

  if (body.remember && vault && vault.unlocked) {
    try { vault.saveSecret(HTZ_CODE_VAULT_KEY, code); }
    catch { /* fine, just won't be remembered */ }
  }

  const debugDir = join(dataDir, 'debug');
  try { mkdirSync(debugDir, { recursive: true }); } catch { /* best effort */ }
  const htzProfileDir = join(dataDir, 'browser-profiles', 'htzone');
  void (async () => {
    try {
      const cards = await scrapeHitechZoneBalance(code, {
        debugDumpPath: join(debugDir, 'htzone-balance.html'),
        userDataDir: htzProfileDir,
        // Stash the browser so /cancel can close it. The handle lives on
        // the in-memory sync state and is cleared in the finally below.
        onBrowserReady: (browser) => { state.browser = browser; },
      });
      // If the user (or the cleanup interval) cancelled between scrape
      // start and now, do NOT persist the result. The state has already
      // been set to 'error/Cancelled.' by the cancel handler — overwriting
      // it would silently insert a voucher the user said no to and toast
      // a success message on the closed modal.
      if (state.cancelled) return;
      const created: { id: string; name: string; balance: number; currency: string }[] = [];
      for (const card of cards) {
        const v = repo!.upsertScrapedVoucher({
          name: card.brand || 'Hi-Tech Zone card',
          provider: HTZ_PROVIDER_LABEL,
          balance: card.balance,
          currency: card.currency,
          expiresOn: card.expiresOn,
          externalId: card.externalId,
        });
        created.push({ id: v.id, name: v.name, balance: v.balance, currency: v.currency });
      }
      state.status = 'success';
      state.message = `Synced ${cards.length} card${cards.length === 1 ? '' : 's'}.`;
      state.vouchers = created;
      state.finished = true;
    } catch (err) {
      // Don't overwrite a cancellation reason with the resulting puppeteer
      // exception ("Protocol error: Target closed.") — the user wants to
      // see "Cancelled.", not a stack-derived message.
      if (state.cancelled) return;
      state.status = 'error';
      state.error = err instanceof Error ? err.message : String(err);
      state.message = state.error;
      state.finished = true;
    } finally {
      // Browser is now closed (either by the scrape exiting cleanly or by
      // /cancel calling browser.close); drop the ref so the cleanup
      // interval can GC the whole entry without holding a dead Browser.
      state.browser = undefined;
    }
  })();

  return { syncId };
});

app.get('/vouchers/sync/htzone/status/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const state = htzSyncs.get(id);
  if (!state) return reply.code(404).send({ error: 'sync not found' });
  return {
    status: state.status,
    message: state.message ?? null,
    error: state.error ?? null,
    vouchers: state.vouchers ?? null,
    finished: !!state.finished,
  };
});

app.post('/vouchers/sync/htzone/cancel', async (req, reply) => {
  const body = (req.body ?? {}) as { syncId?: string };
  const syncId = String(body.syncId || '');
  const state = htzSyncs.get(syncId);
  if (!state) return reply.code(404).send({ error: 'sync not found' });
  // Set the final state FIRST so any in-flight status poll sees it. The
  // cancelled flag is what gates the post-scrape upsert (see start), so
  // even if the puppeteer flow finishes between this line and the close,
  // the voucher write is skipped.
  state.status = 'error';
  state.error = 'Cancelled.';
  state.finished = true;
  state.cancelled = true;
  // Closing the browser is what actually stops the scrape — every
  // Puppeteer op after this throws, the scrape's catch fires, state
  // already reads 'Cancelled.', the upsert is skipped. The .catch
  // swallows the inevitable "Browser was closed" race.
  if (state.browser) {
    state.browser.close().catch(() => { /* already closing */ });
    state.browser = undefined;
  }
  return { ok: true };
});

setInterval(() => {
  for (const [id, state] of htzSyncs) {
    if (state.finished) htzSyncs.delete(id);
  }
}, 60 * 60 * 1000).unref?.();

// --- Loans ----------------------------------------------------------------
// CRUD plus a "current state" computation: outstanding, monthly payment and
// progress, recomputed at read time from the BOI prime + CBS CPI rates so
// the figure stays in step with the published indices without a write step.

app.get('/loans', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const loans = repo.listLoans();
  const needsPrime = loans.some((l) => l.isPrime);
  const needsCpi = loans.some((l) => l.isCpiLinked);
  const prime = needsPrime ? await fetchCurrentPrime(repo) : 0;
  const cpiNow = needsCpi ? await fetchCpiForMonth(repo, currentYyyyMm()) : null;
  return {
    loans: loans.map((loan) => ({
      ...loan,
      rateType: composeRateType(loan),
      state: computeLoanState(loan, prime, cpiNow),
      // Bank-detected payment history. Empty for manual / SnapTrade /
      // pension loans; their connectionId is null so the matcher never
      // attached anything.
      payments: repo!.listLoanPayments(loan.id).map((p) => ({
        id: p.id, date: p.date, amount: p.amount,
        accountId: p.accountId, description: p.description,
      })),
    })),
    rates: { prime: needsPrime ? prime : null, cpiNow },
  };
});

/**
 * Manual override for the bank-loan payment linker. Body `{ loanId }`
 * attaches the transaction; `{ loanId: null }` unlinks. The next sync's
 * auto-matcher skips rows that already have loan_id set, so a manual
 * choice (link OR explicit unlink) sticks.
 */
app.patch(
  '/transactions/:id/loan',
  { schema: { params: idParamSchema, body: txnLoanSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    const loanId = req.body.loanId;
    if (!repo.getTransaction(id)) {
      return reply.code(404).send({ error: 'transaction not found' });
    }
    if (loanId !== null && !repo.getLoan(loanId)) {
      return reply.code(404).send({ error: 'loan not found' });
    }
    try {
      repo.setTransactionLoan(id, loanId);
      return { ok: true, loanId };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  },
);

/**
 * Per-transaction override for the "exclude from cycle calculations"
 * flag. Body `{ excluded: true | false | null }`:
 *   - true  → force the row out of monthly totals.
 *   - false → force the row IN, even when the client's card-bill rule
 *             would have matched it.
 *   - null  → clear the override; the live rule decides.
 *
 * The rule itself lives in the web app's Settings (`cardProviders` +
 * `hideCardTotals`) and is applied client-side — this endpoint only
 * persists the manual override.
 */
app.patch(
  '/transactions/:id/excluded',
  { schema: { params: idParamSchema, body: txnExcludedSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    const excluded = req.body.excluded;
    if (!repo.getTransaction(id)) {
      return reply.code(404).send({ error: 'transaction not found' });
    }
    repo.setTransactionExcluded(id, excluded);
    return { ok: true, excluded };
  },
);

/**
 * Mark/unmark a transaction as a savings transfer. Body `{ savings: boolean }`.
 * A savings row drops out of spend totals AND is tallied as "saved this cycle";
 * it is mutually exclusive with the manual exclude (the repo clears one when
 * setting the other).
 */
app.patch(
  '/transactions/:id/savings',
  { schema: { params: idParamSchema, body: txnSavingsSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    if (!repo.getTransaction(id)) {
      return reply.code(404).send({ error: 'transaction not found' });
    }
    repo.setTransactionSavings(id, req.body.savings);
    return { ok: true, savings: req.body.savings };
  },
);

// Field-shape validation (name, positive principal, YYYY-MM-DD startDate,
// positive-int termMonths, the rateType enum, finite rateValue, currency) comes
// from the SHARED loanCreateSchema — the same schema the loan form validates.
// The CPI snapshot + rateType→isPrime/isCpiLinked decomposition stay here.
app.post('/loans', { schema: { body: loanCreateSchema } }, async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { name, principal, startDate, termMonths, rateType, rateValue, currency, notes } = req.body;
  const { isPrime, isCpiLinked } = decomposeRateType(rateType);
  // Snapshot the CPI at the start month, so the loan's index linkage is
  // pinned to its own start — a later CPI revision does not retroactively
  // change the loan's history.
  const cpiStart = isCpiLinked
    ? await fetchCpiForMonth(repo, startDate.slice(0, 7))
    : null;
  const loan = repo.createLoan({
    name,
    principal,
    startDate,
    termMonths,
    isPrime,
    isCpiLinked,
    rateValue,
    cpiStart,
    currency,
    excluded: false,
    notes: notes?.trim() || null,
  });
  return { loan };
});

// loanUpdateSchema validates the partial field shapes (name, positive
// principal, YYYY-MM-DD startDate, positive-int termMonths, finite rateValue,
// currency, notes, excluded). rateType is not in the shared partial — the
// editor sends it to drive the CPI snapshot below — so it rides along via
// .extend with the shared rateType enum. The decompose + CPI-snapshot business
// logic stays here.
app.put(
  '/loans/:id',
  {
    schema: {
      params: idParamSchema,
      body: loanUpdateSchema.extend({ rateType: rateTypeSchema.optional() }),
    },
  },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    const existing = repo.getLoan(id);
    if (!existing) return reply.code(404).send({ error: 'loan not found' });

    const body = req.body;

    const fields: Parameters<typeof repo.updateLoan>[1] = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.principal !== undefined) fields.principal = body.principal;
    if (body.startDate !== undefined) fields.startDate = body.startDate;
    if (body.termMonths !== undefined) fields.termMonths = body.termMonths;
    if (body.rateType !== undefined) {
      const { isPrime, isCpiLinked } = decomposeRateType(body.rateType);
      fields.isPrime = isPrime;
      fields.isCpiLinked = isCpiLinked;
      // Track flipped to/from CPI-linked: refresh the start-CPI snapshot.
      if (isCpiLinked && !existing.isCpiLinked) {
        const startMonth = (fields.startDate ?? existing.startDate).slice(0, 7);
        fields.cpiStart = await fetchCpiForMonth(repo, startMonth);
      } else if (!isCpiLinked && existing.isCpiLinked) {
        fields.cpiStart = null;
      }
    }
    if (body.rateValue !== undefined) fields.rateValue = body.rateValue;
    if (body.currency !== undefined) fields.currency = body.currency;
    if (body.notes !== undefined) fields.notes = body.notes?.trim() || null;
    if (body.excluded !== undefined) fields.excluded = body.excluded;

    repo.updateLoan(id, fields);
    return { loan: repo.getLoan(id) };
  },
);

app.delete('/loans/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  repo.deleteLoan(id);
  return { ok: true };
});

app.patch(
  '/loans/:id/excluded',
  { schema: { params: idParamSchema, body: excludedToggleSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    if (!repo.getLoan(id)) return reply.code(404).send({ error: 'loan not found' });
    repo.setLoanExcluded(id, req.body.excluded);
    return { ok: true };
  },
);

// Current BOI prime + CBS CPI, exposed so the UI can show today's reference
// numbers and offer a "refresh rates" button.
app.get('/rates', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const prime = await fetchCurrentPrime(repo);
  const cpiNow = await fetchCpiForMonth(repo, currentYyyyMm());
  return { rates: { prime, cpiNow, asOf: new Date().toISOString() } };
});

// --- Categories ----------------------------------------------------------
// User-editable spending categories. The seeded built-ins are returned with
// `isBuiltin: true` so the UI can render delete-disabled for them.

const VALID_GROUPS = new Set(['essential', 'fixed', 'variable', 'income']);
function isValidGroup(v: unknown): v is 'essential' | 'fixed' | 'variable' | 'income' {
  return typeof v === 'string' && VALID_GROUPS.has(v);
}

app.get('/categories', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { categories: repo.listCategories() };
});

// Field-shape validation (name length, #RRGGBB colour, the catGroup enum,
// integer sortOrder, and the create defaults) now comes from the SHARED zod
// schema in /shared/category.ts — the same schema the React form validates
// against via react-hook-form. Only business rules that need the DB
// (uniqueness, existence, the "Other" guard) stay as explicit checks here.
app.post('/categories', { schema: { body: categoryCreateSchema } }, async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { name, emoji, color, catGroup, sortOrder } = req.body;
  if (repo.getCategory(name)) {
    return reply.code(409).send({ error: 'a category with that name already exists' });
  }
  const created = repo.createCategory({ name, emoji, color, catGroup, sortOrder });
  return { category: created };
});

app.put(
  '/categories/:name',
  { schema: { params: categoryNameParamSchema, body: categoryUpdateSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { name } = req.params;
    const existing = repo.getCategory(name);
    if (!existing) return reply.code(404).send({ error: 'category not found' });
    // "Other" is the fallback bucket for deleted/uncategorized transactions —
    // reclassifying its group would silently pull those into spending totals,
    // so its group is locked (other edits like emoji/colour are fine). DELETE
    // guards "Other" too.
    if (req.body.catGroup !== undefined && name === 'Other' && req.body.catGroup !== existing.catGroup) {
      return reply.code(400).send({
        error: '"Other" is the fallback category — its group cannot be changed',
      });
    }
    // req.body is already the validated partial — pass it straight through.
    repo.updateCategory(name, req.body);
    return { category: repo.getCategory(name) };
  },
);

app.delete(
  '/categories/:name',
  { schema: { params: categoryNameParamSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { name } = req.params;
    const existing = repo.getCategory(name);
    if (!existing) return reply.code(404).send({ error: 'category not found' });
    if (name === 'Other') {
      return reply.code(400).send({
        error: '"Other" is the fallback target for deleted categories and cannot itself be removed',
      });
    }
    const affected = repo.countTransactionsInCategory(name);
    repo.deleteCategory(name);
    return { ok: true, transactionsMoved: affected };
  },
);

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
    apiUrl?: string;
    apiKey?: string;
    apiModel?: string;
  };
  // Only forward fields the request actually carried — an omitted field keeps
  // its stored value, so switching providers never wipes the others' details.
  const ollama: Record<string, string> = {};
  if (body.ollamaUrl !== undefined) ollama.baseUrl = body.ollamaUrl;
  if (body.ollamaKey !== undefined) ollama.apiKey = body.ollamaKey;
  if (body.ollamaModel !== undefined) ollama.model = body.ollamaModel;
  const api: Record<string, string> = {};
  if (body.apiUrl !== undefined) api.baseUrl = body.apiUrl;
  if (body.apiKey !== undefined) api.apiKey = body.apiKey;
  if (body.apiModel !== undefined) api.model = body.apiModel;
  const mode =
    body.mode === 'ollama' ? 'ollama' : body.mode === 'api' ? 'api' : 'local';
  llm.setProvider({ mode, ollama, api });
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

// Same as the Ollama test, but for an OpenAI-compatible API service.
app.post('/llm/api/test', async (req) => {
  const body = (req.body ?? {}) as { apiUrl?: string; apiKey?: string };
  return llm.testApi({
    baseUrl: body.apiUrl ?? '',
    ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
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
    cardProvider?: string | string[];
  };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const range =
    q.start && q.end && iso.test(q.start) && iso.test(q.end)
      ? { start: q.start, end: q.end, label: q.start.slice(0, 7) }
      : undefined;
  // Whether the requested window is the cycle in progress. Drives BOTH the
  // stored income-override fallback (just below) and the piggy-ledger persist
  // (further down). Local-time "today" matches currentMonthRange and the
  // client's cycle math, avoiding a near-midnight UTC off-by-one at the boundary.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  const isCurrentCycle = !range || (range.start <= today && today < range.end);
  const num = (v: string | undefined): number | undefined => {
    // Treat an empty value (e.g. `?expectedIncome=`) as absent, not as an
    // explicit 0 override — Number('') is 0, which would zero the projection.
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  // An explicit ?expectedIncome= query param wins (legacy client-supplied
  // projection); otherwise fall back to the user's saved manual "Expected
  // income" override. That override is a single global figure ("what I expect
  // to earn"), so it only applies to the cycle in progress — never a past or
  // future window.
  const expectedIncome =
    num(q.expectedIncome) ??
    (isCurrentCycle ? repo.getExpectedIncomeOverride() ?? undefined : undefined);
  const expectedFixed = num(q.expectedFixed);
  // Repeated ?cardProvider=… params arrive as a string or an array; normalise.
  const cardProviders = Array.isArray(q.cardProvider)
    ? q.cardProvider
    : q.cardProvider
      ? [q.cardProvider]
      : [];
  const projection =
    expectedIncome !== undefined || expectedFixed !== undefined || cardProviders.length > 0
      ? { expectedIncome, expectedFixed, cardProviders }
      : undefined;
  const report = buildBudgetReport(repo, range, projection);
  // `/budget` is the one caller that commits the piggy ledger — so a report
  // built elsewhere (insights) cannot overwrite it with stale figures. But the
  // ledger may only be written for the CURRENT cycle (isCurrentCycle, computed
  // above): persistPiggyMonth keys rows on the caller-supplied month label, so a
  // request for a past (or future) cycle would otherwise overwrite that month's
  // frozen contributions with figures recomputed from today's data. No range =
  // the calendar-month fallback, which is always the current cycle.
  if (isCurrentCycle) {
    persistPiggyMonth(repo, report.piggy);
  }
  return report;
});

// category + finite monthlyAmount validated by the shared budgetSetSchema; a
// non-positive amount clears the budget.
app.put('/budgets', { schema: { body: budgetSetSchema } }, async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { category, monthlyAmount } = req.body;
  if (monthlyAmount > 0) {
    repo.setBudget(category, monthlyAmount);
  } else {
    repo.deleteBudget(category);
  }
  return { ok: true };
});

// Manual override for the auto-averaged "Expected income". `value: null`
// clears the override and restores the average.
app.get('/budget/income-override', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  return { value: repo.getExpectedIncomeOverride() };
});

// incomeOverrideSchema validates `value` is a non-negative number or null;
// `value: null` clears the override (business rule kept).
app.put(
  '/budget/income-override',
  { schema: { body: incomeOverrideSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const value = req.body.value;
    if (value == null) {
      repo.setExpectedIncomeOverride(null);
      return { ok: true };
    }
    repo.setExpectedIncomeOverride(value);
    return { ok: true };
  },
);

// Per-month savings set-aside. The UI loads the whole dict (small) and PUTs
// one month at a time. Amount 0 (or absent) clears that month's entry.
// `transferred` records whether the set-aside is a real transfer out of the
// checking account or just an earmark that stays in — the bank-balance
// projection deducts only the transferred ones.
app.get('/budget/savings', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const savings: Record<string, { amount: number; transferred: boolean }> = {};
  for (const row of repo.listMonthlySavings()) {
    savings[row.month] = { amount: row.amount, transferred: row.transferred };
  }
  return { savings };
});

// month (YYYY-MM), non-negative amount, and transferred flag validated by the
// shared monthlySavingsSchema.
app.put('/budget/savings', { schema: { body: monthlySavingsSchema } }, async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { month, amount, transferred } = req.body;
  repo.setMonthlySavings(month, amount, transferred);
  return { ok: true };
});

// Piggy banks — savings goals. The settled this-month status rides along in
// the budget report's `piggy` block; these routes are CRUD only.
// Shape + the monthly-needs-positive-monthlyAmount cross-check come from the
// shared piggyCreateSchema (superRefine). Lump piggies fund the full target in
// one shot, so monthlyAmount is forced to 0 here.
app.post('/piggy', { schema: { body: piggyCreateSchema } }, async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { name, emoji, kind, targetAmount } = req.body;
  const monthlyAmount = kind === 'monthly' ? req.body.monthlyAmount : 0;
  const piggy = repo.createPiggyBank({
    name,
    emoji,
    kind,
    targetAmount,
    monthlyAmount,
    currency: 'ILS',
  });
  return { piggy };
});

// piggyUpdateSchema validates the partial field shapes (trimmed name, emoji,
// kind enum, positive targetAmount, non-negative monthlyAmount, onHold). The
// 404, the emoji default, and the monthly-must-be-positive rule stay — the
// schema's nonNegativeNumber on monthlyAmount allows 0, which this route
// rejects.
app.put(
  '/piggy/:id',
  { schema: { params: idParamSchema, body: piggyUpdateSchema } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { id } = req.params;
    const existing = repo.getPiggyBank(id);
    if (!existing) return reply.code(404).send({ error: 'piggy bank not found' });
    const body = req.body;
    const fields: Partial<{
      name: string;
      emoji: string;
      kind: 'monthly' | 'lump';
      targetAmount: number;
      monthlyAmount: number;
      onHold: boolean;
    }> = {};
    if (body.kind !== undefined) fields.kind = body.kind;
    if (body.name !== undefined) fields.name = body.name;
    if (body.emoji !== undefined) fields.emoji = body.emoji.trim() || '🐷';
    if (body.targetAmount !== undefined) fields.targetAmount = body.targetAmount;
    if (body.monthlyAmount !== undefined) {
      // Monthly piggies need a positive draw; lump piggies reserve the target
      // in one shot and don't draw monthly, so 0 is valid for them — mirror
      // POST /piggy, which forces monthlyAmount to 0 for lump.
      const effectiveKind = body.kind ?? existing.kind;
      if (effectiveKind === 'monthly' && body.monthlyAmount <= 0) {
        return reply.code(400).send({ error: 'a positive monthly amount is required' });
      }
      fields.monthlyAmount = effectiveKind === 'lump' ? 0 : body.monthlyAmount;
    }
    if (body.onHold !== undefined) fields.onHold = body.onHold;
    repo.updatePiggyBank(id, fields);
    return { piggy: repo.getPiggyBank(id) };
  },
);

app.delete('/piggy/:id', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  repo.deletePiggyBank(id);
  return { ok: true };
});

app.post('/insights', async (req, reply) => {
  if (!insights) return reply.code(503).send({ error: 'database unavailable' });
  const body = (req.body ?? {}) as { cardProviders?: unknown; start?: string; end?: string };
  const cardProviders = Array.isArray(body.cardProviders)
    ? body.cardProviders.filter((p): p is string => typeof p === 'string')
    : [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const range = body.start && body.end && iso.test(body.start) && iso.test(body.end)
    ? { start: body.start, end: body.end, label: body.start.slice(0, 7) }
    : undefined;
  insights.start(cardProviders, range);
  return { ok: true };
});

app.get('/insights', async (_req, reply) => {
  if (!insights) return reply.code(503).send({ error: 'database unavailable' });
  return insights.getStatus();
});

// User-cancelled subscriptions. The Subscriptions tab hides these from
// "active" and surfaces them in a Cancelled section; a charge dated after the
// cancellation is flagged in the UI so the user can check the cancellation
// actually took.
app.get('/subscriptions/cancelled', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const cancelled: Record<string, string> = {};
  for (const row of repo.listCancelledSubs()) {
    cancelled[row.merchantKey] = row.cancelledAt;
  }
  return { cancelled };
});

app.put(
  '/subscriptions/cancelled',
  { schema: { body: z.object({ merchantKey: z.string().min(1) }) } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const key = req.body.merchantKey.trim();
    if (!key) return reply.code(400).send({ error: 'a merchant key is required' });
    repo.markSubCancelled(key);
    return { ok: true };
  },
);

app.delete(
  '/subscriptions/cancelled',
  { schema: { body: z.object({ merchantKey: z.string().min(1) }) } },
  async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const key = req.body.merchantKey.trim();
    if (!key) return reply.code(400).send({ error: 'a merchant key is required' });
    repo.unmarkSubCancelled(key);
    return { ok: true };
  },
);

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
  // Failsafe: a lingering keep-alive socket can make app.close() hang forever.
  // Never let that keep this ~2 GB process alive after the app is gone.
  const hardExit = setTimeout(() => {
    log('shutdown timed out — forcing exit');
    process.exit(0);
  }, 3000);
  hardExit.unref();
  app.close().finally(() => {
    clearTimeout(hardExit);
    dbHandle?.db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
