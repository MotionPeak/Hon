# PROJECT-RULES.md — Hon working agreements

> **Read this before any code change.** Behavioral rules for Claude
> working on Hon. Code-level architecture is in [CLAUDE.md](CLAUDE.md);
> current-session state is in [HANDOFF.md](HANDOFF.md).

---

## 1. Don't break my dev server

- **NEVER call `preview_start`.** Shahar runs his own vite dev server
  outside the Claude harness; `preview_start` collides with it. The
  PostToolUse hook will suggest it after edits — ignore the hook, this
  rule wins.
- The engine is started with `cd Hon && npm run dev` (concurrently
  launches sidecar engine on `:4000` + vite on `:5173`). Don't start
  it yourself unless asked.
- HMR is on. Edits to `web/src/**` propagate automatically once vite
  is running. Browser cache can stick — when verifying, navigate with
  `reload + ignoreCache: true` to bust it.

## 2. Visual verification workflow (USE THIS — don't ask for screenshots)

When changing anything observable in the browser (CSS, JSX layouts,
component state), **verify it yourself** instead of asking Shahar
to screenshot. Workflow:

### Setup (once per session, only if Chrome-devtools MCP isn't already connected)

```bash
# Launch a headed Chrome with CDP on 9222, in a throwaway profile so
# it doesn't touch Shahar's main browser.
mkdir -p /tmp/chrome-cdp-profile
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-cdp-profile \
  --no-first-run --no-default-browser-check \
  >/tmp/chrome-cdp.log 2>&1 &
sleep 2
```

Confirm with `curl -s http://127.0.0.1:9222/json/version` — should
return `{ "Browser": "Chrome/...", ... }`.

### Loading the app

```
TOKEN=$(cat "$HOME/Library/Application Support/Hon/dev-token")
# Navigate via mcp__chrome-devtools__new_page:
#   url: http://localhost:5173/#token=<TOKEN>
```

The dev token is persisted to `<dataDir>/dev-token` and stable across
restarts — read it from disk, don't ask.

### Verifying a UI change

1. Make the code change.
2. `mcp__chrome-devtools__navigate_page { type: "reload", ignoreCache: true }`
3. `mcp__chrome-devtools__take_snapshot` — text view of the page, cheap.
4. `mcp__chrome-devtools__click { uid }` to navigate to the affected
   component (e.g. Assets tab → Add Account button).
5. `mcp__chrome-devtools__take_screenshot { filePath: "/tmp/x.png" }`
6. `Read /tmp/x.png` to see it.
7. **If something's off, debug via `evaluate_script`** —
   `getComputedStyle`, walk the DOM, inspect what the browser actually
   sees. Don't guess at CSS.

### Don't claim "fixed" without seeing it

Tests passing ≠ UI works. CSS bugs in particular slip past every test
suite. After any visual change: screenshot, read it, confirm with your
own eyes, THEN commit. If you can't verify visually (chrome-devtools
not available, no token, etc.), say so explicitly — don't bluff.

## 3. Branch + push policy

- **Stay on `main`.** No PR / feature branches in this repo.
- **Never push to origin without an explicit "push" from Shahar.**
  Netlify/Vercel-style deploy hooks aren't in play for Hon, but the
  habit avoids surprise releases (Motion Peak, Tal's Food Art etc.
  are deploy-connected — same rule everywhere).
- **Never** `--no-verify`, **never** amend a published commit,
  **never** force-push.
- `git commit` freely. One commit per logical change. Tight commit
  messages — what + why, not what code looks like.

## 4. Workflow discipline (when the task warrants it)

Multi-step features:

