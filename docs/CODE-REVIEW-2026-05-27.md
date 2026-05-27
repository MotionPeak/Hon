# Hon — Code Review Findings

**Review date:** 2026-05-27
**Branch reviewed:** `main` (worktree: `code-review-2026-05-27`)
**Method:** parallel multi-agent audit using the superpowers `code-review` skill (5 angles × Phase-1/Phase-2/Phase-3) plus Vercel React best-practice rules. Four agents reviewed in parallel: backend correctness, React app, security & cross-cutting concerns, structure & redundancy.

---

## How to use this document

This is a feedable review report — paste the relevant section into any future Claude/Cursor/Codex session as the source of truth for what needs fixing. Findings are ranked most-severe first within each section. Every finding cites a concrete `path:line`, names the failure scenario, and proposes a specific fix.

**Suggested workflow:**
1. Skim **§1 Executive summary** to see the top issues.
2. Pick a severity tier and feed that section to a focused session for execution (e.g. "fix every HIGH finding in this document").
3. Use **§6 Component splits** as a multi-PR refactor plan.
4. Treat **§9 Intentional patterns** as a safety net so the next agent doesn't "fix" the legacy SPA's custom-event nav, the 250ms DelayedLoader, the BANK_SESSION_DENYLIST entry for Max, etc.

**Project conventions to preserve:** TypeScript strict; errors as values; best-effort never blocks; never log credential VALUES (field names only); `TXN_COLS` in `repo.ts` must include every column the UI reads.

---

## 1. Executive summary

### What's healthy

- Strong security posture overall: loopback bind, token-in-URL-fragment, AES-256-GCM with auth-tag verification, fully parameterized SQL, credential-value logging discipline holds across the tree.
- Two-UI migration is structurally complete: every legacy SPA tab is ported to React; the engine just needs to be re-wired to serve `web/dist`.
- 54 sidecar tests + extensive web-side Vitest coverage. Test infra (`installFetchMock`) is solid.
- Type mirroring between engine and web is remarkably tight — only one real drift (`TxnRow.loanId`, see §7).

### What needs attention (top issues)

| # | Severity | Where | What |
|---|---|---|---|
| 1 | HIGH | `sidecar/src/server.ts:135-142, 192-207` + `sidecar/src/logos.ts:107-129` | `/logo/:companyId` is unauthenticated AND has a path-traversal hole when `?domain=` is supplied — the `companyCatalog` whitelist is skipped inside `if (!domain)`. Any browser tab on the machine can write attacker-controlled bytes to arbitrary paths under `<dataDir>` and trigger reflective SSRF. |
| 2 | HIGH | `sidecar/src/llm.ts:556-593` | LLM provider API keys (Groq/OpenAI-compatible/Ollama) are written **plaintext** to `<dataDir>/llm-provider.json`. Every other Hon secret goes through the vault; this one is the lone holdout. |
| 3 | HIGH | `sidecar/src/server.ts:907-923` | `DELETE /splitwise/expense/:id` returns `{ok:true}` when the vault is locked, silently orphaning the remote Splitwise expense while removing the local link. The user sees success; their roommates keep seeing the bill. |
| 4 | HIGH | `sidecar/src/repo.ts:1387-1402` + `sidecar/src/server.ts:582-587` | `applyMerchantRule` is `UPDATE transactions SET category=? WHERE description=?` with NO `AND category IS NULL` clause — re-categorizing a Wolt charge with "apply to merchant" silently wipes every previously hand-categorized Wolt transaction. |
| 5 | HIGH | `sidecar/src/runner.ts:151-167` | OTP wait has no timeout. Abandoned OTP sessions leak a Puppeteer browser per attempt — a long-running sidecar plus repeated abandoned syncs eventually exhausts memory. |
| 6 | HIGH | `sidecar/src/vault.ts:111-113` | scrypt uses Node defaults (N=2^14). OWASP 2024 minimum is N=2^17. With an offline copy of `hon.db`, low-entropy passphrases crack in hours on commodity hardware. |
| 7 | HIGH | `sidecar/src/runner.ts:74-104` | No per-connection scrape lock. Two browser tabs (or a stuck poll) can start parallel scrapes for the same bank, racing on the persistent Chrome profile and corrupting saved session cookies. |
| 8 | HIGH | `web/src/overview/OverviewView.tsx:180-193` | `Detail` sub-component defined INSIDE `BankProjection` — Vercel `rerender-no-inline-components`. New component identity every render destroys child state and re-fires animations. |
| 9 | MEDIUM × 7 | `web/src/{accounts,activity,insights,recurring,subscriptions,overview}/*.tsx` | Heavy derivations (`new Map(...)`, `filter().sort()`, per-category buckets) run on every keystroke in the search input across every large view. Same fix shape: wrap in `useMemo`. Insights' `MonthDetail` is the heaviest. |
| 10 | DEAD CODE | `electron/` + `.github/workflows/release.yml` | Mac/Electron app was removed 2026-05-23 but the `electron/` tree (453 lines), the release workflow (92 lines), and 80+ lines of README still pitch the desktop wrapper. Net deletion: ~625 lines + workflow. |

### Statistics

- **97 source files**, **~39,700 lines** total (excluding `node_modules`, `dist`, lockfiles).
- **17 files over 500 lines**; **7 over 1,000 lines**.
- **The single biggest file is `sidecar/public/app.html` (10,428 lines)** — already obsolete; the React app has structural parity, just needs to be wired to `/`.
- **0 real TODO/FIXME/XXX markers** in the tree. One false positive (`XXX` in a JSDoc phone-number example).
- **0 unused npm dependencies.**

---

## 2. CRITICAL & HIGH-severity findings (must-fix)

### H-1 · `/logo/:companyId` — unauth path traversal + SSRF amplification
**Files:** `sidecar/src/server.ts:135-142, 192-207`; `sidecar/src/logos.ts:107-129`

**What.** The bearer-token `onRequest` hook exempts every URL starting with `/logo/`. The handler validates `companyId` against `companyCatalog()` ONLY when `?domain=` is absent — when the caller supplies `?domain=`, the catalog check is skipped. `companyId` then flows straight into `join(<dataDir>/logos, \`${companyId}.img\`)` AND `${companyId}.type` — both for read AND `writeFileSync`.

**Why.** Any browser tab on the same machine (a phishing page, an opened email link, an extension) can issue `GET /logo/..%2F..%2Ffoo?domain=evil.example.com`. Fastify decodes the percent-encoded slashes; the route resolves outside `dataDir/logos/`; attacker-controlled bytes (the fetched "logo") get written there. Even without traversal, the route is a reflective SSRF: a malicious tab triggers Hon's outbound `fetch()` to attacker hosts, with Hon's IP as the source. Loopback-only mitigates remote exploitation but does NOT mitigate same-origin tab → loopback traffic.

