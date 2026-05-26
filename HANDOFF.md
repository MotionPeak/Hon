# HANDOFF.md — React migration for Hon

> **Read this first.** This is the rolling bridge between Claude Code
> sessions. Each session ships some number of tabs from the legacy
> `sidecar/public/app.html` into React under `web/`, then updates this
> file so the next session starts informed.

## TL;DR

- The engine (`sidecar/`) is **untouched**. Same DB, same APIs, same
  scrapers, same token-on-URL-fragment auth. Don't change it without
  a strong reason.
- The new React UI lives in `web/`. **Settings tab is migrated**
  (commits `de9857f`, `5196f1c` — 68 tests). The Vite + React + TS
  scaffold + TDD harness work; `npm run dev` and `npm test` both work.
- The **old vanilla SPA** at `sidecar/public/app.html` is still the
  one users hit when they run `npm run web`. It stays live until each
  tab has been migrated to React.
- Your job is to migrate `app.html` tab-by-tab into React components
  under `web/src/`. **Do not attempt a big-bang rewrite** — the file
  is ~10k lines, hebrew/RTL, financial UI, charts, modals. Migrate
  incrementally so you can verify visually after each tab.
- **Next up: Accounts.** See § "Migration strategy" for order.

## Why React (and why a restart)

The user wanted to:

1. **Modularize** — `app.html` is one 10k-line file with everything
   inline. Hard to navigate, hard to review, hard to test.
2. **Move to a real framework** — JSX components + reactive state
   beats `render()`-by-hand + `window.state` mutations. Easier for
   future contributors, easier for Claude to reason about.
3. **Use Superpowers methodically** — TDD per component, systematic
   debugging when something breaks visually.

The user restarted Claude Code specifically so Superpowers loads. If
`/systematic-debugging`, `/test-driven-development`, and
`/verification-before-completion` aren't in your skill list, ask the
user — the restart didn't take.

## Current state on disk (start-of-your-session)

```
Hon/
├── CLAUDE.md                    ← Architecture map for the codebase.
├── HANDOFF.md                   ← This file.
├── README.md                    ← User-facing docs (unchanged).
├── sidecar/                     ← Engine. Untouched plan.
│   ├── public/
│   │   └── app.html             ← Old SPA. Still in production.
│   ├── src/                     ← TypeScript engine. 95+ HTTP routes,
│   │   ├── server.ts            ←   scrapers, repo, vault, logger.
│   │   ├── pension.ts           ← Pension scrapers (Harel/Meitav/...)
│   │   ├── scrapers.ts          ← Bank scrapers + normalizers
│   │   ├── ...
│   ├── tests/                   ← 41 Vitest tests (backend pure-fn).
│   │   ├── pension.test.ts
│   │   ├── scrapers.test.ts
│   │   └── loans.test.ts
│   └── package.json             ← npm test runs the suite.
├── web/                         ← NEW — React UI.
│   ├── package.json             ← vite, react, react-dom, typescript
│   ├── vite.config.ts           ← Proxies /api → engine on :4000
│   ├── tsconfig.json
│   ├── index.html               ← <!doctype><html lang="he" dir="rtl">
│   └── src/
│       ├── main.tsx             ← createRoot mount
│       ├── App.tsx              ← Health-check starter
│       ├── api.ts               ← Bearer-token fetch wrapper
│       └── styles.css           ← Dark theme defaults
└── docs/, electron/, ...        ← (untouched)
```

## How to start working

```bash
# Terminal 1: the engine (unchanged)
cd sidecar && npm run web
# Note the URL it prints: http://127.0.0.1:4000/#token=<UUID>
# Keep that token.

# Terminal 2: the React dev server
cd web && npm install   # only first time
npm run dev
# Opens http://localhost:5173/ (no token → "no access token" screen)

# Open this URL in the browser, appending the token from terminal 1:
# http://localhost:5173/#token=<UUID>
# Should show "✓ Connected to hon-sidecar 0.3.0" + the JSON /health body.
```

If `/health` returns 401, the token in the URL is wrong — restart
the engine and use its new URL. If the dev server can't reach the
engine at all, set `VITE_HON_ENGINE_URL=http://127.0.0.1:<actual port>`
and restart `npm run dev`.

## The API surface (do not re-derive — already mapped)

The engine has **95+ HTTP routes** in `sidecar/src/server.ts`. All
behind `Authorization: Bearer <token>`. The new React UI uses the
same routes via the `api()` helper in `web/src/api.ts`.

Key endpoint families:

| Family | Path prefix | Purpose |
|---|---|---|
| Health / catalog | `/health`, `/companies`, `/vault/status` | Bootstrap, list providers |
| Connections | `/connections`, `/connections/:id`, `/connections/:id/sync` | List, add, trigger scrape |
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

