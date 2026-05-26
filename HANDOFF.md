# HANDOFF.md — React migration for Hon

> **Read this first.** This is the rolling bridge between Claude Code
> sessions. The tab-by-tab migration from the legacy
> `sidecar/public/app.html` into React under `web/` is **structurally
> complete**: all 10 tabs ship. What's left is finishing the deeper
> CRUD/interactive flows in each tab — see § "What's left".

## TL;DR

- The engine (`sidecar/`) is **untouched**. Same DB, same APIs, same
  scrapers, same token-on-URL-fragment auth.
- All 10 tabs are migrated end-to-end. **224 tests pass, typecheck
  clean.** `npm run dev` and `npm test` both work from `web/`.
- The legacy SPA at `sidecar/public/app.html` is still served by
  `npm run web` and remains the production UI. The new React app
  ships from `cd web && npm run dev` — append `#token=<uuid>` from
  the engine's startup URL.
- **What's left** is a set of deferred-on-purpose CRUD + sync flows
  inside individual tabs (see the list at the end of this file).
  None of them block "the React UI is feature-shaped"; each is its
  own follow-up.

## Why React (and why a restart)

The user wanted to:

1. **Modularize** — `app.html` is one 10k-line file with everything
   inline. Hard to navigate, hard to review, hard to test.
2. **Move to a real framework** — JSX components + reactive state
   beats `render()`-by-hand + `window.state` mutations.
3. **Use Superpowers methodically** — TDD per component, systematic
   debugging when something breaks visually.

If `/systematic-debugging`, `/test-driven-development`, and
`/verification-before-completion` aren't in your skill list, ask the
user — the restart didn't take.

## Current state on disk

```
Hon/
├── CLAUDE.md                    ← Architecture map.
├── HANDOFF.md                   ← This file.
├── README.md
├── sidecar/                     ← Engine. Untouched plan.
│   ├── public/app.html          ← Old SPA. Still in production.
│   ├── src/                     ← TypeScript engine. 95+ HTTP routes.
│   └── tests/                   ← 41 Vitest tests (pure-fn).
└── web/                         ← React UI.
    ├── package.json             ← vite, react, react-dom, typescript
    ├── vite.config.ts           ← Proxies /api → engine on :4000
    └── src/
        ├── main.tsx             ← createRoot mount (StrictMode on)
        ├── App.tsx              ← Sidebar nav + brand header + token gate
        ├── App.test.tsx
        ├── api.ts               ← Bearer-token fetch (LAZY token read)
        ├── styles.css           ← Lifted incrementally from app.html
        ├── format.ts            ← money() helper
        ├── cycle.ts             ← cycleKey + currentCycleKey + prevCycleKey
        ├── overview/            ← Overview (balance + projection + essentials + net worth)
        ├── accounts/            ← Accounts (full — see § "What's left" for deferred CRUD)
        ├── activity/            ← Transactions list + search + category sidebar
        ├── recurring/           ← Fixed bills (read-only)
        ├── subscriptions/       ← 4 buckets (Active/Flagged/Cancelled/Probably)
        ├── piggy/               ← Piggy banks (read-only)
        ├── vouchers/            ← Gift cards CRUD (sync flows deferred)
        ├── loans/               ← Loans read + manual loan add via picker
        ├── insights/            ← Spending sub-tab (12-mo bars + monthly breakdown)
        ├── settings/            ← Full settings (6 cards, all live)
        └── test/
            ├── setup.ts
            ├── mockFetch.ts     ← installFetchMock({'METHOD /api/path': fn})
            └── harness.test.ts
```

## How to start working

```bash
# Terminal 1: the engine (unchanged)
cd sidecar && npm run web
# Note the URL it prints: http://127.0.0.1:4000/#token=<UUID>

# Terminal 2: React dev server (the user usually has this running)
cd web && npm install   # first time only
npm run dev
# http://localhost:5173/#token=<UUID-from-terminal-1>
```

If `/health` returns 401 the token in the URL is wrong — restart the
engine and use its new URL. If the dev server can't reach the engine,
set `VITE_HON_ENGINE_URL=http://127.0.0.1:<port>` and restart
`npm run dev`.

**Note for Claude:** the user typically has their own `vite` dev
server running on `:5173` outside of the `preview_*` MCP tools.
**Do not call `preview_start`** — it will collide with the user's
server. Rely on the test suite + the user's own browser tab (HMR is
on) for visual verification.

## The API surface

The engine has **95+ HTTP routes** in `sidecar/src/server.ts`, all
Bearer-token gated. The React UI uses `api()` in `web/src/api.ts`.

