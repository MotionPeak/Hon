# CLAUDE.md — Hon engineering notes

A focused map of the Hon codebase for future Claude sessions (and for me
when I open this in a month and forget how it works). This is the
**non-obvious** stuff — the why behind decisions that would otherwise
look strange. The README covers what Hon does and how to run it.

---

## Architecture at a glance

```
┌────────────────────────────────────────────────────────┐
│   Browser (your default)                               │
│   http://127.0.0.1:<port>/#token=<uuid>                │
│   ↓ fetches single-page app                            │
│   sidecar/public/app.html  (one HTML file, ~10k lines) │
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

## The web app — `public/app.html` (one file, ~10k lines)

Single-page, no build step. Vanilla JS + inline CSS, served straight by
the engine. Module split is on the TODO list.

### State

`window.state` is the source of truth — see `state = { … }` near line
2000. Mutate state, then call `render()` to re-paint.

Key shapes:

- `transactions` — every txn ever fetched (joined via `txn_effective`
  view that applies refund links + Splitwise offsets).
- `connections` / `accounts` / `vouchers` / `loans` / `assets` — the
  account graph.
- `categorySplits` — `{ category: N }` where N is "I pay 1/N of every
  charge in this category" (roommates).
- `merchantFreq` — `{ merchantKey: "monthly"|"bimonthly"|"yearly" }`
  user-set frequency for recurring detection.
- `incomeOverride` — manual override for the cycle's expected income.
- `monthlySavings` — `{ "YYYY-MM": { amount, transferred } }`.

### The cycle model

A cycle is a calendar month (with custom `settings.monthStartDay` start
day). `cycleKey(date)` returns `"YYYY-MM"`. `currentCycleKey()` is
`today`. All budget math is per-cycle.

### The budget projection (`budgetProjection()`)

Computes:
- `expectedIncome` — manual override or computed from recurring inflows
- `expectedFixed` — smoothed monthly-equivalent of recurring fixed bills
- `expectedFixedThisCycle` — full charges of bills predicted to bill in
  THIS cycle (bimonthly bills count in full when due, ₪0 when off-cycle)

Headline uses `expectedFixedThisCycle`. Fixed bills page top number
("Due this cycle") is the same number. Reconcile a discrepancy first by
checking the merchant frequencies in the Recurring tab.

### The projected-bank-balance card

`bankProjectionBlock()` computes end-of-cycle bank balance using the
USER'S mental model:

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

- `SCHEMA_VERSION` lives in `db.ts`. Migrations run in order on every
  start. Adding a column = new migration; never edit a prior one.
- All access via the `Repo` class (no direct `db.prepare` outside
  `repo.ts`). Methods are typed end-to-end.
- The `txn_effective` view is the canonical transaction read — applies
  refund offsets + Splitwise reductions inline so callers don't have to.

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
