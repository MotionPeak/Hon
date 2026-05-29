# HANDOFF.md — Hon

> **Read this first.** Rolling bridge between Claude Code sessions.
>
> **Then read [PROJECT-RULES.md](PROJECT-RULES.md)** — durable
> behavioral rules (no `preview_start`, visual-verification workflow
> via chrome-devtools MCP, **worktree-per-session policy**, push
> policy, workflow discipline, Hon-specific gotchas). Non-negotiable
> before touching code.
>
> **And [CLAUDE.md](CLAUDE.md)** — code-architecture map: where
> things live, the why behind non-obvious decisions, common
> debugging patterns. Reference for code-level questions.

## Session-start checklist (before any edit)

1. **Spawn a worktree** (rule from PROJECT-RULES.md §3):
   ```bash
   cd /Users/shaharsolomons/Documents/Code/Hon
   TOPIC="<short-slug>"; DATE=$(date +%F)
   git worktree add ".claude/worktrees/${TOPIC}-${DATE}" -b "session/${TOPIC}-${DATE}"
   cd ".claude/worktrees/${TOPIC}-${DATE}"
   ```
   …or invoke the **`superpowers:using-git-worktrees`** skill to do
   the same thing. Every code edit lands in this worktree, never on
   the `main` checkout.
2. **Run sanity checks once**: `cd web && npm test`, `cd sidecar &&
   npm test`, both typechecks — confirm a green baseline before
   diverging.
3. **Decide on workflow level**: trivial fix → just edit; multi-step
   feature → invoke `superpowers:brainstorming` → `writing-plans` →
   `executing-plans`.

## TL;DR — state of the world (2026-05-28)

- **Pension flow ported to React** (branch
  `session/pension-react-port-2026-05-27`). The Assets-picker Pension tile is
  now live: scraped providers (Clal/Harel/Migdal automatic, Meitav/Menora
  browser-window), custom manual-pension entry, and an `InteractiveSignInModal`
  for the visible-window sync. All three paths visually verified via
  chrome-devtools against the real engine. **Car tile remains disabled** (its
  flow ports separately).
- **Sync window + completion feedback shipped this session.** Per-connection
  `history_months` (migration 36, default 12) now drives every sync's start
  date; the old `lastSuccess − 14d` incremental shortcut in
  `runner.chooseStartDate` is gone (it was the reason React-triggered syncs
  only ended up with ~2 months of data). React: each connection card has an
  inline **History months `<select>`** (3/6/12/18/24), and a sync now ends with
  a **`✓ Done — N transactions`** pill that auto-clears after 5s. New route
  `PATCH /connections/:id/history-months`. Verified live: Max synced 12 months,
  pill rendered `✓ Done — 1116 transactions`, re-sync left the row count flat
  (0 duplicate `(account_id, external_id)` groups — DB dedup proven).
  Branch `session/sync-window-12mo-2026-05-27` (not yet merged at time of writing).
- **React migration done, structurally.** All 10 tabs ship from
  `web/` at near-legacy parity. The legacy SPA at
  `sidecar/public/app.html` is still served by the engine and is the
  production UI; the React app is at `cd web && npm run dev`.
- **SnapTrade portal flow shipped this session.** Add Account →
  Brokerages tile → if no SnapTrade conn, inline credentials form;
  if conn exists, inline brokerage list → click broker →
  `SnapTradeLinkFlow` opens with broker pre-selected, polls
  `/snaptrade/connections/:id/count` (new endpoint) every 3s for up
  to 5 min, auto-syncs on detection, shows "N accounts added". Also
  reachable via "Link another brokerage" button on the SnapTrade
  card. Matches the legacy SPA's category-tile picker design 1:1
  (Banks / Credit cards / Brokerages / Car / Pension & savings /
  Loan / Other asset — Car + Pension disabled until React flows ship).
- **Tests:** `cd web && npm test` → **415** passing. `cd sidecar &&
  npm test` → **60** passing. Both typechecks clean (verified on the
  merged tree).
- **Most recent work:** Brokerage Insights full chart port + 5
  metric-correctness fixes merged into `main` 2026-05-29 — see
  § "Brokerage Insights" + its "⚠️ More work still needed" list.
  Prior: pension React port, sync-window/history-months, autosync-on-add,
  SnapTrade re-link smoke fix (parallel sessions, all merged).