1. **`superpowers:brainstorming`** — clarify intent + propose 2-3
   approaches + present design sections. Write spec to
   `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
2. **`superpowers:writing-plans`** — convert spec to TDD-ordered task
   list at `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`. Each task
   = test → minimal impl → commit.
3. **`superpowers:executing-plans`** — execute inline, atomic commits
   per task. Batch verifications between tasks.

Skip the ceremony for trivial single-file changes; use it for anything
that touches more than one file or has multiple TDD cycles.

Apply `vercel-react-best-practices` to React work:
- Lazy-load heavy components (`bundle-dynamic-imports`)
- Sub-views at module level, never nested (`rerender-no-inline-components`)
- `useDeferredValue` for search filters on long lists
- `use-latest` ref pattern for callbacks in polling/interval hooks

## 5. Tests

- `cd web && npm test` → all web tests (315+).
- `cd sidecar && npm test` → sidecar logic tests (55+).
- `cd web && npm run typecheck` → strict TS check.
- `cd sidecar && npm run typecheck` → strict TS check.
- **Both must pass before commit.** Typecheck failures in test files
  also count.
- Sidecar tests cover pure logic only — no live SnapTrade SDK calls,
  no Puppeteer launches. Route handlers in `server.ts` are tested
  manually (per existing convention).
- **Fake-timer + Testing-Library waitFor deadlock:** use
  `vi.useFakeTimers({ shouldAdvanceTime: true })` so `waitFor` can
  still run. The `shouldAdvanceTimeDelta` option works at runtime
  but isn't in vitest's TS defs — omit it.
- **Test wrappers that model parent-owned unmount:** for tests where a
  child's "Cancel" should also unmount it, wrap in a tiny `Harness`
  parent. SnapTradeLinkFlow.test.tsx has the pattern.

## 6. Hon-specific reminders (the load-bearing ones)

These keep biting us; read once, remember forever:

- **`TXN_COLS` in `sidecar/src/repo.ts`** is the bare-SELECT for
  transactions. Add a new column to the `transactions` table? Add it
  to TXN_COLS too, or the React UI silently loses it.
- **Hebrew `\b` doesn't anchor** — Hebrew chars aren't `\w`. Use bare
  substring for Hebrew alternatives, `\b…\b` only for Latin.
- **`POST /connections` returns `{ connection }`** (full Connection
  shape from `repo.createConnection`). Destructure as
  `const created = await api<{ connection: Connection }>(...)`.
- **Token in URL fragment, not query.** `api.ts` reads lazily so
  jsdom tests that set `window.location.hash` post-import work.
- **Israeli bank scrapers' OTP gotcha.** Pass `{ interactive: true, monthsBack }`
  for any company in `HON_OTP_WATCHER_COMPANIES` (Beinleumi, Hapoalim,
  Otsar Hahayal, Massad, Pagi). Headless hangs at LOGGING_IN otherwise.
- **`button { white-space: nowrap }`** is the global default. Any
  custom button-as-card needs to override it explicitly. (Bit us on
  the Add-asset tile picker.)

Everything else lives in [CLAUDE.md](CLAUDE.md).

## 7. Memory & context

- Use `mcp__plugin_context-mode_context-mode__*` for processing —
  filter, count, parse, aggregate. Don't pull raw command output into
  the conversation when you only need a derived fact.
- Use `ctx_search(queries: ["...", "..."], sort: "timeline")` on
  session resume to recall prior decisions before asking Shahar.
- Update Shahar's auto-memory at
  `~/.claude/projects/-Users-shaharsolomons-Documents-Code/memory/`
  when a project's high-level state changes (milestone shipped,
  pivot, etc.) — don't duplicate CLAUDE.md content there.

## 8. When the task is multiple skills

`superpowers:using-superpowers` priority order:
1. **Process skills first** (brainstorming, debugging) — they
   determine HOW.
2. **Implementation skills second** (vercel-react-best-practices,
   frontend-design).

For "build feature X": brainstorming → writing-plans → executing-plans
→ vercel-react-best-practices folded into the plan's code blocks.

## 9. What goes where

| Doc | Purpose | Update when |
|---|---|---|
| `PROJECT-RULES.md` (this file) | Behavioral rules Claude must follow | New durable rule emerges |
| `CLAUDE.md` | Code architecture + non-obvious code reasons | Architecture changes; new load-bearing pattern |
| `HANDOFF.md` | Current-session bridge: what's shipped, what's deferred, restart workflow | Every session end |
| `docs/CODE-REVIEW-*.md` | Multi-agent code review findings (HIGH/MEDIUM/LOW, splits, intentional patterns) | After each /ultrareview-style audit; read before planning new work |
| `docs/superpowers/specs/` | Design docs per feature | One per feature/phase |
| `docs/superpowers/plans/` | TDD-ordered impl plans per feature | One per feature/phase |

If you find yourself thinking "where does this note belong?" — durable
behavioral rule lands here, code reason lands in CLAUDE.md, session
state lands in HANDOFF.md.