| Family | Path prefix | Purpose |
|---|---|---|
| Health / catalog | `/health`, `/companies`, `/vault/status` | Bootstrap |
| Connections | `/connections`, `/connections/:id`, `/connections/:id/scrape` | List, add, scrape (pass `interactive: true` for OTP-walled banks) |
| Sync status | `/runs/:id` | Poll a running scrape |
| OTP | `/runs/:id/otp` | Submit 2FA code |
| Accounts | `/accounts`, `/accounts/:id` | List, edit, exclude |
| Transactions | `/transactions`, `/transactions/:id` | List, category PATCH |
| Categories | `/categories` | User-editable category list |
| Loans | `/loans`, `/rates` | Loan CRUD, BOI prime + CPI |
| Vouchers | `/vouchers`, `/vouchers/sync/{shufersal,buyme,htzone}/...` | Gift cards |
| Summary / Budget | `/summary`, `/budget` | Computed projections |
| Insights / Piggy / Subscriptions | `/insights`, `/piggy`, `/subscriptions` | Tabs |
| SnapTrade | `/snaptrade/*` | Brokerage OAuth flow |
| Splitwise | `/splitwise/*` | Refund linking |
| Frequencies / splits | `/merchant-frequencies`, `/category-splits`, `/subscriptions/cancelled` | Recurring detection |
| Logos | `/logo/:companyId` | Provider favicons (exempt from auth) |

The OLD `app.html` is the source of truth for what every endpoint
returns. Grep it for the route to see how it's consumed.

## What's shipped (tab-by-tab)

All 10 tabs render and read from the engine. Per-tab feature notes:

1. **Overview** — Balance card (income − committed − spent, red when
   over), projected bank balance (bankNow + income − committed −
   spent − piggy, with itemised detail rows), essentials budget
   card (per-category bars, over-budget red), net worth headline
   with per-currency chips.
