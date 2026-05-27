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

## TL;DR — state of the world (2026-05-27)

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
- **Tests:** `cd web && npm test` → **315** passing. `cd sidecar &&
  npm test` → **55** passing. Both typechecks clean.
- **Most recent commit:** `dd5cfd7 web: brokerage drilldown — inline
  credentials gate + brokerage list`. All pushed to origin/main.
- **SnapTrade portal flow smoke-verified end-to-end (2026-05-27,
  session/snaptrade-smoke-2026-05-27).** The smoke surfaced a design
  gap: re-linking an already-linked broker (IBKR refreshed via
  SnapTrade Flex) leaves connectionCount equal to baseline, so the
  poll's `count > baseline` check never fired. Fix shipped on the
  same branch: server-side done-flag registry keyed by Hon
  connectionId, set by `/snaptrade/done` (now reads `honConn` from
  the customRedirect query), surfaced by `/count` as `done: boolean`.
  Polling hook treats either `count > baseline` OR `done === true`
  as success. DonePanel copy switches to "<Broker> connection
  refreshed." when accountsAdded is 0. `/snaptrade/done` HTML copy
  also fixed (used to say "press Sync", contradicting the auto-sync
  design).
- **What's left:** see § "Deferred items". Nothing blocks shipping;
  each is its own follow-up.

## What shipped this session (2026-05-27)

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
  price (CAPTCHA-walled per memory).
- **Pension flow port to React** — tile is visible-but-disabled
  today. Pension scrapers (Migdal/Harel/Clal automated +
  Meitav/Menora visible-window + Altshuler manual) all work in the
  legacy SPA / engine; just no React UI yet.

**Smaller polish** (also covered in CODE-REVIEW §3):

- Per-account filter pills + inception-date input on Brokerage chart.
- Smooth bezier curve in `ValueChart` (polyline today).
- Splitwise card body in Settings + Activity sidebar Splitwise
  section (`/splitwise/*`).
- `expectedFixedThisCycle` for the Overview projection (lift
  `detectMerchants` out of `RecurringView.tsx` and feed `/budget`).

## Tests + Superpowers usage

- `cd web && npm test` → 315.
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