The OLD `app.html` is the source of truth for what every endpoint
returns. Grep `app.html` for the route to see how it's consumed.

## Migration strategy (USE THIS ORDER)

Migrate tab-by-tab. Each tab is its own PR-sized commit. After each:
visually diff old vs new (open both Vite + the old `npm run web` side
by side). Don't move on until the new tab matches.

**Recommended order** (easiest → hardest):

1. ✅ **Health + chrome** — shell + tab nav landed alongside Settings.
2. ✅ **Settings** — migrated. AI engine and Splitwise are stubs
   (TODO when their /llm and /splitwise flows are ported).
3. **Accounts** ← **YOU ARE HERE.** Big tab. Realistically multiple
   sessions: read-only display + per-account edits first (balance,
   inception, excluded), then sync flow + remove + brokerage holdings
   expansion, then the Add-connection modal (15+ banks + SnapTrade +
   5 pension flows + manual asset modal). The previous session
   queued task #14-#33 with a phased plan; check the task list.
4. **Vouchers** — list + add modal + sync flows (Shufersal / BuyMe /
   Hi-Tech Zone). The sync flows are complex; lift the modal logic
   from app.html line ~5300+ verbatim, port to React.
5. **Loans** — Spitzer math runs server-side via `/loans` (which
   computes via `loans.ts`). UI just displays.
6. **Activity** — transaction list, refund linking, category move
   sheet. Has the most rows; pagination/virtual scroll is worth it.
7. **Recurring (Fixed bills)** — uses the budget projection. Read
   `CLAUDE.md` § "The budget projection" first.
8. **Subscriptions** — similar shape to Recurring.
9. **Piggy** — set-asides UI.
10. **Insights** — charts! Get the charts library decided before
    starting. The old code hand-rolled SVG; for React, consider
    `recharts` (declarative, great DX) or stay with hand-rolled SVG
    if you want zero new deps. The user trusts your call.
11. **Overview** — the headline card + projected bank balance. This
    is where the budget math comes together. **Do this LAST** —
    you'll have learned the patterns from every other tab.

## State management

The old SPA uses one `window.state = { ... }` object mutated directly,
followed by manual `render()` calls. See its shape at
`app.html` line ~2000 (`const state = {...}`).

For React, the path established during the Settings migration:

- **A scoped Context per concern**, not one global store. Settings
  uses `SettingsProvider` (`web/src/settings/useSettings.tsx`) that
  owns just the localStorage-backed settings. When Accounts lands it
  should get its own provider for accounts/connections/companies/
  assets/loans/brokerage, not be folded into a mega-store.
- **`useState` + `useEffect`** inside individual cards/components for
  view-local state (modal open/closed, draft input, expanded rows).
- **No Redux/Zustand/etc.** Hon's state is read-heavy and the
  per-tab Context pattern handles the shared bits without
  unnecessary indirection.

## Patterns the Settings migration established (REUSE THESE)

- **Each modal renders through a React portal** to `document.body`.
  See `CategoriesPanel.tsx`'s `ModalPortal`. Reason: `.set-card`'s
  fade-up animation leaves an identity transform behind, which creates
  a containing block and breaks `position: fixed` on `.overlay`. The
  old `app.html`'s `openModal()` appends the overlay to `<body>`
  directly for the same reason. Don't render a modal inline inside a
  card — it WILL look wrong.
- **Network mock in tests via `installFetchMock`** keyed by
  `"METHOD /path"`. See `CategoriesPanel.test.tsx` for the pattern.
  Unmocked requests throw loud, so tests fail fast instead of hanging.
- **The CSS port is incremental.** Every selector currently in
  `web/src/styles.css` was lifted verbatim from `app.html`'s style
  block. When porting a tab, grep `app.html` for the selectors you
  use and lift them. Don't invent new selectors — match.
- **`align-items: stretch` on grids** so cards in the same row match
  heights. Don't use `start` even though the old app does — the
  React port chose stretch and Settings looks better for it.
- **Full-width cards via `.set-card--wide`** for stubs / single-item
  cards that would otherwise sit lonely in a half-column.
- **Tests verify behavior, not feature parity.** When a tab lands,
  spot-check the rendered output against the legacy app for visual /
  feature gaps the tests can't catch. The Settings migration
  initially shipped without the emoji+colour pickers because nothing
  failed when they were missing.

## Migration gotchas to know before you start

These bit prior sessions. Pin them in your test cases:

1. **RTL Hebrew text.** The shell is `<html dir="ltr" lang="en">`
   as of the Settings migration (the React UI itself is English). When
   the Accounts / Activity tabs land they will start rendering Hebrew
   merchant names — those need per-element `dir="rtl"` or
   `unicode-bidi: plaintext` wraps, not a global flip. The previous
   session's `app.html` defaulted the whole document to RTL with
   English bits flipping back to LTR. We're doing the opposite.

