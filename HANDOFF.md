# HANDOFF.md — React migration for Hon

> **Read this first.** This is the rolling bridge between Claude Code
> sessions. The tab-by-tab migration from the legacy
> `sidecar/public/app.html` into React under `web/` is **structurally
> complete**: all 10 tabs ship. What's left is finishing the deeper
> CRUD/interactive flows in each tab — see § "What's left".

## TL;DR

- The engine (`sidecar/`) is **untouched**. Same DB, same APIs, same
  scrapers, same token-on-URL-fragment auth.
- All 10 tabs are migrated end-to-end and now render close to
  legacy parity (CRUD flows + Insights depth landed since the
  initial migration). **292 web + 55 sidecar tests pass, typecheck
  clean.** `npm run dev` and `npm test` both work from `web/`. The
  top-level `npm run dev` launches engine + vite together via
  concurrently; the dev token is persisted to `<dataDir>/dev-token`
  so the URL is bookmarkable.
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

## UI building blocks introduced

- **Radix UI primitives** (`@radix-ui/react-dialog`,
  `@radix-ui/react-dropdown-menu`) are now the standard for new modal
  + action-menu flows. jsdom polyfills for `hasPointerCapture` /
  `setPointerCapture` / `releasePointerCapture` / `scrollIntoView`
  live in `web/src/test/setup.ts` so Radix works under Vitest.
- **Reusable CSS scaffolding** — `.rx-overlay`, `.rx-dialog`,
  `.rx-dialog-sm` (Radix Dialog skins); `.menu-content`, `.menu-item`,
  `.menu-sep`, `.kebab-btn` (Radix DropdownMenu skins);
  `.btn-primary`, `.btn-ghost`, `.btn-danger` (generic CTA pills).
- **Sliding amber pill** on the main sidebar nav — single absolutely-
  positioned element measured from the active button via
  `useLayoutEffect`, animated with a soft spring on `transform` +
  `height`. The pill carries the gradient + a blurred halo.
- **Stagger reveal** on tab content — direct children of common view
  containers (`.set-grid`, `.piggy-grid`, `.assets-grid`,
  `.recurring-sections`, `.ov-stack`) fade-up with 0/50/95/135/170/
  200 ms cascade. Plus a fade-up on the keyed `.app-tab-view`
  wrapper itself.
- **Sidebar swap animation** — Activity transaction sidebar flips
  between category picker and refund picker with a spring overshoot
  (`.sb-view-anim` / `.rf-picker`).
- All animations respect `prefers-reduced-motion: reduce`.

## What's shipped (tab-by-tab)

All 10 tabs render with rich, near-legacy-parity flows. Per-tab notes:

1. **Overview** — Balance card (income − committed − spent, red
   when over), projected bank balance (bankNow + income −
   committed − spent − piggy, itemised detail rows), essentials
   budget card (per-category bars, over-budget red), net worth
   headline with per-currency chips.