**Fix.** Three layers:
1. Drop the `if (!domain)` bypass; always require `isSupportedCompany(companyId)`. SnapTrade brokerage logos that need `?domain=` get a separate `/snaptrade-logo/<slug>` route with its own allowlist.
2. Apply a strict regex inside `getLogo`: `/^[A-Za-z0-9_-]{1,40}$/`.
3. Require the token on `/logo/*` like every other API route. The "`<img>` tags can't send `Authorization`" excuse is solved by passing the token via query string for logo URLs only (low entropy is fine — they're already gated by the loopback bind), or by embedding logos as data URLs at fetch time.

### H-2 · LLM provider API keys stored plaintext on disk
**File:** `sidecar/src/llm.ts:556-593`

**What.** `LlmManager.persistProvider()` writes `{ ollama: {apiKey, ...}, api: {apiKey, ...} }` to `<dataDir>/llm-provider.json` as plaintext JSON. The vault has `saveSecret`/`loadSecret` that would encrypt these under the user's passphrase, but the LLM provider is the lone holdout.

**Why.** A Groq/OpenRouter/OpenAI-compatible API key is a billable secret. Anyone with read access to `dataDir` (a Time Machine backup, an iCloud Drive sync, a coworker borrowing the laptop unlocked) gets the key. Every other Hon secret — bank creds, SnapTrade user secret, Shufersal phone, BuyMe email — passes through the vault. The pattern of `getStatus()` never echoing keys back to the API implies the design intent was to keep them secret; disk storage contradicts that intent.

**Fix.** Move the persisted provider blob into the vault: `vault.saveSecret('llm-provider', JSON.stringify({mode, ollama, api}))`. Gate `setProvider`/`restoreProvider` on `vault.unlocked`. Delete `<dataDir>/llm-provider.json` on first vault unlock. For startup before unlock, restore the active `mode` but leave credentials blank until unlock.

### H-3 · Splitwise delete silently orphans remote expense when vault locked
**File:** `sidecar/src/server.ts:907-923`

**What.** `DELETE /splitwise/expense/:transactionId` reads `acct = loadSplitwiseAccount()`. When the vault is locked, `loadSplitwiseAccount()` returns null. The check `if (link && acct)` is then false; the upstream Splitwise DELETE is skipped; `repo.deleteSplitwiseLink(transactionId)` runs unconditionally; the response is `{ok: true}`.

**Why.** The user clicks "remove from Splitwise", sees success, and the Hon link goes away — but the Splitwise expense itself stays live for every other split participant. They keep seeing the bill on their side. The comment on line 905 promises "the local link is kept when the Splitwise delete fails, so the user can retry"; the locked-vault case violates that promise without surfacing an error.

**Fix.** Treat a locked vault as any other delete failure:
```ts
if (link && !acct) return reply.code(409).send({ error: 'unlock the credential vault to delete the linked Splitwise expense' });
```

### H-4 · `applyMerchantRule` clobbers hand-categorized transactions
**Files:** `sidecar/src/repo.ts:1387-1402`; `sidecar/src/server.ts:582-587`

**What.** `applyMerchantRule(description, category)` runs `UPDATE transactions SET category=? WHERE description=?` — no `AND category IS NULL` clause. `applyCategory` (the sibling helper) DOES narrow that way; `applyMerchantRule` does not.

**Why.** A user has 100 "Wolt" transactions: 80 auto-categorized as Dining, 20 hand-categorized as Groceries (Wolt for grocery delivery). Later they re-categorize ONE new Wolt charge to Dining with `applyToMerchant=true`. Every "Wolt" transaction — including the 20 hand-categorized as Groceries — flips back to Dining. Hand-curated categorization is silently wiped.

**Fix.** Narrow to `WHERE description = ? AND category IS NULL`, matching `applyCategory`'s shape. OR: surface a confirmation in the UI that "Apply to all merchants" overrides existing classifications.

### H-5 · OTP wait has no timeout — Puppeteer leak per abandoned sync
**File:** `sidecar/src/runner.ts:151-167`

**What.** `requestOtp` returns a Promise that resolves only when the user POSTs `/scrape/:runId/otp`. If the user closes the web app (or never enters the code), the underlying Puppeteer browser stays open and the scrape never finishes. `finish()` clears the resolver but only runs when execute() completes — which it can't, because it's awaiting the OTP.

**Why.** Long-running sidecar + repeated abandoned syncs → memory growth + a Chrome process per abandoned attempt → eventual OS-level kill. The voucher OTP routes have the same shape but are gated by the interactive scraper's own timeouts.

**Fix.** Wrap the OTP wait in `Promise.race(resolverPromise, new Promise((_,rej) => setTimeout(() => rej(new Error('otp.timeout')), 5*60_000)))`. The existing `catch` closes the browser and reconciles the run.

### H-6 · scrypt cost parameters below OWASP 2024 guidance
**File:** `sidecar/src/vault.ts:111-113`

**What.** `scryptSync(passphrase, salt, 32)` with no cost params — Node defaults are `N=2^14, r=8, p=1, maxmem=32MB`. OWASP 2024 recommends `N=2^17` for interactive logins.

**Why.** A leaked `hon.db` plus salt + verifier lets an attacker run offline brute force. At `N=2^14`, a midrange GPU does ~10^5 guesses/sec. At `N=2^17` that drops 8× and rises with custom hardware cost. For a personal-finance vault that lives at `~/Library/Application Support/Hon/` and may end up on a Time Machine backup, this is the load-bearing protection.

**Fix.** `scryptSync(passphrase, salt, 32, { N: 1<<17, r: 8, p: 1, maxmem: 256*1024*1024 })`. Migration path: on first unlock with the old salt, transparently re-derive at the new cost when the old verifier matches, then re-encrypt the verifier under the new parameters. Or version the salt prefix (`v2:<salt>`) so old vaults read at old cost and new ones at new cost.

### H-7 · No per-connection scrape lock — parallel scrapes race on browser profile
**Files:** `sidecar/src/runner.ts:74-104`; `sidecar/src/server.ts:260-293`

**What.** `runner.start()` always creates a new `runId` and kicks off the scrape; it does NOT check whether the same `connectionId` is already running. The web app prevents double-clicks, but two browser tabs (or a stuck poll) can trigger two parallel scrapes for the same bank, using the same browser-profile dir, the same persistent cookies, the same OTP resolver state.

**Why.** Two parallel pension scrapes for, say, Meitav, race on `<dataDir>/browser-profiles/meitav/` — Chrome's `SingletonLock` causes the second to fail noisily; worse, two Puppeteer instances can simultaneously write/read cookies in the same profile, corrupting the saved session. Two parallel bank scrapes can double-write txns or hit UNIQUE constraint errors. OTP path: `submitOtp(runId)` resolves only one resolver; the second run is orphaned.

**Fix.** Add `private active = new Set<string>()` in `ScrapeRunner`. In `start()`, check `if (this.active.has(connectionId)) return reply.code(409).send({ error: 'scrape already in progress' });`. Clear on terminal status.

### H-8 · `Detail` component defined inside `BankProjection`
**File:** `web/src/overview/OverviewView.tsx:180-193`
**Rule:** Vercel `rerender-no-inline-components`

**What.** Arrow component `Detail` declared in the body of `BankProjection`, so a brand-new component reference is created every render of the parent.

**Why.** Every parent re-render unmounts and remounts each `Detail` instance. Any local state, focus, or DOM identity is destroyed; CSS animations on `.balance-detail-amt` re-fire. Canonical React anti-pattern.

**Fix.** Hoist `Detail` to module-level (same scope as `BalanceCard`, `BankProjection`). It already receives everything via props.

### H-9 · LLM `load()` racing — startup `restoreState` + user-triggered download can double-allocate
**File:** `sidecar/src/llm.ts:535-554, 575-579`

**What.** `load()` checks `state === 'ready' && this.model` and returns early; otherwise it sets state to 'loading' and proceeds. `restoreState()` calls `void this.load()` at startup (fire-and-forget). If the user then triggers `POST /llm/download` immediately on startup, `runDownload` → `load()` races with the constructor's load. Both callers see `state` mid-flip and both proceed past the early-return, calling `loadModel()` twice.

**Why.** Double-load wastes memory; one of the two assignments to `this.model` wins arbitrarily — the loser's `LlamaModel` is unreferenced but still mapped until GC. On a 16 GB machine loading a 7 GB Dicta model, this can OOM the engine.

**Fix.** Cache the in-flight promise:
```ts
private loadingPromise: Promise<void> | null = null;
async load() {
  if (this.status.state === 'ready' && this.model) return;
  if (this.loadingPromise) return this.loadingPromise;
  this.loadingPromise = this._load().finally(() => { this.loadingPromise = null; });
  return this.loadingPromise;
}
```
Apply the same pattern to `loadRates()` in `fx.ts:18-31` (same race shape).

### H-10 · `/transactions/:id/loan` PATCH returns ok for nonexistent transaction
**Files:** `sidecar/src/server.ts:1631-1645`; `sidecar/src/repo.ts:1855-1862`

**What.** Server handler validates the loan id exists (when not null) but never checks the transaction id. `setTransactionLoan(txnId, loanId)` runs `UPDATE … WHERE id = ?` — zero rows update and the API responds `{ok: true, loanId}`. Sibling routes (`/transactions/:id/category`, `/transactions/:id/link`) DO check first.

**Fix.** `if (!repo.getTransaction(id)) return reply.code(404).send({ error: 'transaction not found' });` before the call.

### H-11 · `/snaptrade/done` unauthenticated route — fingerprintable, extension surface
**File:** `sidecar/src/server.ts:138-139, 388-403`

**What.** The auth hook also exempts `/snaptrade/done`. Body is static today, but the route lets any tab confirm Hon is running on a port. Any future enrichment of this page (rendering `?status=`, fetching run state) will inherit the gap.

**Fix.** Either gate behind the token like everything else, or document this in an explicit allowlist constant (`const PUBLIC_ROUTES = ['/', '/health', '/snaptrade/done']`) so future contributors don't silently extend the exemption.

### H-12 · `BANK_SESSION_DENYLIST` test: confirmed Max is denylisted ✓ (no change)
This is a positive: verified the denylist still contains `'max'` per CLAUDE.md note. Don't remove. If you ever observe `library.progress type=LOGGING_IN` never reaching `LOGIN_SUCCESS` for a new bank, that's the symptom that means it should join the denylist.

---

## 3. MEDIUM-severity findings (sorted by impact)

### Backend correctness

| # | Where | What | Fix |
|---|---|---|---|
| M-B1 | `sidecar/src/server.ts:438, 462, 478` | PATCH /accounts/:id/* uses `repo.listAccounts().some(...)` — full table scan + materialization + linear search per balance edit. | Add `repo.getAccount(id)` with `SELECT … WHERE id = ? LIMIT 1` and use it. |
| M-B2 | `sidecar/src/splitwise.ts:297-343` | `attributePayments` issues one `get_expenses?limit=100&dated_after=…` — no pagination. Users with >100 settle-up payments silently undercount. | Loop with `offset += 100` until a page returns <100 items. Cap at 500 to bound a hostile reply. |
| M-B3 | `sidecar/src/server.ts:2024-2037` | `PUT /budgets` collapses `monthlyAmount: 0`, `-5`, `"abc"`, and missing into "delete" — three intents map to one outcome with no error. | Explicit `null`/missing → delete; finite ≥ 0 → set; anything else → 400. Match `/budget/income-override`. |
| M-B4 | `sidecar/src/repo.ts:2171-2188` | `deleteCategory` reassigns transactions/category_cache/merchant_rules to 'Other' but does NOT touch `category_splits` — stale split rows remain. | `DELETE FROM category_splits WHERE category = ?` inside the same transaction. |
| M-B5 | `sidecar/src/repo.ts:663-721` | `summary()` merges asset/voucher totals into per-currency bucket but never bumps `accountCount`. Per-currency row can show "0 accounts" alongside "$5000 net worth". | Bump `accountCount` on merge, or rename to `entryCount`. |
| M-B6 | `sidecar/src/repo.ts:1991-2019` | `createLoan` backfills every loan_id=null negative transaction for the connection (12 months) — synchronous in the API request. Large connections cause seconds-long POST hangs. | Defer backfill to `void` after the response, or restrict to scrape-time only. |
| M-B7 | `sidecar/src/server.ts:1894-1902` | `/vehicle/:plate` swallows all errors as 502 — `lookupVehicle` only throws on real network errors, but the 502 response gives no diagnostic. data.gov.il rotates `RESOURCE_ID`s; failures hide as transient. | `log.warn('vehicle.lookup.failed', { plate, err: String(e) })` before returning the 502. |
| M-B8 | `sidecar/src/otp.ts:299-328` | OTP DOM dump written to hardcoded `/tmp/hon-otp-inputs.json` ("Removed once the matcher is solid"). `/tmp` is world-readable on macOS; reveals which bank + 2FA flow. | Either delete the dump (matcher is in production) or move to `join(dataDir, 'debug', 'otp-inputs.json')`. |
| M-B9 | `sidecar/src/runner.ts:125-136` | `chooseStartDate` doesn't bound future-dated `lastSuccessfulScrapeAt` (DST drift + system-clock rewind during a sync). | `if (since > new Date()) since = new Date();` after parse + subtract. |
| M-B10 | `sidecar/src/db.ts:215-217` | Migration 13 (`UPDATE transactions SET external_id = external_id || ':' || date`) is not idempotent if a future "reset migrations" script ever runs. | `WHERE external_id NOT LIKE '%:____-__-__'`. Defense in depth on every data-mutating migration. |
| M-B11 | `sidecar/src/llm.ts:367-392` | `setProvider` asymmetric: empty `baseUrl` wipes stored URL but empty `apiKey` does not (different normalize paths). | Treat empty string as "keep stored" symmetrically, OR document that empty = explicit clear and have the web app send `undefined`. |
| M-B12 | `sidecar/src/server.ts` (no top-level handler) | No `process.on('unhandledRejection')` or `process.on('uncaughtException')`. A bug anywhere in a fire-and-forget path takes down the whole sidecar with no log line. | Add top-level handlers that `makeLog('process')` and `shutdown('uncaught')`. |
| M-B13 | `sidecar/src/db.ts:680-685` | Migrations run inside a single SQLite transaction (good), but there's no automated backup of `hon.db` before a migration. A runtime constraint failure leaves the user with a partially upgraded DB and no recovery path. | Before applying any migration when `current < SCHEMA_VERSION`, `VACUUM INTO 'hon.db.backup-pre-v<current>'`. Keep N most recent. |
| M-B14 | `sidecar/src/vault.ts:64-66` | `lock()` sets `this.key = null` but doesn't zero the buffer first. A heap inspection between lock and GC can recover the AES key. | `this.key.fill(0)` before nulling. |

### React app

| # | Where | What | Fix |
|---|---|---|---|
| M-R1 | `web/src/accounts/AccountsView.tsx:170-190` | `storageTick` dummy state with `void storageTick;` to force re-renders. Reading mutable localStorage during render couples invisibly. | Lift unseen-loan-id queue into React state: `useState<string[]>([])` synced via the same event listener; localStorage as persistence only. |
| M-R2 | `web/src/insights/InsightsView.tsx:600-663` | `MonthDetail` rebuilds `cycleIdx`, `byCatCycle`, `avgByCat`, `inMonth`, `byCat`, `biggest`, `rows`, `max`, `categoryByName` every render. O(txns × months). | Each derived structure in its own `useMemo` keyed by real inputs. Best: extract `useMonthDetail({ transactions, months, monthStartDay, monthKey })` hook. |
| M-R3 | `web/src/activity/ActivityView.tsx:121-159` | Every keystroke in the search input rebuilds `accountById = new Map(...)`, `categoryByName = new Map(...)`, `searchResults`, `monthTxns`, `grouped`, `orderedCats`. | `useMemo` on each. The two Maps are particularly cheap wins. |
| M-R4 | `web/src/accounts/AccountsView.tsx:522-548` | `renderSectionItems` does `data.connections.filter(... companies.find ...)` for every section on every render — O(connections × companies × sections). `ConnectionCard` repeats `data.accounts.filter(...)`. | Hoist: `companyById = useMemo(() => new Map(companies.map(c => [c.id, c])), [companies])` and similar for `accountsByConnectionId` and `connectionsBySection`. Pass into helpers. |
| M-R5 | `web/src/insights/InsightsView.tsx:282-482` | `BrokerageSubTab` rebuilds `dailyTotals`, `fullSeries`, `cutoff`, `series`, reduces, `oneYearPoint`, `currencies`, `holdings.sort/map`, plus `ValueChart` min/max — all every render. | Memoize per real input set. Range buttons should trigger targeted recompute. |
| M-R6 | All large views | Every view-level fetch (`/transactions`, `/accounts`, `/companies`, `/categories`, `/loans`, `/brokerage`) refetches on tab switch. Tab keyed by `App.tsx`'s active state = remount. | Lift into a shared cache: React Context next to `SettingsProvider`, or a small `useSyncExternalStore` module with a `refresh()` mutator and category-aware invalidation. |
| M-R7 | `web/src/recurring/RecurringView.tsx:184` | `byCat`, `catOrder`, `grandMonthly`, `catByName` rebuilt every render despite only depending on `rows + data.categories`. | `useMemo` each. |
| M-R8 | `web/src/subscriptions/SubscriptionsView.tsx:139-152` | `detect()` + `bucket()` called in render body. | `useMemo`. |
| M-R9 | `web/src/overview/OverviewView.tsx:161-167` | `BankProjection` rebuilds `bankCompanyIds = new Set(...)` + `bankAccounts = accounts.filter(...)` every render. `EssentialsCard` re-sorts `essentials` every render. | `useMemo`. |
| M-R10 | `web/src/activity/ActivityView.tsx:25-42` | `txnMatchesSearch` runs `parseFloat(q.replace(/[^0-9.\-]/g, ''))` per transaction per keystroke — the parse depends only on `q`. | Compute `const num = parseFloat(...)` once outside the filter loop; pass in alongside `q`. |
| M-R11 | `web/src/settings/AiEngineCard.tsx:74-76` | Mode toggle does `setStatus({ ...status, mode })` — no `/llm/mode` PUT. A poll during download will overwrite the mode and snap the user back. | Either: (a) split UI mode into its own `useState<LlmMode>` initialised from `status.mode` used only for rendering, OR (b) PUT the mode to the engine on toggle. |
| M-R12 | `web/src/vouchers/VouchersView.tsx:621-635` | Polling effect's `setInterval` keeps firing `tick` even after `if (s.finished) return;` — only unmount clears it. Idle on a finished sync dialog = hit engine every 1.5s indefinitely. | When `s.finished`, also `clearInterval(handle)` (move handle into a ref so inner closure can reach it). |
| M-R13 | `web/src/vouchers/VouchersView.tsx:670-677` | `eslint-disable-next-line react-hooks/exhaustive-deps` hides a real stale-closure pattern. Works today because of `autoStartedRef.current` gating, but future contributors may break it. | Replace with `useEvent`-style ref pattern: `const startRef = useRef(start); useEffect(() => { startRef.current = start; }); useEffect(() => { ... startRef.current(); }, [autoStart, credentialLoaded, credential, syncId])`. |
| M-R14 | `web/src/settings/BillingCycleCard.tsx:23-31` | Hand-rolled dropdown lacks Escape-to-close (a11y regression vs Radix everywhere else). | Replace with `@radix-ui/react-dropdown-menu` (already a dep) or add `keydown` Escape handling. |
| M-R15 | `web/src/insights/InsightsView.tsx:200-209` | `cards.map((c, i) => <li key={i}>...)` — AI insight cards keyed by index. Regenerate may not retrigger entry animations. | `key={\`${c.kind}:${c.text}\`}`. |
| M-R16 | All views | No `AbortController` on any view-level fetch. Strict-mode double render + a slow fetch can fire `setData` on an unmounted component. | Extract `useApi<T>(path, deps)` hook with `AbortController` + a not-current-anymore guard. |
| M-R17 | All views | Fetch failure paths do `setData(empty)` — user can't distinguish "no data" from "engine unreachable". | Track `error` state separately; render an error banner distinct from the empty state. |

### Security & cross-cutting

| # | Where | What | Fix |
|---|---|---|---|
| M-S1 | `sidecar/src/splitwise.ts:64-72`, `sidecar/src/fx.ts:21` | Outbound `fetch()` with no timeout — stalled remotes hang the engine. Every other outbound call has a timeout. | Wrap in `AbortSignal.timeout(15_000)`. |
| M-S2 | `sidecar/src/logos.ts:51, 72` + others | `await res.text() / arrayBuffer() / json()` with no size cap. A hostile remote can return GBs and OOM the engine. Combined with H-1, an unauthenticated tab can trigger this. | Add `safeFetchBytes(res, maxBytes)` helper streaming via `res.body?.getReader()` with abort on cap. Apply to `logos.ts` (2 MB) and `llm.ts` API/Ollama (8 MB). |
| M-S3 | `sidecar/web.mjs:113` (Windows path) | `spawn(\`start "" "${url}"\`, { shell: true })` — token + port are generator-safe today but the pattern is fragile to future regressions. | `spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })` — no `shell:true`. |
| M-S4 | `sidecar/public/app.html:2075` (`esc()` helper) | `esc()` replaces `& < > "` only — not `'` or backtick. Today all `innerHTML` use is double-quoted, so missing single-quote escape is benign. Single-quoted attrs in future code = injectable. | Extend `esc()` to also replace `'` and backtick. Or wait for the SPA to retire. |

---

## 4. LOW-severity findings (nice-to-have)

| # | Where | What |
|---|---|---|
| L-1 | `sidecar/src/loanMatcher.ts:25-31` | `nameTokens` filters length < 3. Hebrew loan names ("רכב") may be 2-3 chars. Consider dropping to length ≥ 2 OR skipping the filter for Hebrew. |
| L-2 | `web/src/piggy/PiggyView.tsx:279-286` | `useState(formFor(bank))` evaluates `formFor` eagerly every render. Use lazy initialiser: `useState(() => formFor(bank))`. |
| L-3 | `web/src/accounts/AccountsView.tsx:442-460` | Deeply-nested IIFE inside JSX. Extract `useMemo(() => Object.entries(syncStates).find(([, s]) => s.kind === 'needs-otp'), [syncStates])`. |
| L-4 | `web/src/insights/InsightsView.tsx:443` | `const palette = [...]` defined inside a `.map` callback. Hoist to module scope. |
| L-5 | `web/src/insights/InsightsView.tsx:117-123`, `web/src/recurring/helpers.ts` | RegExp literals inside hot paths — V8 caches them but module-level constants are cleaner. |
| L-6 | `web/src/loans/LoansView.tsx:40-43` | Unseen-loan clear effect dispatches a custom event even when there's nothing stored. Guard `if (window.localStorage.getItem('hon.unseenLoanIds'))`. |
| L-7 | `web/src/App.tsx:85-91` | `useLayoutEffect` for pill positioning only reruns on `tab` — viewport resize causes drift. Add `ResizeObserver` if resilience wanted. |
| L-8 | `web/src/insights/InsightsView.tsx:271-280` | `pickDisplayCurrency` defaults to `'USD'` when no holdings. Default to `'ILS'` for consistency. |
| L-9 | `web/src/overview/OverviewView.tsx:173` | `variable.piggyFunded ?? 0` — type says non-optional. Update type to `piggyFunded?: number` OR drop the `?? 0`. |
| L-10 | `web/src/overview/OverviewView.tsx:47-61` | Per-resource `.catch(() => [])` swallows individual fetch failures (e.g. a 401 on `/companies`). Surface error per resource. |
| L-11 | `web/src/App.tsx` | All 10 tab views + Radix Dialog/Dropdown are eagerly imported. For a local-first app served by sidecar this isn't critical but `React.lazy` + `<Suspense fallback={<DelayedLoader />}>` per tab is a free win once `web/dist` ships at `/`. |
| L-12 | `sidecar/src/voucherScrapers.ts:688-694` | BuyMe `last-email` marker only written on success — cancel-mid-OTP edge case is robust today; flag with a comment so the invariant is documented. |
| L-13 | `sidecar/web.mjs:60-79` | Dev token never rotates; no UI to regenerate. A leaked URL recording = permanent token leak (loopback-scoped, but co-resident processes still). Add `POST /token/rotate` + Settings button. |
| L-14 | `sidecar/src/server.ts:318-330` | `shortId()` uses ~13 chars base36 (~65 bits effective, lower with timing). Local-only so practically fine, but `randomUUID()` is one line. |

---

## 5. File-size & structure overview

```
File                                            Lines    Notes
------------------------------------------------------------------------------
sidecar/public/app.html                        10,428   legacy SPA — retire (see §6.2)
sidecar/src/server.ts                           2,291   100 Fastify routes (§6.1)
sidecar/src/repo.ts                             2,261   110 DB methods (§6.3)
sidecar/src/pension.ts                          1,715   6 pension scrapers (§6.4)
web/src/accounts/AccountsView.tsx               1,580   (§6.6)
sidecar/src/voucherScrapers.ts                  1,476   3 voucher scrapers (§6.5)
web/src/activity/ActivityView.tsx               1,105   (§6.7)
web/src/vouchers/VouchersView.tsx                 939   (§6.8)
web/src/insights/InsightsView.tsx                 797   (§6.9)
sidecar/src/bankLoans.ts                          792   (§6.12)
sidecar/src/db.ts                                 692   (§6.13)
sidecar/src/scrapers.ts                           688   (§6.14)
sidecar/src/snaptrade.ts                          667   (§6.15, optional)
sidecar/src/llm.ts                                615   (§6.16, optional)
web/src/piggy/PiggyView.tsx                       542   (§6.10, optional)
sidecar/src/runner.ts                             537   keep — cohesive state machine
sidecar/src/otp.ts                                527   keep — cohesive subsystem
web/src/settings/AiEngineCard.tsx                 462   (§6.11)
```

---

## 6. Component / file split recommendations

The goal is to make each file fit the rule of "I can hold this file's purpose in my head". Below are concrete split plans. Splits are not blocking the H-tier fixes; do them as separate PRs.

### 6.1 `sidecar/src/server.ts` (2,291 → ~250 + 18 route files)

Route groups break cleanly along URL prefix. Each module exports `register(app, ctx)`:

```
sidecar/src/routes/
  vault.ts          (~60)  L160-180
  connections.ts    (~180) L184-285
  scrape.ts         (~120) L260, L295, L318
  snaptrade.ts      (~150) L335-405
  accounts.ts       (~150) L405-485 + /brokerage
  transactions.ts   (~280) L485-745
  splitwise.ts      (~270) L776-925
  assets.ts         (~100) L931-1010
  vouchers.ts       (~580) L1011-1580
  loans.ts          (~210) L1601-1800
  categories.ts     (~90)  L1814-1900
  vehicle.ts        (~30)  L1894
  llm.ts            (~140) L1904-1970
  categorize.ts     (~60)  L1972-1980
  budget.ts         (~150) L1983-2090
  piggy.ts          (~140) L2097-2185
  insights.ts       (~30)  L2189-2200
  subscriptions.ts  (~50)  L2204-2240
serverBootstrap.ts  (~250) start + plugin register + auth hook + /health + /companies + /logo
```

No tests today exercise `server.ts` directly, so test churn is zero. Apply the explicit `PUBLIC_ROUTES` allowlist constant here too (H-11).

### 6.2 `sidecar/public/app.html` (10,428 → 0)

**This is the single largest cleanup the codebase will ever see.** Every tab is already in `web/`. Retirement checklist:

1. Configure `sidecar/web.mjs` to serve `web/dist/index.html` + assets when `web/dist` is present; fall back to `public/app.html` only if absent.
2. Sanity-check each tab visually against the SPA.
3. Delete `sidecar/public/app.html`.
4. Delete `sidecar/public/` if no other static assets remain.
5. Strip the chat-LLM placeholder hint at app.html L2991 — not yet ported (chat UI doesn't exist in either UI; that's a future feature).

### 6.3 `sidecar/src/repo.ts` (2,261 → 10 domain repos + aggregator)

The duplication here is at the FILE level, not the METHOD level. Each of the 110 methods has a distinct domain. Split:

```
sidecar/src/repo/
  base.ts                  (~80)   BaseRepo + prepare cache
  connectionsRepo.ts       (~120)
  accountsRepo.ts          (~220)
  holdingsRepo.ts          (~170)
  transactionsRepo.ts      (~340)
  splitwiseRepo.ts         (~110)
  scrapeResultsRepo.ts     (~280)
  assetsRepo.ts            (~100)
  vouchersRepo.ts          (~200)
  piggyRepo.ts             (~200)
  categoriesRepo.ts        (~300)
  budgetRepo.ts            (~200)
  metaRepo.ts              (~25)
  loansRepo.ts             (~280)
  subscriptionsRepo.ts     (~40)
  index.ts                 (~80)   aggregator class Repo with flat method shape
```

Aggregator preserves the flat `repo.listX()` shape during transition — no callsite changes. Cross-domain queries (e.g. `listLoanPayments`) keep going in the larger of the two repos.

### 6.4 `sidecar/src/pension.ts` (1,715 → 10 files)

```
sidecar/src/pension/
  types.ts          (~30)
  funds.ts          (~120) FUNDS registry + PENSION_COMPANIES + isPensionCompany + isPensionLoginUrl
  browser.ts        (~150) launchPensionBrowser + sweepStalePensionLocks + sandbox args
  dom.ts            (~400) fillField + clickByText + fillPhone + fillAndSubmitLogin + prefillCredentials + enterOtpCode + saveDebug + delay
  funds/migdal.ts   (~50)
  funds/harel.ts    (~185)
  funds/clal.ts     (~60)
  funds/meitav.ts   (~295)
  funds/menora.ts   (~50)
  funds/generic.ts  (~50)
  index.ts          (~250) runPensionScrape dispatcher + readBalances switch
```

### 6.5 `sidecar/src/voucherScrapers.ts` (1,476 → 7 files)

```
sidecar/src/vouchers/
  types.ts          (~40)
  dom.ts            (~200) clickByText + pressEnter + fillVisibleInput + tickConsentCheckbox + normalisePhone + ...
  profiles.ts       (~50)  readMarker + writeMarker + sweepStaleProfileLocks
  shufersal.ts      (~590)
  buyme.ts          (~470)
  htzone.ts         (~290)
  index.ts          (~10)
```

### 6.6 `web/src/accounts/AccountsView.tsx` (1,580 → 14 files)

```
accounts/
  AccountsView.tsx              (~580)  top-level + state + renderSectionItems + holdingStats + NewLoanBanner + NetWorthPill
  ConnectionCard.tsx            (~210)  ConnectionCard + CompanyLogo + HoldingsList
  AssetCard.tsx                 (~20)
  LoanCard.tsx                  (~30)
  modals/BalanceModal.tsx       (~55)
  modals/CredentialsModal.tsx   (~60)
  modals/AssetEditModal.tsx     (~55)
  modals/LoanEditModal.tsx      (~95)
  modals/RemoveConnectionDialog.tsx (~70)
  modals/OtpModal.tsx           (~45)
  add/AddConnectionPicker.tsx   (~100)
  add/AddConnectionForm.tsx     (~80)
  add/AddManualAssetForm.tsx    (~90)
  add/AddManualLoanForm.tsx     (~150)
```

`ModalPortal` (L55-114) → lift to `web/src/ui/ModalPortal.tsx` and share with Activity + Vouchers.

### 6.7 `web/src/activity/ActivityView.tsx` (1,105 → 6 files)

```
activity/
  ActivityView.tsx           (~430)  top-level + filters + month nav + txnMatchesSearch + fmtDate
  UmbrellaSections.tsx       (~220)  UmbrellaSections + GROUP_ORDER + CatCard + LoanChip
  CategoryPicker.tsx         (~150)  CategoryPickerSidebar
  LoansSection.tsx           (~110)
  Refund.tsx                 (~200)  RefundSection + RefundPicker
  BulkCategoryDialog.tsx     (~70)
```

### 6.8 `web/src/vouchers/VouchersView.tsx` (939 → 5 files)

```
vouchers/
  VouchersView.tsx           (~250)  page-level + helpers
  VoucherCard.tsx            (~80)
  AddVoucherFlow.tsx         (~150)  + SourcePicker
  ProviderSyncDialog.tsx     (~290)  + PROVIDER_CONFIGS + thin wrappers
  VoucherFormModal.tsx       (~100)
```

### 6.9 `web/src/insights/InsightsView.tsx` (797 → 5 files)

```
insights/
  InsightsView.tsx           (~150)  page-level + sub-tab routing
  AiAnalysisCard.tsx         (~150)  + parseInsights + AI_TAG_MAP + inferInsightKind
  BrokerageSubTab.tsx        (~250)  + RANGES + convertAmount + rangeStart + pickDisplayCurrency
  StatBox.tsx                (~100)  StatTile + DeltaChip + TrendPill
  ValueChart.tsx             (~280)  + MonthBars + MonthDetail
```

### 6.10 `web/src/piggy/PiggyView.tsx` (542 → 4 files, optional)

```
piggy/
  PiggyView.tsx              (~270)
  PiggyCard.tsx              (~115)
  PiggyFormDialog.tsx        (~110)
  DeleteConfirmDialog.tsx    (~40)
```

### 6.11 `web/src/settings/AiEngineCard.tsx` (462)

Just under threshold; optional split:
```
settings/ai/
  AiEngineCard.tsx           (~120)
  CategorizeAllPanel.tsx
  LocalModelList.tsx
  RemoteFormPanel.tsx
  format.ts                  fmtBytes
```

### 6.12 `sidecar/src/bankLoans.ts` (792 → 5 files)

```
sidecar/src/bankLoans/
  types.ts                   (~50)
  parsers.ts                 (~120)  parseMoney + parseDate + parseRate + ...
  fibi.ts                    (~270)
  hapoalim.ts                (~330)
  index.ts                   (~30)   dispatcher + supportsBankLoans
```

### 6.13 `sidecar/src/db.ts` (692 → 3 files)

```
sidecar/src/db/
  schema.ts                  (~250)  bare CREATE TABLE + SCHEMA_VERSION
  migrations.ts              (~400)  v1→v34 ladder + migrate driver
  index.ts                   (~50)   openDatabase + DbHandle + prepared statement helpers
```

### 6.14 `sidecar/src/scrapers.ts` (688 → 4 files)

```
sidecar/src/scrapers/
  types.ts                   (~150)
  catalog.ts                 (~120)
  normalize.ts               (~240)  normalizeAccount + normalizeTransaction + appendDiscountKerenKaspit + israelDate
  run.ts                     (~200)  runScrape + runInteractiveScrape
```

### 6.15 `sidecar/src/snaptrade.ts` (667)
Optional. Split into `client.ts`, `portal.ts`, `sync.ts`, `index.ts` if growing further.

### 6.16 `sidecar/src/llm.ts` (615)
Optional. Split into `catalog.ts`, `manager.ts`, `providers.ts`.

---

## 7. Redundancy & dead code

### 7.1 `electron/` — confirmed dead (RECOMMEND REMOVAL)

The Mac/Electron app was removed 2026-05-23 (per user memory). The `electron/` tree is still in the repo but is unreferenced from any runtime path:

| File | Lines |
|---|---|
| `electron/main.cjs` | 217 |
| `electron/package.json` | 22 |
| `electron/builder.yml` | 117 |
| `electron/README.md` | 93 |
| `electron/.gitignore` | 4 |
| **`electron/` total** | **453** |

Cross-references that must be removed together:
- `.github/workflows/release.yml` (92 lines) — only thing keeping `electron/` alive (runs `electron-builder` on tag push).
- `README.md` L7-11, L192, L670-674, L724-734 — five passages still pitch the Electron wrapper. ~80 lines of prose.

**Net deletion: ~625 lines of code + workflow + ~80 lines of README prose.**

CLAUDE.md and HANDOFF.md no longer mention Electron — already current.

### 7.2 Stale documentation
- `web/src/cycle.ts:1-3` — header says "Lifted from sidecar/public/app.html". Once SPA retires, strike "Lifted from".
- `web/package.json:6` — "Hon's React UI — gradually replaces sidecar/public/app.html". Same — drop the suffix after SPA retirement.
- `docs/loans-upstream-issue.md` (152 lines) — draft of an upstream issue for `israeli-bank-scrapers`. Confirm status; remove or convert to a fork-changelog.

### 7.3 Commented-out code worth removing
- `sidecar/src/bankLoans.ts:234-247` — 14 lines, 3 codey.
- `sidecar/src/bankLoans.ts:679-686` — 8 lines, 5 codey.

### 7.4 TODO / FIXME / XXX markers
**Zero real markers.** Only one match across the entire tree — `pension.ts:709` — uses `XXX` as a phone-number example in a JSDoc, not a marker.

### 7.5 Unreferenced exports (drop the `export` keyword)

Across 23 files, 65 `export` symbols are not imported anywhere else. Most are type-only exports consumed by structural typing. Worth a manual check (more likely actually dead, not type-by-shape):
- `sidecar/src/bankLoans.ts`: `scrapeFibiLoans`, `scrapeHapoalimLoans` (used only by in-file dispatcher).
- `sidecar/src/categorize.ts`: `categorizeByRule` (if no caller uses just the rule path).
- `sidecar/src/marketData.ts`: `fetchYahooHistory`, `fetchMayaHistory` (wrapped by `fetchHistoryForSymbol`).
- `sidecar/src/pension.ts`: `isPensionLoginUrl` (currently unused).
- `sidecar/src/db.ts`: `SCHEMA_VERSION` (documented but not imported — keep exported for diagnostics or drop).
- `sidecar/src/scrapers.ts`: `israelDate`, `normalizeTransaction` (internal helpers).

### 7.6 Unused npm packages
**None.** Every runtime dep in `sidecar/package.json`, `web/package.json`, and root `package.json` is imported.

### 7.7 `ModalPortal` triplication

The same `ModalPortal` shim is implemented in three places:
- `web/src/accounts/AccountsView.tsx:55-114` — full version with focus trap + ESC.
- `web/src/activity/ActivityView.tsx:13-16` — 4-line `createPortal` shim.
- `web/src/vouchers/VouchersView.tsx:78-82` — 4-line `createPortal` shim.

Lift the Accounts version to `web/src/ui/ModalPortal.tsx`; have the other two consume it.

---

## 8. Type drift between engine and web

The team mirrors types between `sidecar/src/repo.ts` and `web/src/<feature>/types.ts` (with `// Mirrors X in sidecar/src/repo.ts` headers). Drift is remarkably small:

| Type | Engine | Web | Drift |
|---|---|---|---|
| `Company` / `CompanyInfo` | `sidecar/src/scrapers.ts:32` | `web/src/accounts/types.ts:5` | **none** |
| `Connection` | `sidecar/src/repo.ts:16` | `web/src/accounts/types.ts` | **none** |
| `Account` / `AccountRow` | `sidecar/src/repo.ts:33` | `web/src/accounts/types.ts` | **none** |
| `Holding` / `HoldingRow` | `sidecar/src/repo.ts:54` | `web/src/accounts/types.ts` | **none** |
| `Transaction` / `TxnRow` | `sidecar/src/repo.ts:85` (15 fields) | `web/src/activity/types.ts` (16 fields) | **MINOR — web has `loanId`, engine doesn't** |
| `ManualAsset` | `sidecar/src/repo.ts:166` | `web/src/accounts/types.ts` | **none** |
| `Voucher` | `sidecar/src/repo.ts:131` | `web/src/vouchers/types.ts` | **none** |
| `PiggyBank` / `PiggyBankStatus` | `sidecar/src/repo.ts:207` | `web/src/piggy/types.ts` | **intentional layered type** (engine type + computed status fields) |
| `Loan` | `sidecar/src/loans.ts:26` | `web/src/accounts/types.ts` | **none semantically** (server decorations marked optional) |

**Only real drift:** `TxnRow.loanId` missing from `sidecar/src/repo.ts:85`. The engine writes `loan_id` and exposes it via `TXN_COLS` (per the `45d3ff8` commit that landed the loan-detection feature), but the canonical row type doesn't include the field. **One-line fix:** add `loanId: string | null` to `TxnRow`.

---

## 9. Intentional patterns — DO NOT "fix"

Future agents will read this codebase and want to "improve" things that are actually load-bearing. Preserve:

### Backend
- **`if (token && req.headers.authorization !== ...)` at `server.ts:140`** — when `HON_TOKEN` is empty, all routes are open. The startup guard at `server.ts:2247` refuses to bind unless a token is set OR the host is loopback. By design for the local launcher.
- **`saveScrapeResult` uses `COALESCE(excluded.balance, accounts.balance)`** — looks like "the upsert ignores the new value" but is intentional: card scrapers don't report balances and shouldn't blank the user's hand-set value.
- **`stalePending` deletes pending rows missing from the scrape (`repo.ts:908-921`)** — looks scary but is scoped to status='pending' rows in the last 90 days, where the bank dropped them.
- **`txn_effective` view recreated by Migration 24** — standard SQLite pattern when ALTERing underlying tables.
- **HTZ 90s Cloudflare wait + stealth flags (`voucherScrapers.ts:1228-1316`)** — dodging Cloudflare Turnstile. All three layers (long wait + `--disable-blink-features=AutomationControlled` + `navigator.webdriver` override) must stay.
- **Harel iframe match `digital\.harel-group\.co\.il` (`pension.ts:1166`)** — the looser `client-view|digital.harel` from before matched the host page. The specific regex is correct.
- **Meitav login-loop regex `login/signin/auth/otp/verify/sso` (`pension.ts:262`)** — covers all the login URL shapes that yank the user off mid-typing.
- **BuyMe identity-scoped cookie profile reset (`voucherScrapers.ts:688-694`)** — wipes profile when stored email differs from new email. Pattern is reusable for any cookie-fastpath scraper that's identity-scoped.
- **`BANK_SESSION_DENYLIST = new Set(['max'])`** — Max hangs when cookies pre-authenticate it past the login form the library is waiting for.
- **`CARD_COMPANIES = {max, visaCal, isracard, amex}` skip incremental scrape** — their "balance" is the next-bill outstanding computed from the FULL set of charges.
- **Logger truncates long values to 240 chars** — prevents accidental credential leak via stack traces or HTML dumps.

### React
- **Custom window events** (`hon.go-to-loans`, `hon.loan-ids-changed`, `hon.unseenLoanIds` localStorage key) for cross-component nav and unseen-loan signalling — documented in `App.tsx`, `AccountsView.tsx`, `LoansView.tsx`. Don't replace with a context unless you also restore the cross-tab `storage` event handling.
- **`DelayedLoader`'s 250ms grace period** (`web/src/ui/DelayedLoader.tsx`) — intentional; swallows one-frame flashes for cached responses.
- **`installFetchMock` keyed by `"METHOD /api/path"`** — test infrastructure; unmocked requests throw loud by design.
- **`window.state` exists ONLY in the legacy SPA** — the React app uses normal hooks.
- **Triplicated `ModalPortal`** is a pattern flag, not a behaviour requirement — lift to `web/src/ui/ModalPortal.tsx` (see §7.7) but preserve the focus-trap version, not the short shims.

### Security
- **Loopback bind by default + refusal to start when non-loopback host has no token** (`server.ts:2222-2231`).
- **Token in URL fragment (`#token=…`)** — keeps the credential out of HTTP server logs and out of the Referer header.
- **Field-name-only credential logging** (`credentialFields: Object.keys(args.credentials)`).
- **Random 12-byte IV per AES-GCM encryption + auth-tag verification before `final()`**.
- **Verifier pattern proves passphrase without storing it.**
- **No `ignoreHTTPSErrors` / `dangerouslyAcceptInsecureCerts`** anywhere — keep it that way.

---

## 10. Quick-win action list (suggested PR order)

Easiest deletions and one-line fixes first. Each item below is small enough to fit in one PR.

| # | Action | Estimated effort |
|---|---|---|
| 1 | **Delete `electron/` + `.github/workflows/release.yml`** + strip the README electron passages | 15 min, ~625 lines removed |
| 2 | **Add `loanId: string | null` to `TxnRow` in `sidecar/src/repo.ts:85`** — closes the only real type drift | 5 min |
| 3 | **Lift `ModalPortal` to `web/src/ui/ModalPortal.tsx`** — use across 3 view files | 30 min |
| 4 | **Drop `export` from internal-only helpers** (see §7.5) | 15 min |
| 5 | **Remove commented-out blocks** at `sidecar/src/bankLoans.ts:234-247, 679-686` | 5 min |
| 6 | **Fix H-4 (`applyMerchantRule`)** — add `AND category IS NULL`. One-line fix that closes a real data-loss path. | 15 min + test |
| 7 | **Fix H-3 (Splitwise locked-vault delete)** — return 409 instead of silently orphaning | 15 min + test |
| 8 | **Fix H-10 (`/transactions/:id/loan` 404 check)** — match sibling routes | 15 min + test |
| 9 | **Fix H-9 (LLM `load()` race)** — cache in-flight promise. Apply same fix to `fx.ts:18-31`. | 30 min |
| 10 | **Add timeouts to `splitwise.ts:64-72` and `fx.ts:21` fetches** | 15 min |
| 11 | **Hoist `Detail` out of `BankProjection`** in `OverviewView.tsx:180-193` | 5 min |
| 12 | **Add top-level `unhandledRejection`/`uncaughtException` handlers** to `server.ts` | 15 min |
| 13 | **Add `process.on('SIGTERM')` graceful shutdown** if not already | 15 min |
| 14 | **Fix H-1 (`/logo/:companyId` path traversal)** — strict regex + drop bypass + token gate | 1 hour + testing |
| 15 | **Fix H-2 (LLM API keys → vault)** — migrate plaintext file into vault | 2 hours + migration logic |
| 16 | **Fix H-5 (OTP timeout)** — 5-min Promise.race | 30 min + test |
| 17 | **Fix H-6 (scrypt cost params)** — version the salt prefix for transparent upgrade | 2 hours + migration |
| 18 | **Fix H-7 (scrape lock)** — Set<connectionId> in ScrapeRunner | 30 min + test |
| 19 | **Move OTP DOM dump** off `/tmp` to `<dataDir>/debug/` | 15 min |
| 20 | **Plan SPA retirement** — wire `web/dist` to `/` in `web.mjs`; sanity-pass each tab; delete `sidecar/public/app.html`. Single biggest cleanup the codebase will ever see. | 1-2 days |

### Then the larger refactors (one PR per file, in size order):
21. Split `web/src/insights/InsightsView.tsx` (797 lines).
22. Split `web/src/vouchers/VouchersView.tsx` (939 lines).
23. Split `web/src/activity/ActivityView.tsx` (1,105 lines).
24. Memoize derived data across all large views (§3 M-R1..M-R10).
25. Split `web/src/accounts/AccountsView.tsx` (1,580 lines).
26. Split `sidecar/src/bankLoans.ts` (792 lines).
27. Split `sidecar/src/voucherScrapers.ts` (1,476 lines).
28. Split `sidecar/src/pension.ts` (1,715 lines).
29. Split `sidecar/src/repo.ts` (2,261 lines) into domain repos.
30. Split `sidecar/src/server.ts` (2,291 lines) into route modules.

---

## 11. Methodology

This review was produced by four parallel agents:

1. **Backend correctness agent** — read every non-test `.ts` under `sidecar/src/`, applied the 5 angles of the superpowers `code-review` skill (line-by-line, removed-behavior, cross-file, language-pitfalls, wrapper/proxy), then a fresh-reviewer sweep pass.
2. **React agent** — read every `.tsx` and non-test `.ts` under `web/src/`, applied Vercel React best-practice rules (rerender, bundle, rendering, JS perf, advanced patterns) plus a React-specific bug pass.
3. **Security agent** — cross-cutting scan across the whole tree: auth surface, vault, paths, shell, HTML, SQL, migrations, logging, races, outbound HTTP, Puppeteer, token handling.
4. **Structure agent** — file-size analysis, redundancy detection, dead-code scan, type drift between engine and web, TODO inventory, split planning.

The two highest-severity findings (H-1 logo path traversal, H-2 plaintext LLM keys) were each independently found by both the backend and the security agent — strong corroboration that these are real, not hallucinated.

For context-window protection, the codebase was mapped via `ctx_execute` (file structure stayed in the sandbox; only summaries entered context). Each agent worked in the same isolated git worktree at `.claude/worktrees/code-review-2026-05-27` so the other agent on `main` was not disturbed.

---

*End of review.*
