# HANDOFF.md — React migration for Hon

> **Read this first.** This is the bridge between two Claude Code
> sessions. The previous session shipped 12 fixes, a code-review pass,
> Vitest tests, and this handoff. It then set up the Vite/React/TS
> scaffold under `web/` and committed everything. The next session
> (yours) picks up here.

## TL;DR

- The engine (`sidecar/`) is **untouched**. Same DB, same APIs, same
  scrapers, same token-on-URL-fragment auth. Don't change it without
  a strong reason.
- The new React UI lives in `web/`. It's a working Vite + React + TS
  scaffold (a single page that calls `/health` and renders the
  result). `npm run dev` works.
- The **old vanilla SPA** at `sidecar/public/app.html` is still the
  one users hit when they run `npm run web`. It stays live until each
  tab has been migrated to React.
- Your job is to migrate `app.html` tab-by-tab into React components
  under `web/src/`. **Do not attempt a big-bang rewrite** — the file
  is ~10k lines, hebrew/RTL, financial UI, charts, modals. Migrate
  incrementally so you can verify visually after each tab.

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

1. **Health + chrome** (shell, header, tab nav) — get the skeleton
   right. The current TABS array in app.html is:
   `overview, activity, accounts, vouchers, loans, recurring,
   subscriptions, piggy, insights, settings`.
2. **Settings** — simple forms, low risk, lots of state pattern
   you'll reuse elsewhere. Categories tile grid is here.
3. **Accounts** — list + balances. Mostly read-only display.
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

For React, the simplest path:

- **One React Context** for global state (connections, accounts,
  transactions, summary, settings — the truly shared stuff).
- **`useState` + `useEffect`** inside individual tab components for
  view-local state (filters, search, expanded rows).
- **No Redux/Zustand/etc** unless you find a real need. Hon's state
  is read-heavy and doesn't have the deep update-derivation chains
  that Redux solves.

A minimal pattern in `web/src/state/`:

```tsx
// web/src/state/Store.tsx
const StoreContext = createContext<Store | null>(null);
export function StoreProvider({ children }) { ... }
export function useStore() { ... }
```

Start with whatever's needed for the first tab, expand as you go.

## Migration gotchas to know before you start

These bit the previous session. Pin them in your test cases:

1. **RTL Hebrew text.** Mix of Hebrew (merchants, account names)
   and English (numbers, brand names). The old CSS uses `direction:
   rtl` at the root + `dir="ltr"` on numeric spans. Replicate.

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
- `cd web && npm run typecheck` runs `tsc -b --noEmit` on the React
  code. The scaffold passes; keep it green.
- Add React component tests as you go. Set up `@testing-library/react`
  + `vitest` in `web/` when you start the first non-trivial component.
  (Out of scope for the scaffold.)
- Use `/test-driven-development` for each component: write the test
  for "Settings tab renders the categories from /categories" first,
  then implement.
- Use `/systematic-debugging` when a migration produces a visual
  regression — don't just tweak CSS until it looks right.
- Use `/verification-before-completion` before marking each tab
  done: side-by-side comparison with the old app must match.

## What the previous session shipped (so you don't redo it)

Most recent 12 commits on `main` (oldest → newest):

1. `e50bd0a` — Pension login URL regex fix (Menora)
2. `af99435` — HTZ cancel actually cancels
3. `7376a6c` — BuyMe cancel same fix
4. `fd455e2` — Voucher card XSS guard
5. `b6a40a6` — HTZ prefers real Chrome
6. `ed971c1` — HTZ balance wait + retry + wrong-code error
7. `4f598c3` — HTZ modal frontend race + timer leak
8. `30e5109` — Brokerage chart + tile respect account filter
9. `ae06b9a` — CLAUDE.md (architecture map)
10. `5630570` — Vitest harness + 41 tests
11. `<this commit>` — Vite/React/TS scaffold + HANDOFF.md

Plus a code review (15 findings; top 9 fixed). The remaining 6
findings are minor UX/correctness issues in voucher scrapers and
chart logic — not blockers, but worth folding into the migration
naturally.

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