- **SnapTrade portal flow smoke-verified end-to-end (2026-05-27,
  session/snaptrade-smoke-2026-05-27).** The smoke surfaced a design
  gap: re-linking an already-linked broker (IBKR refreshed via
  SnapTrade Flex) leaves connectionCount equal to baseline, so the
  poll's `count > baseline` check never fired. Fix shipped: server-side
  done-flag registry keyed by Hon connectionId, set by `/snaptrade/done`
  (now reads `honConn` from the customRedirect query), surfaced by
  `/count` as `done: boolean`. Polling hook treats either
  `count > baseline` OR `done === true` as success. DonePanel copy
  switches to "<Broker> connection refreshed." when accountsAdded is 0.
- **What's left:** see § "Deferred items". Nothing blocks shipping;
  each is its own follow-up.

## What shipped this session (2026-05-28) — Pension React port

Branch `session/pension-react-port-2026-05-27`, commits
`6cf0547`..`59841c2` (14 commits: 4 docs + 10 code, local-only).
Built via brainstorming → writing-plans → subagent-driven-development.

**What's now live in the React Assets picker:**

1. **`AddManualAssetForm` gained an `initialKind` prop** (`b9967b8`,
   `0b01423`) — typed as a derived `AssetKind` union (not bare
   `string`) so a bad preset is a compile error. Defaults to `'cash'`.
2. **`PensionPickerStep`** (`e221811`, `3bbac13`, `9dc3b43`) — a
   dedicated picker component at `web/src/accounts/PensionPickerStep.tsx`.
   Lists pension providers with an "Automatic" vs "Browser window" tag
   chip, plus a trailing "Custom pension account" row. Row markup is an
   exported `PensionProviderRow` sub-component (customization seam for
   future per-provider variants). Empty-state `<li role="status">`.
3. **Pension tile wired** (`72d3988`, `b1c1e6b`) — dropped `comingSoon`,
   added `{ kind: 'pension' }` to the picker's `PickerStep` union and a
   `'manual-pension'` literal to `AccountsView`'s `AddFlow` union. The
   custom row routes to `AddManualAssetForm initialKind="pension"`; a
   scraped provider routes through the existing `onPickCompany` →
   `AddConnectionForm` path (same as banks).
4. **`InteractiveSignInModal`** (`cc25c1c`, `eef37ca`, `59841c2`) — at
   `web/src/accounts/InteractiveSignInModal.tsx`, lazy-loaded (matches
   `SnapTradeLinkFlow`). Mounted by `AccountsView` whenever a sync is
   `running` on a connection whose company has `interactive: true`.
   "Close" dismisses it locally via a `dismissedInteractiveRunIds` Set
   without cancelling the engine-side scrape; the runId is cleared from
   that Set when the run terminates. Has a `hints?` slot (seam) for
   future per-provider tips.

**No engine changes** — `PENSION_COMPANIES`, `runPensionScrape`, the
visible-window pop, and vault/credential persistence were all already
in place. UI-only port.

**Visually verified** (chrome-devtools, parallel worktree Vite on 5174
against the live engine on 4000, real account data):
- Path A — picker shows Clal/Harel/Migdal "Automatic" + Meitav/Menora
  "Browser window" + custom row.
- Path B — clicking Meitav opens `AddConnectionForm` (id + phone fields).
- Path C — custom row opens `AddManualAssetForm` with Kind=Pension.
- Pension dashboard section renders real Meitav + Migdal data.
- Regression: Banks picker + Car-disabled tile both intact.

