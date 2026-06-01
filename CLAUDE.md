# CLAUDE.md — Hon engineering notes

A focused map of the Hon codebase for future Claude sessions (and for me
when I open this in a month and forget how it works). This is the
**non-obvious** stuff — the why behind decisions that would otherwise
look strange. The README covers what Hon does and how to run it.

> **Read [HANDOFF.md](HANDOFF.md) for current state** — what's shipped,
> what's deferred, restart workflow, recent gotchas.

---

## Stack modernization (2026-06-01) — ORM, shared zod, Query, Zustand, RHF

A cross-cutting refactor introduced five patterns. The **why** for each:

- **Drizzle ORM** replaces raw `db.prepare(...)` SQL in `repo.ts`. The typed
  query layer is `sidecar/src/db/schema.ts` (tables) + `db/client.ts`
  (`makeDb(sqlite)` wraps the SAME better-sqlite3 connection — no second
  handle). **`db.ts` migrations (`db/migrations.ts`) remain the schema source
  of truth**; Drizzle does NOT create tables. `tests/` (run via the repo net)
  guards parity. ~8 methods deliberately keep raw SQL — the documented escape
  hatch: `saveScrapeResult` (hot upsert loop), `listTransactions` (correlated
  refund-peer subqueries), `summary` (GROUP BY), the analytics CTE methods over
  `txn_effective`, and `upsertBankLoan`'s backfill scan. SQLite booleans are
  now `integer(..., { mode: 'boolean' })` so reads come back as real booleans —
  the old `to*`/`coerceTxnRow` 0/1 coercers were dropped (a `narrow*` helper
  remains where a TEXT column maps to a TS union, e.g. category `catGroup`).

- **Shared zod schemas** in `/shared/*.ts` are the SINGLE SOURCE OF TRUTH for
  validation, imported by BOTH the engine (request validation) AND the web app
  (react-hook-form resolver) via the `@hon/shared/<name>` path alias. NodeNext
  (sidecar) needs an EXPLICIT `.ts` path entry per module in
  `sidecar/tsconfig.json` (the bare `@hon/shared/*` wildcard does NOT resolve
  under NodeNext tsc, only under tsx/bundler). Web (`bundler` resolution) +
  Vite (`resolve.alias`) handle the wildcard. `zod` is a root-level dep so
  `/shared` resolves it from either package.

- **fastify-type-provider-zod** on the engine: `app.withTypeProvider()` +
  `setValidatorCompiler` + a `setErrorHandler` that turns zod failures into the
  existing `{ error: string }` 400 shape (so the client's `ApiError` handling is
  unchanged). Routes opt in with `{ schema: { body/params: <zodSchema> } }`;
  `req.body`/`params` are then typed. Business rules (404/409/the "Other" guard)
  stay as explicit checks — zod only replaces SHAPE/TYPE guards.

- **Frontend API library** `web/src/api/`: `client.ts` re-exports the
  bearer-token fetch; per-domain modules (`categories.ts`, …) own every endpoint
  URL + verb + payload and parse responses with the shared schemas. Components
  call these (or the Query hooks), never `api('/path')` inline.

- **TanStack Query** owns server state. `api/queryClient.ts` has the client +
  the central `qk` query-key registry; `api/hooks/use*.ts` expose
  `useQuery`/`useMutation` hooks that invalidate `qk.*()` on success. Provider is
  in `main.tsx`. Replaces the `useEffect + api() + setState` fetch pattern.
  **Tests** that render a Query-using component must wrap in a provider — use
  `web/src/test/renderWithProviders.tsx` (`renderWithProviders as render`).

- **Zustand** `web/src/store/uiStore.ts` holds CLIENT/UI state — active tab,
  cross-component navigation, the unseen-loans badge — replacing the custom
  window-event bus (`hon.go-to-loans`/`hon.go-to-assets`/`hon.loan-ids-changed`).
  Components call `useUiStore((s) => s.tab)` or the imperative `uiActions.*`.
  The durable `hon.pendingAddLoan` localStorage handoff to AccountsView is kept
  (AccountsView reads it on mount); the store carries a `pendingAction` too.