2. **Date math is timezone-sensitive.** israeli-bank-scrapers reports
   UTC midnight, which lands "yesterday" in Israel. The fix is in
   `sidecar/src/scrapers.ts` (`israelDate()`). Display dates in
   Asia/Jerusalem. There's a test for this.

3. **Currency formatting.** ILS uses `₪` prefix-after-number in some
   formats, prefix-before-number in others. Hebrew locale formats
   numbers with commas. The old code has its own `money()` helper.
   Lift it to a `web/src/format.ts` and test it.

4. **Custom cycle start day.** Budgets are per-cycle, NOT per
   calendar month. See `CLAUDE.md` § "The cycle model" and
   `app.html`'s `cycleKey(dateStr)` helper.

5. **Pre-cycle inception clip.** Brokerage charts must respect
   `account.inceptionDate`. There's already a test pattern in the
   pure-function side; replicate in the React chart components.

6. **Token in URL fragment, not query.** `#token=<uuid>`, not
   `?token=`. Fragment never hits the server log.

7. **No auto-deploy.** This repo isn't deploy-connected to anything
   today, but per the user's preferences: **commit locally, ask
   before push**.

## Tests + Superpowers usage

- `cd sidecar && npm test` runs the 41 backend tests (Vitest).
  Don't break these.
- `cd web && npm test` runs the React component tests (68 after
  Settings). Keep them green.
- `cd web && npm run typecheck` runs `tsc -b --noEmit` on the React
  code. Keep it clean.
- Use `/test-driven-development` for each component: write the test
  first, watch it fail, write minimal code to pass. The Settings
  migration followed this strictly — the bug fixes that came up
  (api.ts lazy token, .set-card transform-containing-block) were all
  caught by tests written before the code.
- Use `/systematic-debugging` when a migration produces a visual
  regression — don't just tweak CSS until it looks right. Read source
  first.
- Use `/verification-before-completion` before marking each tab
  done: side-by-side comparison with the old app must match.

## What previous sessions shipped (so you don't redo it)

### Session 1 — scaffold (commits ending `4d5d594`)

Set up `web/` with Vite + React + TS, the Bearer-token API client,
and a placeholder /health page. No tests yet.

### Session 2 — Settings tab (commits `de9857f`, `5196f1c`)

Migrated the entire Settings tab from `app.html` to React with TDD.

- **6 cards landed:** Billing cycle (custom dropdown w/ chevron),
  Spending projection (switch + segmented control), Credit-card bills
  (switch + 6 brand chips + custom-matcher input), Categories panel
  (full CRUD against `/categories` + emoji/colour pickers), AI engine
  stub, Splitwise stub.
- **App tab nav landed** with Health + Settings tabs.
- **Test harness:** Vitest + jsdom + React Testing Library +
  `installFetchMock` helper. 68 passing tests. Typecheck clean.
- **CSS lifted** from `app.html` for every selector the React code
  uses. Theme tokens, set-card grid, switch, segmented control,
  dropdown, chips, custom-matchers, cat-tiles, modal+overlay,
  fade-up animation.
- **Bug fixes driven by TDD:** `api.ts` was reading the token at
  module load (broke jsdom tests with `window.location.hash` set
  post-import); fixed to read lazily. `'PUT'` was missing from the
  `method` union. Modal positioning broke inside `.set-card` due to
  identity-transform containing block; fixed via React Portal.
- **Deferred (call-outs in code comments):**
  - AI engine card body — needs `/llm/*` flow
  - Splitwise card body — needs `/splitwise/*` OAuth + state
  - Pre-delete txn count in remove-category dialog — needs
    transactions context (lands with Activity tab)

### Older history (engine fixes from the pre-React session)

12 commits to `main` before the scaffold: pension regex fix, voucher
cancel fixes, XSS guard, brokerage chart respecting account filter,
CLAUDE.md, Vitest harness with 41 backend tests. Plus a code review
with 6 minor findings still unfixed — none blocking the migration.

## When the migration is done

Last step: replace the engine's `/` route to serve the React build
output instead of `app.html`. In `sidecar/src/server.ts`, change:

```ts
app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(webAppHtml));
```

…to read from `web/dist/index.html` and serve `web/dist/assets/*`
statically. The build step becomes:

```bash
cd web && npm run build
# dist/ is now the engine's UI
```

Until that switch, both UIs coexist. Users on `npm run web` get the
old one; you and any tester get the new one via `cd web && npm run
dev` + the token URL.

---

**Good luck. Take it slow. Tab by tab.**