2. **Accounts (Assets)** — Full display, edits (balance, inception,
   net-worth toggle), sync + OTP flow, remove connection,
   set-credentials, brokerage holdings expansion, asset/loan edit,
   add-connection picker with bank/card credential form, manual
   asset, manual loan, provider favicons. SnapTrade portal flow
   (#30) and pension flows 5 variants (#31) are still deferred.
3. **Activity** — Transactions list with month picker, category
   groups, search, category move via right-side sidebar (with
   stubbed Reimbursement + Splitwise sections). Refund linking
   (#10) and batch select + bulk move (#11) deferred.
4. **Fixed bills (Recurring)** — Read-only merchant detection +
   status pills + monthly equivalents. CRUD (#16) deferred.
5. **Subscriptions** — 4 buckets (Active / Flagged / Cancelled /
   Probably cancelled).
6. **Piggy banks** — Read-only list with conic-gradient progress
   rings + headroom strip. CRUD (#14) deferred.
7. **Loans** — Loans read + manual-loan picker (Spitzer math
   runs in the engine).
8. **Vouchers** — List + add/edit/delete/toggle-excluded. Sync
   flows for Shufersal / BuyMe / HTZone (#4) deferred.
9. **Insights** — Spending sub-tab (12-month bars + per-month
   category breakdown). Brokerage sub-tab (#19) + AI rollup (#20)
   deferred.
10. **Settings** — All 6 cards (Billing cycle, Spending projection,
    Credit-card bills, Categories CRUD, AI engine stub, Splitwise
    stub).

## What's left

These are deferred on purpose — each is its own session-sized chunk.
Pick whichever is most valuable to the user next.

- **#4 Voucher sync flows** — Shufersal, BuyMe, HTZone modal +
  polling. Heaviest UI in the legacy app's voucher tab.
- **#10 Activity refund linking** — pair an outflow with a later
  refund so the budget nets correctly.
- **#11 Activity batch select + bulk move** — multi-select + move
  N transactions to a different category.
- **#14 Piggy banks CRUD** — new piggy form, edit, pause, delete.
- **#16 Recurring CRUD** — remove-from-fixed-bills, split editor,
  frequency picker.
- **#19 Insights Brokerage sub-tab** — value-over-time chart,
  holdings, per-account filter.
- **#20 Insights AI rollup** — narrative summary via `/llm/*`.
- **#30 SnapTrade portal flow** — OAuth + portal handoff for IBKR
  via SnapTrade.
- **#31 Pension flows (5 variants)** — Migdal/Harel/Clal automated,
  Meitav/Menora visible-window sign-in, Altshuler manual.

Smaller polish items not in the task list:
- AI engine card body in Settings — needs `/llm/*` flow.
- Splitwise card body in Settings + the Activity sidebar's Splitwise
  section — needs `/splitwise/*` OAuth + state.
- `expectedFixedThisCycle` for the Overview projection — the round-1
  + round-2 Overview uses the budget endpoint's `committed`
  (fixedSpent + essentialSpent so far this cycle). The legacy app
  uses a client-side recurring-merchant rollup that includes bills
  PROJECTED to bill this cycle. Lift `detectMerchants` out of
  `recurring/RecurringView.tsx` into a shared module and feed
  `?expectedFixed=` into `/budget` to match the legacy exactly.

## State management

The old SPA uses one `window.state` object mutated directly, followed
by manual `render()` calls. See `app.html` line ~2000.

For React the path established during Settings:

- **A scoped Context per concern**, not one global store. Only
  Settings has a provider so far (`web/src/settings/useSettings.tsx`).
  Other tabs use `useState` + `useEffect` locally; the parallel
  fetches inside each `View.tsx` are the de facto data layer.
- **No Redux/Zustand/etc.** Hon's state is read-heavy and the
  per-tab Context pattern handles the shared bits.

## Patterns the migrations established (REUSE THESE)

- **Each modal renders through a React portal** to `document.body`.
  See `CategoriesPanel.tsx`'s `ModalPortal`. Reason: `.set-card`'s
  fade-up animation leaves an identity transform behind, which
  creates a containing block and breaks `position: fixed` on
  `.overlay`. Don't render a modal inline inside a card.
- **Sidebars (Activity's category picker) slide in from the right**
  and aren't portalled — they're inline in their tab.
- **Network mock in tests via `installFetchMock`** keyed by
  `"METHOD /api/path"`. Unmocked requests throw loud so tests fail
  fast instead of hanging.
- **CSS port is incremental.** Every selector in `web/src/styles.css`
  was lifted verbatim from `app.html`'s style block. When porting a
  new piece, grep `app.html` for the selectors you use and lift them
  — don't invent new ones.
- **CSS subgrid** for aligning columns across rows (e.g.
  `.conn-accounts`'s `grid-template-columns: minmax(0, 1fr) auto auto`).
- **CSS column-count** for masonry-like layouts (`.act-cols`).
- **Tests verify behavior, not feature parity.** When a tab lands,
  spot-check the rendered output against the legacy app for visual /
  feature gaps the tests can't catch.

## Migration gotchas to know

These bit prior sessions:

1. **RTL Hebrew text.** The shell is `<html dir="ltr" lang="en">`.
   Per-element `dir="rtl"` or `unicode-bidi: plaintext` for Hebrew
   merchant names, not a global flip.

2. **Date math is timezone-sensitive.** israeli-bank-scrapers reports
   UTC midnight, which lands "yesterday" in Israel. Display dates
   in Asia/Jerusalem.

3. **Currency formatting.** ILS uses `₪` prefix-before-number; the
   `money()` helper in `web/src/format.ts` handles it. Lift more
   behaviour when needed (agorot, brokerage holdings).

4. **Custom cycle start day.** Budgets are per-cycle, NOT calendar
   month. `cycleKey(date, monthStartDay)` and `currentCycleKey()`
   live in `web/src/cycle.ts`. `prevCycleKey()` too.

5. **Pre-cycle inception clip.** Brokerage charts must respect
   `account.inceptionDate`.

6. **Token in URL fragment, not query.** `#token=<uuid>`. Fragment
   never hits the server log. `api.ts` reads lazily so jsdom tests
   that set `window.location.hash` post-import still work.

7. **No auto-deploy.** Commit locally; **ask before pushing**.
   Netlify-style deploy hooks aren't in play in this repo, but the
   habit avoids surprise releases.

8. **Banks that need OTP.** Pass `{ interactive: true, monthsBack }`
   to `POST /connections/:id/scrape` for any company in
   `HON_OTP_WATCHER_COMPANIES` (Beinleumi, Hapoalim, Otsar Hahayal,
   Massad, Pagi). Without it, the engine's headless path hangs at
   LOGGING_IN with no OTP modal triggered.

## Tests + Superpowers usage

- `cd sidecar && npm test` runs the 41 backend tests (Vitest).
- `cd web && npm test` runs the React component tests (**224** as
  of the Overview round-2 commit).
- `cd web && npm run typecheck` runs `tsc -b --noEmit`.
- Use `/test-driven-development` for each new component: write the
  test first, watch it fail, write minimal code to pass.
- Use `/systematic-debugging` when a migration produces a visual
  regression — read source first, don't tweak CSS blindly.
- Use `/verification-before-completion` before marking each deferred
  item done.

## When the migration is fully done

Last step: replace the engine's `/` route to serve the React build
output. In `sidecar/src/server.ts`:

```ts
app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(webAppHtml));
```

…becomes a static serve of `web/dist/index.html` + `web/dist/assets/*`.
Build with `cd web && npm run build`. Until that switch, both UIs
coexist.

---

**The hard part — the 10-tab migration — is done. The remaining
deferred items are bite-sized; pick whichever the user values most.**