- **react-hook-form + zod** for forms. Reference: `CategoryEditor` in
  `settings/CategoriesPanel.tsx` — `useForm({ resolver: zodResolver(shared) })`,
  `register` for inputs, `register`+`setValue`+`watch` for button/picker fields,
  `setError('root', …)` for submit errors. Converted: CategoryEditor,
  CarAssetForm, PiggyFormDialog, BalanceModal, AssetEditModal, LoanEditModal.
  Forms with bespoke UX keep a LOCAL form schema (numeric inputs as strings
  parsed in onSubmit) and map to the shared API shape on submit.

> **Sandbox note for future sessions:** the repo's `better-sqlite3` is a macOS
> binary; it can't run under a Linux CI/sandbox ("invalid ELF header"). To
> runtime-test repo.ts off-Mac, build a separate harness with a Linux-native
> `better-sqlite3` and copy the source in (the migration used one under
> `outputs/honverify`). `tsc` + the macOS `npm test` are the real gates.

---

## The web app — React (`web/`), served from `web/dist`

- **React app** — `web/` (Vite + React 19 + TS strict + Vitest).
  Built to `web/dist` and served by the engine at `/`. The legacy
  single-file SPA was retired (2026-05-31); `web/dist` is now the only UI.
- **`/api/*` rewrite.** The React client calls `/api/<route>`; the engine
  rewrites those to `/<route>` via Fastify's `rewriteUrl`
  (`sidecar/src/httpRewrite.ts`), replicating vite's dev proxy. Static
  assets are served from `web/dist/assets` under `/assets/`.
- **Built on launch.** `web.mjs` builds `web/dist` when it's missing or
  stale (sources newer than the last build) before starting the engine.
- **Dev.** `cd web && npm run dev` → vite on `http://localhost:5173/#token=…`
  with the `/api → :4000` proxy, OR the full launcher `npm run dev` (top-level
  `package.json`, spawns engine + vite concurrently).

### One-command launcher (top-level `package.json`)

```bash
cd Hon && npm run dev
# concurrently spawns engine (yellow) + vite (cyan)
```

### Persistent dev token

`web.mjs` reads/writes `<dataDir>/dev-token` (mode 0600). Token
precedence: `HON_TOKEN` env > on-disk > fresh-and-saved. URL is
bookmarkable across restarts. **The token is the only thing between a
local browser tab and the user's finances — never remove it.**

### React-side conventions worth knowing

- **Radix UI primitives** (`@radix-ui/react-dialog`,
  `@radix-ui/react-dropdown-menu`) for modals/menus. jsdom polyfills
  for `hasPointerCapture` / `setPointerCapture` /
  `releasePointerCapture` / `scrollIntoView` in
  `web/src/test/setup.ts`.