2. **Accounts (Assets)** — Full display, edits (balance, inception,
   net-worth toggle), sync + OTP flow, remove connection,
   set-credentials, brokerage holdings expansion, asset edit,
   add-connection picker with bank/card credential form, manual
   asset, manual loan, provider favicons. **Loans no longer
   rendered here** — they live exclusively in the Loans tab.
   **Post-sync new-loan banner** appears at the top when a sync
   detects a loan id that wasn't in `localStorage['hon.knownLoanIds']`.
   *Deferred:* SnapTrade portal flow (#30), pension flows 5
   variants (#31).
3. **Activity** — Transactions list with month picker, category
   groups, search. **Category-move sidebar** with compact
   left-aligned 2-col category grid. **Refund linking** (#10) takes
   over the sidebar with a search input, by-category groups, and
   automatic direction flip when the open txn is a refund. **Batch
   select + bulk move** (#11) — Select button enters batch mode,
   row click toggles selection (amber inset border), toolbar shows
   "N selected" + "Move to category…" which opens a Radix Dialog
   that parallel-PATCHes every selected txn.
4. **Fixed bills (Recurring)** — Merchant detection + status pills.
   **CRUD** (#16): per-row `×` (hover) sets frequency=ignore;
   per-category `÷N` pill opens a split-editor Dialog.
5. **Subscriptions** — 4 buckets (Active / Flagged / Cancelled /
   Probably cancelled).
6. **Piggy banks** — Conic-gradient rings + headroom strip. **CRUD**
   (#14): legacy-shape New / Edit Dialog with a sliding Type pill
   (Monthly / Set aside once), 16-emoji grid, ₪-prefix amount
   inputs, 4 monthly-set-aside preset cards (3/6/12/24 mo), live
   "you'll reach X in N months" ETA. Per-card kebab menu (Edit /
   Pause-or-Resume / Delete) with a confirm Dialog on delete.
7. **Loans** — Loans read + manual-loan picker. **Bank-scraped loans
   auto-link payment transactions** via `sidecar/src/loanMatcher.ts`
   (externalId hit → name-token hit → single-loan stopword fallback).
   Each loan card grows a green/amber "Last payment" badge + a
   collapsible `▾ N payments` history. Manual link/unlink lives in
   the Activity move sidebar's Loans section (PATCH
   `/transactions/:id/loan`). An amber pulse dot on the Loans nav
   button surfaces an unseen loan id detected by Assets.
8. **Vouchers** — List + add / edit / delete / toggle-excluded.
   *Deferred:* sync flows for Shufersal / BuyMe / HTZone (#4).
9. **Insights** — Spending and Brokerage sub-tabs (`.ins-tabs`
   segmented strip).
   - **Spending**: 12-month bars, stat tiles (Spent / Income / Saved
     | Overspent / Transactions), vs-prev + vs-avg trend pills,
     "Where it went" with per-category bars and ±vs-last / ±vs-avg
     delta chips, Biggest expense highlight card.
   - **Brokerage**: 5 stat tiles (Portfolio · Gain·1Y · Unrealized
     P&L · Return on cost · Holdings count), value-over-time SVG
     area chart with range pills (1M / 3M / YTD / 1Y / ALL) and a
     USD↔ILS toggle when multi-currency holdings exist, holdings
     rows with color dots + weight bars + ▲/▼ gain badges, sorted
     by value desc.
   **AI rollup card** under the Spending sub-tab — POST `/insights`
   triggers, polls 1.5s, parses tagged lines (WIN/WATCH/TREND/TIP)
   into colour-bordered cards with cascade animation.
   *Deferred:* per-account filter pills + inception-date input on
   the Brokerage chart, smooth bezier curve.
10. **Settings** — All 6 cards (Billing cycle, Spending projection,
    Credit-card bills, Categories CRUD, **AI engine** (full /llm/*
    wiring: 3-mode provider segment, local catalog with download
    progress + DictaLM 2.0 Hebrew model, Ollama/API forms with
    Test+Save, Categorize-all panel), Splitwise stub).

## What's left

- **#4 Voucher sync flows** — *DONE.* All three providers (Shufersal /
  BuyMe / HTZone) land with credential persistence, per-card
  ↻ Sync button, and an identity-checked cookie profile.
- **#30 SnapTrade portal flow** — OAuth + portal handoff for IBKR.
- **#31 Pension flows (5 variants)** — Migdal/Harel/Clal automated,
  Meitav/Menora visible-window sign-in, Altshuler manual.
- Smaller polish: per-account filter pills + inception-date input
  on the Brokerage chart; smooth bezier curve in `ValueChart` (it's
  a polyline today); Splitwise card body in Settings + the Activity
  sidebar's Splitwise section (`/splitwise/*`); `expectedFixedThisCycle` for
  the Overview projection (lift `detectMerchants` out of
  `recurring/RecurringView.tsx` and feed it into `/budget`).

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
- `cd web && npm test` runs the React component tests (**292** as
  of the loan-detection commit).
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