**Hand-test still owed (needs Shahar's credentials):** the actual
visible-window Meitav/Menora sign-in → scrape → `InteractiveSignInModal`
mount cannot be exercised without real Meitav/Menora credentials. The
modal mount/unmount is covered by unit tests with a mocked poll, but
the live OS-window handshake has never run end-to-end in React.

**Known minor gap:** the React `AddConnectionForm` shows generic
"credentials encrypted in the vault" copy for interactive funds — it
doesn't pre-warn "a browser window will open on sync" the way the
legacy SPA's credential step did. The `InteractiveSignInModal` surfaces
that explanation at sync time instead (the more important moment), so
this is a deferred polish item, not a blocker.

## What shipped this session (2026-05-28) — sync window + completion pill

Branch `session/sync-window-12mo-2026-05-27`. Spec + plan at
`docs/superpowers/{specs,plans}/2026-05-27-sync-window-12mo*`.

1. **Migration 36** — `connections.history_months INTEGER NOT NULL DEFAULT 12`
   (`sidecar/src/db.ts`, `SCHEMA_VERSION = 36`).
2. **Repo** — `Connection.historyMonths` + `CONNECTION_COLS` carry it (load-bearing,
   same hazard as `TXN_COLS`); new `repo.setConnectionHistoryMonths(id, n)` with
   `[1,24]` validation (throws → server translates to 4xx).
3. **Runner** — `chooseStartDate` gutted to `return startDateMonthsAgo(monthsBack)`;
   the `lastSuccess − 14d` shortcut and the now-unused `CARD_COMPANIES` const are
   removed. New `persist.skipped` log line per scrape.
4. **Server** — `POST /connections/:id/scrape` falls back to
   `connection.historyMonths` when the body omits `monthsBack`; new
   `PATCH /connections/:id/history-months` (404/400/200, token-gated).
5. **React** — `Connection.historyMonths` type; `startSync` no longer sends the
   hard-coded `monthsBack: 24` (engine picks per-connection default); new
   `success` `SyncState` variant → `✓ Done — N transactions` pill, 5s auto-clear
   (timer stashed in `pollTimers` for unmount cleanup); inline history-months
   `<select>` on each conn-card (optimistic PATCH, reverts on error).
6. **Tests** — sidecar 63 → ~71 (migration, repo getter/setter, runner); web
   315 → ~321 (sync payload, Done pill render + 5s clear + unmount, history
   select render/PATCH/revert). All green, both typechecks clean.

### Known follow-ups from this session

- **`persist.skipped` always logs `skipped=0`.** `repo.saveScrapeResult` counts
  upserted rows as "saved", so `fetched − saved` is always 0. The real dedup is
  proven (re-sync leaves row count flat, 0 dup `(account_id, external_id)`), but
  the metric is cosmetic. To make it meaningful, count net-new via better-sqlite3
  `changes()` on the INSERT-OR-IGNORE path.
- **Worktree-vs-dev-server friction.** `git worktree` doesn't copy gitignored
  `node_modules`. The worktree's `web/` + `sidecar/` happened to have their own
  `node_modules` this session, but the top-level `npm run dev` (concurrently)
  needs root `node_modules` which the worktree lacks. To verify a worktree branch
  live: run vite from `<worktree>/web` and the engine from `<worktree>/sidecar`
  directly (not the root launcher). Watch for stale vite instances piling onto
  5174/5175 when 5173 is taken.

## What shipped (prior session, 2026-05-27)

Branch `main`, commits `e9ef14d`..`dd5cfd7` (17 commits, all pushed):

1. **Spec + plan** (`e9ef14d`, `136c2e9`) — SnapTrade portal flow
   design + TDD-ordered implementation plan at `docs/superpowers/`.
2. **Backend** (`d9fbef3`, `a348c0a`) — exported `countConnections`/
   `getStoredUser`/`makeClient` from `sidecar/src/snaptrade.ts`;
   added `GET /snaptrade/connections/:connectionId/count` route.
3. **Components** (`479eff3`, `637b084`, `48440b4`, `4f59139`,
   `d6aae90`) — `SnapTradeBrokeragePicker`, `useSnapTradeConnectionPoll`,
   `Countdown`, `SnapTradeLinkFlow` orchestrator. All TDD.
4. **Wiring** (`4e981d1`, `dd6524b`, `c9fcc9e`) — Add Account flow
   routing through SnapTrade; "Link another brokerage" button on
   SnapTrade connection card; integration tests.
5. **Tile picker port** (`3f92d8c`, `cf87d1f`, `f728313`) — category
   tile picker matching legacy SPA, with disabled Car + Pension tiles.
6. **CSS overflow fixes** (`ec744ff`, `2060bdc`) — `minmax(0, 1fr)`
   + override the global `button { white-space: nowrap }` so tile
   sub-text wraps.
7. **Behavioral rules** (`a955d54`, `30de1d8`) — PROJECT-RULES.md
   with visual-verification workflow; HANDOFF.md pointer.
8. **Brokerage drilldown refactor** (`dd5cfd7`) — Brokerages tile no
   longer drills into a single SnapTrade row; it opens the legacy-
   style inline credentials → brokerage list flow instead. Reuses
   `SnapTradeBrokeragePicker` (now a vertical list, no search);
   `SnapTradeLinkFlow` accepts `initialBrokerSlug` to skip its own
   picker when the broker was already chosen in the Add-asset modal.

## What shipped after that (2026-05-27 evening)

A run of UI polish under the brainstorm → plan → execute → verify
flow. Each landed as its own merge into `main`. Tests + typecheck
clean at every commit; visual verification per `PROJECT-RULES.md §2`.

1. **Loans-nav dot centering** (`1a77d45`) — `top: 50%; transform:
   translateY(-50%)` so the amber pulse sits mid-button.
2. **Activity sidebar — Always categorize + billing frequency**
   (`284d9d6`) — "Always categorize transactions from this business
   this way" checkbox wires to `applyToMerchant: true`. Billing-
   frequency segmented toggle (Monthly/Bimonthly for fixed group,
   Monthly/Yearly for Subscriptions) PUTs `/merchant-frequency` on
   save. `recurrenceChoices()` lifted into shared
   `web/src/recurring/helpers.ts`.
3. **Assets-grid masonry** (`96ffc4f`) — switched from `repeat(auto-
   fit, minmax(360px, 1fr))` to CSS multicol so a tall section
   (Pension w/ 2 accounts) no longer strands a 245px gap below its
   shorter row-mate (Investments) and pushes Other Assets onto a
   lonely row. Falls back to one column under 760px.
4. **Connection-card favicon** (`d3804e1`) — `<CompanyLogo>` now
   renders in `ConnectionCard` header so Beinleumi/Max/Meitav/Migdal/
   IBKR show their favicons. `/api/logo/:companyId` already cached
   on the engine.
5. **Exclude transactions from cycle** (`909b887`, db migration
   **v35**) — new `transactions.excluded_manual` column +
   `PATCH /transactions/:id/excluded`. Pure helper
   `web/src/activity/excluded.ts` merges the rule (cardProviders
   substring match + `hideCardTotals`) with the per-row manual
   override. Activity splits the active month into counted vs.
   excluded; new collapsible "Excluded from cycle (N)" section sits
   below the umbrella grouping; sidebar "Cycle calculations" toggle
   flips the override (and clears it back to `null` when the user
   restores the rule's default). 8 lump-sum `מקס איט פיננסים` card
   bills from Beinleumi now auto-park in the section.
6. **Brokerage chart polish** (`214e11c`) — `smoothPath` cubic-
   bezier curve (tension 0.18, ported from legacy SPA, rounded to
   2dp) replaces the polyline in `ValueChart`. New module-level
   `AccountPills` + `InceptionInput` + `InceptionBadge`.
   `BrokerageSubTab` fetches `/accounts` alongside `/brokerage`,
   intersects with snapshot account IDs, and uses the focused
   account's `inceptionDate` as a min-cutoff on the snapshot series.
   "All accounts" shows a read-only earliest badge to avoid mass-
   overwriting per-account customisation. Dots hidden when n > 24.

**Latest commit:** `214e11c` — Merge branch
'session/brokerage-chart-polish-2026-05-27' — brokerage chart polish.

**Most recent test counts:** web `352 passing`, sidecar `55 passing`;
both typechecks clean.

**Vite root gotcha (mind this on resume):** vite is owned by
whichever `npm run dev` last won the `:5173` port. If a parallel
Claude session is also editing Hon, vite may be watching their
worktree, not main — your HMR changes won't show up in the browser
even though `main` has them. `ps aux | grep vite` shows the cwd via
the binary path; cross-check with `lsof -p <pid> | grep cwd`.

## Brokerage Insights — full chart port + metric fixes (2026-05-29)

Branch `session/brokerage-chart-full-2026-05-27` — **merged to `main`
2026-05-29** (the earlier LineChart visual port landed as `594e95f`;
this merge brings the 5 metric-correctness fixes + `equitySeries` on
top). The first React brokerage "polish" pass shipped structurally
but looked/behaved wrong; this is the real port. Each fix was
verified live in chrome-devtools against the **legacy SPA**
(engine `:4000`) — they now match.

**Chart (full lineChart port):** new `web/src/insights/LineChart.tsx`
replaces the thin polyline. SVG with 4-line grid, blurred glow,
3-stop gradient, tone color (green up / red down), draw-in animation,
and a React-state hover crosshair + dot + tooltip ("Since start"
delta), touch support. `web/src/insights/smooth.ts` holds the
Catmull-Rom path math (tension 0.18). Pills + inception now sit
BELOW the chart (legacy order). Inception input uses the legacy
wording.

**Equity series (`web/src/insights/equitySeries.ts`):** ported the
legacy 3-tier `buildEquitySeries` — broker `performance.totalEquity`
→ forward-filled `holdingSnapshots` → local `snapshots` — plus
`sliceRange` (anchors sparse data to the last point before the
window). Previously React summed ONLY local snapshots (~1 week), so
1Y/ALL drew a flat line; now it shows the full broker-reported year.

**Metric correctness fixes (all matched to legacy):**
- Account-filter pills now scope EVERY metric (stats + holdings list
  + gain), not just the chart.
- `holdingStats()` port: SnapTrade reports `costBasis`/`openPnl`
  **per unit** and leaves `value` null for some positions (IBKR
  VBR/VT). React was treating them as totals → Portfolio ₪0, wrong
  P&L. Now value = `value ?? units×price`, cost = `units×costBasis`,
  gain = `value − cost`. Unrealized P&L for IBKR went +₪387 →
  **+₪4,455.65**, holdings show real values (VT $3,462.36 /
  VBR $705.87).
- **Portfolio value = sum of in-scope account `balance`** (includes
  cash), per legacy ("Total value uses account balances; gain/cost
  come from priced positions only"). Was holdings-sum (omitted cash);
  IBKR ₪11,824 → **₪12,205.67** ($4,302.62), matching legacy. Holding
  allocation weights still divide by the holdings-value sum.
- Gain·1Y derives "current" from the equity series (not the holdings
  sum), so a null-value broker position no longer makes it read −100%.

Tests: worktree web suite **389 passing**, typecheck clean.
`equitySeries` has 14 unit tests; `smooth` 9; `LineChart` 14;
`InsightsView` integration tests lock the scoping + performance +
per-unit + balance behaviours.

### ⚠️ More work still needed on the Brokerage Insights page

This pass fixed what was clearly broken, but the page is **not
"done"** — open items for the next session:

1. **Engine USD/ILS rate looks wrong.** `/brokerage` `ilsRates.USD`
   came back **~2.84** (real USD/ILS is ~3.7). All USD↔ILS figures
   are faithful to that rate, so if it's stale/inverted every USD
   value across the app is off. Investigate `getIlsRates()` /
   Frankfurter in `sidecar` — this is engine-side, not the UI.
2. **SnapTrade holding data is internally inconsistent.** For IBKR,
   `units×price` (~$4,168), `costBasis`+`openPnl`, and the account
   balance ($4,302) don't fully reconcile, and `value` is null. The
   UI now copes (legacy formulas), but the underlying SnapTrade
   mapping in `sidecar/src/snaptrade.ts` deserves a look — the
   per-unit vs total semantics and the null `value` are fragile.
3. **Pills only list accounts that have value-snapshots** (the
   `brkAccounts = accounts ∩ snapshot.accountId` intersection). An
   account with `performance` but no local snapshot yet wouldn't get
   a pill. Legacy keys off company type; consider matching.
4. **No transaction-based "ALL" cap.** Legacy anchors the ALL range
   to the user's earliest transaction so it doesn't paint years of
   pretend pre-ownership history; React only has the per-account
   inception clip. The brokerage tab doesn't fetch `/transactions`.
5. **Holdings drill-down / sparkline** (legacy `holdingRow` expand)
   and per-range stats (rate of return, dividends, contributions
   from `performance.byRange`) are not ported.
6. **Re-verify once the engine rate is fixed** — the ILS figures
   shift if #1 changes.

## Restart workflow (you'll need this)

```bash
# Kill anything running
pkill -9 -f 'tsx.*server\.ts|node.*web\.mjs'

# One-command relaunch — concurrently spawns engine + vite
cd Hon && npm run dev
# Engine → http://127.0.0.1:4000  (token persisted, URL is bookmarkable)
# Vite  → http://localhost:5173/#token=<same uuid>
```

The dev token is now persisted to `<dataDir>/dev-token` (mode 0600).
First boot generates and saves; subsequent boots reuse. `HON_TOKEN`
env var still wins if set. **The token is the only thing between a
local browser tab and the user's finances — never remove it.**

**Do NOT call `preview_start`.** The user runs their own vite dev
server outside the Claude harness; `preview_start` collides with it.
Rely on the test suite + the user's own browser tab (HMR is on).

## The loan auto-link feature (newest, just landed)

Three connected parts. Hot paths to know:

1. **Schema** (`sidecar/src/db.ts`, `SCHEMA_VERSION = 34`):
   migration 33 adds `transactions.loan_id TEXT`; migration 34 adds
   a partial index `idx_txn_loan_id WHERE loan_id IS NOT NULL`.
2. **Matcher** (`sidecar/src/loanMatcher.ts`, pure heuristic +
   11 unit tests): externalId hit → name-token hit (≥3 chars,
   stopword-stripped) → single-loan stopword fallback. **Hebrew
   regex gotcha:** `\b` doesn't anchor Hebrew (Hebrew chars aren't
   `\w`). Use bare substring for Hebrew alternatives, `\b…\b` only
   for Latin (`halvaa|loan`).
3. **Persistence + API** (`sidecar/src/repo.ts`,
   `sidecar/src/server.ts`):
   - `upsertBankLoan` on first-insert runs a 12-month backfill
     scan and links matching transactions on that connection.
   - Per-account sync hoists prepared statements and runs the
     matcher after every `upsertTxn` (skips rows that already have
     `loan_id`).
   - `GET /loans` folds `repo.listLoanPayments(loan.id)` into each
     loan as a `payments` field (newest-first).
   - `PATCH /transactions/:id/loan` body `{ loanId | null }` —
     manual link/unlink. 404 on unknown loanId.
   - **Critical reminder:** `TXN_COLS` in `repo.ts` includes
     `loan_id AS loanId`. **Add `loanId` to that SELECT clause
     whenever you add a new transaction column or the UI silently
     loses it.** This was the bug the user hit at the end of the
     prior session.

4. **UI** (`web/src/`):
   - `accounts/AccountsView.tsx`: no longer renders loan cards.
     Diffs `currentIds − knownIds` against
     `localStorage['hon.knownLoanIds']` and writes new ids to
     `hon.unseenLoanIds`; renders `NewLoanBanner` at top.
   - `loans/LoansView.tsx`: `LoanPaymentHistory` subcomponent —
     green/amber "Last payment" badge (`>35d` overdue), collapsible
     `▾ N payments` list (cap 24 + Show more). Mount clears
     `hon.unseenLoanIds` + dispatches `hon.loan-ids-changed`.
   - `App.tsx`: listens for `hon.loan-ids-changed` (same-tab) +
     `storage` (cross-tab) to drive the `data-unseen` attribute
     on the Loans nav button (amber pulse dot). Listens for
     `hon.go-to-loans` to flip the active tab.
   - `activity/ActivityView.tsx`: fetches `/loans` alongside the
     existing parallel fetches. `LoansSection` in the move sidebar
     (Radix dialog) PATCHes `/transactions/:id/loan`. `LoanChip`
     renders `→ {loan.name}` on linked transactions in BOTH the
     grouped `CatCard` view AND the flat search-results view; click
     dispatches `hon.go-to-loans` with `e.stopPropagation()`.

## Cross-component navigation pattern

We standardized on custom window events instead of prop drilling
through 5+ components:

- `hon.go-to-loans` → `App.tsx` flips to the Loans tab.
- `hon.loan-ids-changed` → same-tab signal for localStorage
  changes (the `storage` event is cross-tab only).

Reuse this for the next "this child needs the shell to do X" case.

## How to start working

```bash
# One-command launcher (the new path)
cd Hon && npm run dev

# Or split if you want separate terminals
cd Hon/sidecar && npm run web
cd Hon/web && npm run dev
```

If `/health` returns 401, the token is wrong — restart the engine
(the on-disk token wins, so the URL stays the same). If `VITE_HON_ENGINE_URL`
needs to change, edit `web/.env.local` and restart vite.

## UI building blocks (reuse these)

- **Radix primitives** — `@radix-ui/react-dialog`,
  `@radix-ui/react-dropdown-menu` are the standard for modals +
  action menus. jsdom polyfills for `hasPointerCapture` /
  `setPointerCapture` / `releasePointerCapture` / `scrollIntoView`
  live in `web/src/test/setup.ts`.
- **Reusable CSS scaffolding** — `.rx-overlay`, `.rx-dialog`,
  `.rx-dialog-sm`, `.menu-content/item/sep`, `.kebab-btn`,
  `.btn-primary/ghost/danger`.
- **`DelayedLoader`** (`web/src/ui/DelayedLoader.tsx`) — 250ms
  hidden grace period. Use this instead of inline `<p>Loading…</p>`
  to kill tab-switch flash.
- **Sliding amber pill** on sidebar nav — measured from active
  button via `useLayoutEffect`, animated on `transform` + `height`.
- **Stagger reveal** on tab content — `.set-grid`, `.piggy-grid`,
  `.assets-grid`, `.recurring-sections`, `.ov-stack` children
  fade-up with 0/50/95/135/170/200ms cascade. Plus keyed
  `.app-tab-view` wrapper fade-up.
- All animations respect `prefers-reduced-motion: reduce`.

## What's shipped (tab-by-tab, condensed)

All 10 tabs render with rich, near-legacy parity. Highlights:

1. **Overview** — balance + projection + essentials + net worth.
2. **Assets (Accounts)** — full edits, sync + OTP, brokerage
   holdings, manual asset/loan, **post-sync new-loan banner**.
   Loans NO LONGER rendered here.
3. **Activity** — month picker, search, category sidebar, refund
   linking, batch select + bulk move, **Loans section in sidebar**,
   **`→ Loan name` chip on linked rows**.
4. **Fixed bills (Recurring)** — merchant detection, per-row `×`
   ignore, per-category `÷N` split editor.
5. **Subscriptions** — 4 buckets.
6. **Piggy banks** — conic rings + headroom, full CRUD with
   sliding Type pill + emoji grid + ETA.
7. **Loans** — manual add + read; **bank-scraped auto-link** with
   Last-payment badge + collapsible history; amber nav dot.
8. **Vouchers** — full CRUD + per-card ↻ Sync button. Shufersal,
   BuyMe, HTZone sync flows all live (see § "Voucher gotchas").
9. **Insights** — Spending (12-mo bars + per-cat deltas + AI
   rollup card) and Brokerage (5 stats + value chart with range
   pills + holdings list).
10. **Settings** — 6 cards including **AI engine** (3-mode segment,
    local catalog with download progress + DictaLM 2.0, Ollama/API
    forms with Test+Save, Categorize-all panel).

## Voucher gotchas (recently learned)

- **HTZ Cloudflare wall:** `#eightDigit` wait is **90s** (was 20s)
  + puppeteer stealth flags (`--disable-blink-features=AutomationControlled`,
  `ignoreDefaultArgs:['--enable-automation']`, `navigator.webdriver`
  override). Without both, Cloudflare interstitial hangs the flow.
- **HTZ card ↻ Sync:** auto-extracts the code from
  `voucher.externalId` (pattern `htz-<code>`) and skips the vault.
  This is HTZ-only because the externalId encodes the code; other
  providers still need the vault.
- **BuyMe identity check:** persistent cookie profile from a prior
  BuyMe session can silently harvest cards for a NEW email. The
  scraper writes a `last-email` marker file before launch and
  `rmSync`s the profile dir on mismatch to force fresh OTP.
- **Vault is locked by default** unless the user sets a passphrase.
  Affects Shufersal + BuyMe (need saved credentials). HTZ is
  unaffected (externalId fastpath).

## Deferred items

> **Big backlog source: [docs/CODE-REVIEW-2026-05-27.md](docs/CODE-REVIEW-2026-05-27.md)** —
> 11 HIGH findings (security: `/logo/:companyId` path traversal,
> plaintext LLM API keys, Splitwise locked-vault silent orphan,
> `applyMerchantRule` clobbers hand-categorization, scrypt cost
> below OWASP 2024, no scrape lock, OTP timeout leak, etc.) plus
> ~25 MEDIUM findings, file-split plans for the 7 files over 1k
> lines, and a quick-win action list in §10. Read this BEFORE
> planning the next session's work. The intentional-patterns
> section (§9) is also load-bearing — preserves things like the
> `BANK_SESSION_DENYLIST` Max entry, custom window events for
> nav, the Harel iframe regex, etc.

**Highest-value next steps**:

- **Fix HIGH security findings from CODE-REVIEW** — H-1 (`/logo`
  path traversal), H-2 (plaintext LLM keys → vault), H-6 (scrypt
  cost) are real exposure that wouldn't be hard to ship.
- **Manual smoke of SnapTrade portal end-to-end** — visually
  verified through to the brokerage picker but never actually
  completed an OAuth handshake with a real broker. Pick IBKR, walk
  through, confirm accounts appear + 3s poll detects the link.
- **Car flow port to React** — tile is visible-but-disabled today.
  Legacy `renderCarStep` in `sidecar/public/app.html` is the
  reference: plate-lookup via data.gov.il, deep-link to Yad2 for
  price (CAPTCHA-walled per memory). **Next React port to do** — and
  it should follow the same dedicated-PickerStep pattern the pension
  port just established (see `PensionPickerStep`).
- ~~**Pension flow port to React**~~ — **DONE 2026-05-28** on branch
  `session/pension-react-port-2026-05-27` (not yet merged). See
  § "What shipped this session (2026-05-28)".

**Pension-port follow-ups** (small, deferred from this session for scope):

- **Live hand-test of the interactive (Meitav/Menora) sync** — needs
  Shahar's real credentials; the visible-window handshake → modal has
  only been unit-tested with a mocked poll.
- **Per-provider hints in `InteractiveSignInModal`** — the `hints?`
  slot exists; no real hint (e.g. a Meitav captcha tip) is wired yet.
- **Interactive-fund copy on the credential form** — React
  `AddConnectionForm` shows generic vault copy; it could pre-warn about
  the browser window the way the legacy SPA did (the sync-time modal
  covers it for now).
- **Per-kind label on `AddManualAssetForm`** — legacy SPA relabels
  "Value" → "Amount accumulated" for pensions; the React form keeps
  "Value". Trivial follow-up.
- **`rowComponent` prop on `PensionPickerStep`** — wire it only when a
  real per-provider row variant actually arrives (YAGNI until then).

**Smaller polish** (also covered in CODE-REVIEW §3):

- Per-account filter pills + inception-date input on Brokerage chart.
- Smooth bezier curve in `ValueChart` (polyline today).
- Splitwise card body in Settings + Activity sidebar Splitwise
  section (`/splitwise/*`).
- `expectedFixedThisCycle` for the Overview projection (lift
  `detectMerchants` out of `RecurringView.tsx` and feed `/budget`).

## Tests + Superpowers usage

- `cd web && npm test` → 355.
- `cd sidecar && npm test` → 55.
- `cd web && npm run typecheck` → clean.
- **Use `/test-driven-development`** for each new component:
  RED → verify failure → minimal GREEN → verify pass → commit.
- Use `/systematic-debugging` for visual regressions — read source,
  don't tweak CSS blindly.
- For multi-task features, `/brainstorming` → `/writing-plans` →
  `/executing-plans` is the path. `/subagent-driven-development`
  works but is ~3× slower per task (two-stage review). The user
  has preferred direct execution after the first few tasks.

## Branch + push policy

- **Stay on `main`.** No PR / feature branches in this repo.
- **Ask before pushing** to origin. The user has been approving
  every push individually via `AskUserQuestion` — do not push
  unprompted, even when "the change is small". `git commit` freely,
  `git push` never without explicit go-ahead.
- Never `--no-verify`, never amend a published commit, never force
  push.

## State management

- **Per-tab `useState` + `useEffect`** + parallel fetches inside
  each `View.tsx` is the de facto data layer.
- **Scoped Context per concern**, not one global store. Only
  Settings has a provider so far (`web/src/settings/useSettings.tsx`).
- No Redux/Zustand. Hon's state is read-heavy.

## Migration gotchas worth re-reading

1. **RTL Hebrew text.** Shell is `<html dir="ltr">`. Per-element
   `dir="rtl"` or `unicode-bidi: plaintext` for Hebrew merchants.
2. **Date math is TZ-sensitive.** israeli-bank-scrapers reports
   UTC midnight, which lands "yesterday" in Israel. Display in
   `Asia/Jerusalem`.
3. **Currency formatting.** Use `money()` in `web/src/format.ts`.
4. **Custom cycle start day.** Budgets are per-cycle, NOT calendar
   month. `cycleKey/currentCycleKey/prevCycleKey` in
   `web/src/cycle.ts`.
5. **Pre-cycle inception clip.** Brokerage charts must respect
   `account.inceptionDate`.
6. **Token in URL fragment, not query.** `api.ts` reads lazily so
   jsdom tests that set `window.location.hash` post-import work.
7. **Banks that need OTP.** Pass `{ interactive: true, monthsBack }`
   to `POST /connections/:id/scrape` for any company in
   `HON_OTP_WATCHER_COMPANIES` (Beinleumi, Hapoalim, Otsar Hahayal,
   Massad, Pagi). Without it, headless path hangs at LOGGING_IN.
8. **`npm test` from repo root** double-passes `--run`. Run tests
   from `web/` or `sidecar/` directly.

## When the migration is fully done

Last step: serve the React build from the engine. In
`sidecar/src/server.ts`, replace the inline `webAppHtml` with a
static serve of `web/dist/index.html` + `web/dist/assets/*`. Build
with `cd web && npm run build`. Until that switch, both UIs coexist.

---

**The hard part — 10-tab migration + loan auto-link — is done.
Remaining work is bite-sized; pick whichever the user values most.**