- **Cross-component navigation via custom window events** instead
  of prop drilling: `hon.go-to-loans` (chip → tab switch),
  `hon.loan-ids-changed` (same-tab localStorage signal — the
  browser's `storage` event is cross-tab only).
- **`web/src/ui/DelayedLoader.tsx`** — 250ms grace period before
  rendering loading state. Replaces all `<p>Loading…</p>` to kill
  tab-switch flash.
- **`installFetchMock`** in `web/src/test/mockFetch.ts` keyed by
  `"METHOD /api/path"`. Unmocked requests throw loud.

---

## Architecture at a glance

```
┌────────────────────────────────────────────────────────┐
│   Browser (your default)                               │
│   http://127.0.0.1:<port>/#token=<uuid>                │
│   ↓ fetches single-page app                            │
│   web/dist  (built React app, served by the engine)    │
└────────────────────────────────────────────────────────┘
                       ↕  HTTP (Bearer <token>)
┌────────────────────────────────────────────────────────┐
│   Fastify engine — bound to 127.0.0.1 only             │
│   sidecar/src/server.ts  (95+ routes, all token-gated) │
└────────────────────────────────────────────────────────┘
            ↓                  ↓                   ↓
       Repo (sqlite)       Vault (AES-GCM)    ScrapeRunner
       repo.ts             vault.ts           runner.ts → scrapers/pension/loans/vouchers
       db.ts (migrations)                     + Puppeteer + israeli-bank-scrapers
```

- **No backend, no telemetry, no cloud.** Engine binds to loopback. Token
  travels in the URL fragment (`#token=…`), so it never hits the server
  log. The web app reads `location.hash` and attaches `Authorization:
  Bearer <token>` to every fetch.
- **Single-binary deploy.** `web.mjs` (the launcher) generates a token,
  spawns the engine, opens the browser. Everything else is the engine.

## Where stuff lives on disk

| What | Where |
|---|---|
| SQLite DB | `~/Library/Application Support/Hon/hon.db` (Mac) — `%APPDATA%\Hon\hon.db` (Win) — `$XDG_DATA_HOME/Hon/hon.db` (Linux) |
| Encrypted credentials/sessions | Same dir, `vault/` subdir; key derived via scrypt from a user passphrase |
| Browser profiles (pension funds) | Same dir, `browser-profiles/<companyId>/` — persistent Chrome profile per fund |
| Failure screenshots + HTML dumps | Same dir, `debug/<companyId>.png` + per-fund HTML/JSON dumps |
| Engine log (tee'd by web.mjs) | Same dir, `sidecar.log` |
| Logos cache | Same dir, `logos/<host>.png` |

`HON_DATA_DIR` env var overrides everything.

## The structured logger — `src/log.ts`

Used EVERYWHERE. Every scraper, every session op, every persistence step
emits structured stderr lines:

```
17:42:03.214 · [scrape:interactive:hapoalim] library.scrape.start
17:42:24.108 · [scrape:normalize]            account  account=12345-67 balance=15203.40 txns=42 firstTxn=… lastTxn=…
17:42:24.181 · [runner:run:abc12345]         scrape.end  elapsedMs=20970 result=success accounts=2 transactions=87
```

Three rules to keep this useful:

1. **`makeLog('<dotted:tag>')`** at module top; `log.child('subTag')`
   when you drill into a sub-operation. Run-scoped child loggers in
   `runner.ts` use the short run id (`run:abc12345`) so every line for
   one scrape attempt is greppable.
2. **`log.timer('phase')`** for any operation that can hang. Returns a
   closure; calling it logs `phase.end` with `elapsedMs`. This is how
   you spot "scrape hung at LOGIN" vs "scrape hung at READING_BALANCES"
   later.
3. **Never log credential values** — only field names. The runner does:
   `credentialFields: Object.keys(args.credentials)`. Logs are
   shareable for debugging.

Debug-level lines are gated on `HON_LOG_DEBUG=1`.

## The scrape lifecycle — `runner.ts` → `scrapers.ts|pension.ts|snaptrade.ts`

A connection has a `companyId` (`hapoalim`, `harel`, `snaptrade`, etc).
Runner dispatches by company type:

- `isSnapTrade(companyId)` → `runSnapTradeSync` (IBKR via SnapTrade)
- `isPensionCompany(companyId)` → `runPensionScrape` (custom Puppeteer)
- `args.interactive` → `runInteractiveScrape` (puppeteer + OTP watcher)
- else → `runScrape` (headless, via israeli-bank-scrapers)

### Bank session reuse (the OTP-skip trick)

Cookies from a successful scrape are persisted in the vault
(`session.ts`). The next sync replays them via `browser.setCookie(...)`
BEFORE `scraper.scrape(...)` runs. If the bank trusts the device, the
library's `login()` short-circuits and OTP is skipped.

- **Enabled** for every company by default.
- **Denylist** in `runner.ts`: `BANK_SESSION_DENYLIST = new Set(['max'])`.
  Max hangs when cookies pre-authenticate it past the login form the
  library is waiting for. Add ids here ONLY after seeing
  `library.progress type=LOGGING_IN` never reach `LOGIN_SUCCESS`.

### Card companies (incremental-scrape exclusion)

`CARD_COMPANIES = {max, visaCal, isracard, amex}` always re-fetch the
full `monthsBack` window. Their reported "balance" is the next-bill
outstanding computed from the FULL set of pending + scheduled charges;
the incremental shortcut would undercount the cycle's leading edge.

### Pension funds — `pension.ts`

Three flavours:
- **Migdal / Harel / Clal** — passwordless OTP login, fully automated.
  Hon fills the ID, requests the OTP via the runner, types the code.
- **Meitav / Menora** — CAPTCHA-walled. Launch a **visible** Chrome
  window with a **persistent profile** (real installed Chrome, not
  bundled Chromium; less bot-detectable). User clears the security
  check + types the SMS code themselves. Cookies persist so subsequent
  syncs resume signed in without the wall.
- **Altshuler** — manual entry only, no scraper.

### The Meitav "page keeps refreshing" trap (2026-05-25)

The captcha-walled poll loop calls `readBalances` every 5s waiting for
the user to finish signing in. `readMeitavBalances` navigates to
`/lobbymanager` — which yanked the user off the login form mid-typing.
Fix in `pension.ts`: skip the read while `page.url()` matches a login
shape. Regex covers `login/signin/auth/otp/verify/sso` paths and
hash-routed equivalents. Wrong-positives are harmless (the read returns
0 accounts and the loop keeps polling).

### The Harel "wrong-frame" trap (2026-05-25)

Harel's client-view balance widget lives in a cross-origin iframe at
`digital.harel-group.co.il`. The host page URL is `…/Pages/client-view.aspx`.
The previous regex `client-view|digital.harel` matched the HOST page
(because it contains `client-view`) before the real iframe — so
`extractTiles` ran on the wrong document and the 180s poll deadline
expired silently. The fix matches `digital.harel-group.co.il`
specifically, with a `contentFrame()` fallback for when site-isolation
hides the iframe from `page.frames()`.

### Stale Chrome profile locks

`launchPensionBrowser` calls `sweepStalePensionLocks(profileDir)`
before every launch. Removes orphan `DevToolsActivePort`,
`SingletonLock`, `SingletonSocket`, `SingletonCookie`, `Default/LOCK`.
Without this, a hard engine restart left Meitav un-launchable until
the user `rm`'d the lock files by hand.

## The budget model (domain knowledge)

The React app (`web/`) is the UI; this section captures the budgeting
domain concepts that are still real regardless of which component renders
them. (The original prose lived in the now-retired `app.html`; the math
below is unchanged.)

### The cycle model

A cycle is a calendar month (with custom `settings.monthStartDay` start
day). `cycleKey(date)` returns `"YYYY-MM"`. `currentCycleKey()` is
`today`. All budget math is per-cycle.

### The budget projection

The budget projection computes:
- `expectedIncome` — manual override or computed from recurring inflows
- `expectedFixed` — smoothed monthly-equivalent of recurring fixed bills
- `expectedFixedThisCycle` — full charges of bills predicted to bill in
  THIS cycle (bimonthly bills count in full when due, ₪0 when off-cycle)

Headline uses `expectedFixedThisCycle`. Fixed bills page top number
("Due this cycle") is the same number. Reconcile a discrepancy first by
checking the merchant frequencies in the Recurring tab.

### The projected-bank-balance card

The projected-bank-balance card computes end-of-cycle bank balance using
the USER'S mental model:

```
end = bankNow + income − fixed − essentials − varSpent − piggies
```

Note: deducts FULL cycle commitments, NOT "remaining" ones. Reason:
Israeli credit cards bill once a month, so most card spending hasn't
actually hit `bankNow` yet. Deducting the full expected outflows
accounts for those pending card bills.

Savings shown as informational (greyed out, no sign) — savings is an
earmark in checking, not an outflow.

## The DB — `db.ts` + `repo.ts`

- `SCHEMA_VERSION` lives in `db.ts` (currently **34**). Migrations
  run in order on every start. Adding a column = new migration;
  never edit a prior one.
- All access via the `Repo` class (no direct `db.prepare` outside
  `repo.ts`). Methods are typed end-to-end.
- The `txn_effective` view is the canonical transaction read — applies
  refund offsets + Splitwise reductions inline so callers don't have to.
- **`TXN_COLS` reminder.** The bare-SELECT constant near the top of
  `repo.ts` lists every column the UI reads from `transactions`.
  If you add a new column (e.g. `loan_id AS loanId`, schema v33),
  **add it to `TXN_COLS` too** — otherwise the UI silently loses it.
  This was the bug that landed at the end of the loan-detection
  feature (commit `45d3ff8`).

## Loan auto-link — `loanMatcher.ts` + `repo.ts`

Bank-scraped loans get their payment transactions linked
automatically. `transactions.loan_id TEXT` (migration 33) + partial
index `idx_txn_loan_id WHERE loan_id IS NOT NULL` (migration 34).

`matchPaymentToLoan(txn, loans)` in `src/loanMatcher.ts` is a pure
heuristic: externalId hit → ≥3-char name-token hit after stripping
loan stopwords → single-loan fallback (only when the loan name
doesn't itself contain a stopword).

**Hebrew regex pitfall.** `\b` doesn't anchor Hebrew (Hebrew chars
aren't `\w`). The matcher uses bare substring for Hebrew
alternatives (`הלוואה|הלואה`) and `\b…\b` only for Latin
(`halvaa|loan`). If you add Hebrew patterns elsewhere, do the same.

Two write paths run the matcher:
1. `upsertBankLoan` first-insert branch — 12-month backfill scan
   over the connection's transactions.
2. Per-account sync — hoisted prepared statements run the matcher
   after every `upsertTxn`, skipping rows that already have `loan_id`.

API surface:
- `GET /loans` folds `repo.listLoanPayments(loan.id)` into each
  loan as `payments` (newest-first).
- `PATCH /transactions/:id/loan` body `{ loanId | null }` for
  manual link/unlink.

## The vault — `vault.ts`

- AES-256-GCM, key derived via scrypt from a user passphrase.
- Stores credentials per connection (`creds:<connId>`), bank sessions
  (`session:<connId>`), pension phone (`shufersal:phone`), etc.
- `vault.unlocked` gates everything. When locked, sessions can't load
  (no OTP-skip) and saved credentials can't decrypt.
- Lost passphrase = re-enter credentials. Documented as a feature
  (zero-knowledge), not a bug.

## On-device LLM — `llm.ts`

`node-llama-cpp` with a small Llama 3.2 model for categorization +
chat. Loads lazily on first request, releases on idle. Metal-backed on
Apple Silicon; falls back to CPU on Intel/Linux.

The "Categorize all" button in Settings batches uncategorized
transactions through the LLM with merchant-grouping to amortize prompt
cost. Cache hits per merchant key avoid re-prompting.

`MODEL_CATALOG` includes **DictaLM 2.0 (Hebrew-focused)** —
`hf:dicta-il/dictalm2.0-instruct-GGUF:Q4_K_M`, ~4.1 GB. Recommend
this for Hebrew-heavy transaction sets; the default is still the
small Llama 3.2 for fastest categorization on mixed text.

## Voucher scrapers — gotchas worth knowing

- **HTZ Cloudflare wall.** `#eightDigit` wait is **90s** in
  `voucherScrapers.ts`. Combined with stealth flags
  (`--disable-blink-features=AutomationControlled`,
  `ignoreDefaultArgs:['--enable-automation']`, `navigator.webdriver`
  override) to dodge Cloudflare Turnstile.
- **HTZ vault-free fastpath.** The HTZ voucher's `externalId` is
  `htz-<code>`; the UI extracts the code and skips the vault round
  trip on ↻ Sync. HTZ-only — other providers still need the vault.
- **BuyMe identity check.** Persistent cookie profiles can silently
  harvest cards for a NEW BuyMe email if the previous session's
  cookies still authenticate. The scraper writes a `last-email`
  marker file before launch and `rmSync`s the profile dir on
  mismatch to force fresh OTP. Pattern is reusable for any
  cookie-fastpath scraper that's identity-scoped.

## Categorization — `categorize.ts`

Three-tier:
1. **Exact-merchant cache** (`category_cache` table) — instant hit.
2. **Substring match** against built-in rules — fast, deterministic.
3. **LLM fallback** — only when 1 + 2 miss. Result is cached.

Categories themselves are user-editable in Settings (Categories tile
grid). `CATEGORIES` is read from the `categories` table at request time,
NOT hard-coded.

## Useful one-liners

```bash
# Kill the engine (anywhere)
pkill -9 -f 'tsx.*server\.ts|node.*web\.mjs'

# Tail the engine log
tail -f "$HOME/Library/Application Support/Hon/sidecar.log"

# Inspect the DB
sqlite3 "$HOME/Library/Application Support/Hon/hon.db"

# Reset Meitav's stuck profile
rm -f "$HOME/Library/Application Support/Hon/browser-profiles/meitav/"{DevToolsActivePort,SingletonLock,SingletonSocket,SingletonCookie,Default/LOCK}

# Force a full re-scrape (skip the 14-day incremental shortcut)
# — delete the connection's scrape_runs history; chooseStartDate falls
# back to monthsBack:
sqlite3 hon.db "DELETE FROM scrape_runs WHERE connection_id = '<id>'"
```

## Common debugging patterns

| Symptom | First thing to check |
|---|---|
| "Sync hangs" | `[runner:run:xxx]` lines in sidecar.log — last `library.progress` tells you the phase |
| "OTP never accepted" | `[scrape:interactive:<co>] otp.watcher.armed`? If no, the watcher isn't enabled for that bank — see `HON_OTP_WATCHER_COMPANIES` in scrapers.ts |
| "Page keeps refreshing during pension sign-in" | `pension.ts` poll loop is running readBalances on the login URL. Check `onLoginPage` regex matches the live URL |
| "Bank balance projection looks too sunny" | Check `bankProjectionBlock` is using `expectedFixedThisCycle` (full commitments, not remaining) |
| "Headline ≠ Fixed bills page total" | Same fix — both should use `expectedFixedThisCycle` |
| "Loans page shows duplicates after re-sync" | `repo.upsertBankLoan` keys on (connection_id, external_id). Check the scraper is returning a stable externalId |
| "`→ Loan name` chip / new column not showing in React UI" | Did you add it to `TXN_COLS` in `repo.ts`? The bare-SELECT strips anything not listed |
| "BuyMe synced wrong account silently" | Persistent cookies hit fastpath. Check the `last-email` marker — see § Voucher scrapers |
| "HTZ sync hangs forever" | Cloudflare interstitial. Confirm `#eightDigit` wait is 90s and stealth flags are applied |

## Conventions

- **TypeScript strict mode**. No `any` without a comment explaining why.
- **JSDoc on exported functions** explaining intent (not signature).
- **In-line comments** for non-obvious branches — especially scraper
  quirks (`// FIBI's new shell sometimes nests the loans page in the
  legacy iframe …`). These comments are load-bearing for the next
  debugger.
- **Errors are values when possible.** Scrapers return
  `{success: false, errorType, errorMessage}` instead of throwing.
  Internal exceptions get caught at the runner level and turned into
  a `finish('error', message)`.
- **Best-effort never blocks.** Session saves, debug dumps, logo
  fetches all swallow errors silently with a log line — never
  propagate.
- **No auto-deploy.** Don't push to origin/main without an explicit
  "push" from the user. Netlify/Vercel-style deploy hooks aren't in
  play here, but the habit avoids surprise releases.
