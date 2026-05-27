# Sync window & completion feedback — design

**Date**: 2026-05-27
**Topic**: Per-connection history window, completion pill, faster re-sync via existing DB dedup
**Worktree**: `.claude/worktrees/sync-window-12mo-2026-05-27/`
**Branch**: `session/sync-window-12mo-2026-05-27`

## Problem

The React app at `web/` only ends up with ~2 months of transactions in the
DB after syncing, even though the React `startSync` already sends
`monthsBack: 24` to `POST /connections/:id/scrape`. Three independently
useful symptoms drove the spec:

1. **Activity tab** month picker runs out after ~2 months.
2. **Insights → Spending** 12-month bar chart only renders 2 filled bars.
3. **sqlite3 hon.db** shows ~2 months of rows for affected connections.

The legacy SPA pulls a full year for the same connections. Diff in
behavior comes from the engine's `chooseStartDate` shortcut: for any
non-card connection with a recent successful scrape, the next sync only
rewinds 14 days from `lastSuccess`. Once a connection's first sync was
small (e.g. a default monthsBack of 2 in some legacy code path or a
scraper-library internal cap), every subsequent sync stays small.

Two further asks bundled in:

- **Completion feedback**: after sync ends, the connection card flips
  silently to idle. No "done, N transactions" message — even though
  the runner already builds that string (`runner.ts:346`).
- **Faster re-sync**: "fetch everything again, but skip what's already
  in the DB so it's quick." Partially shipped (DB has
  `UNIQUE(account_id, external_id)` so persistence is free for
  overlap), but the user wants the speedup visible and trusted.

## Goals

- **G1**: Every sync pulls at least a full 12 months by default,
  recoverable down to 1 month or up to 24 months **per connection**.
- **G2**: The Settings UI per connection exposes the history window
  ([3, 6, 12, 18, 24] quick picks).
- **G3**: After a successful sync, the connection card shows
  `✓ Done — N transactions` inline for ~5s, then returns to idle.
- **G4**: Re-syncs are demonstrably fast on the persistence side
  (existing DB-level dedup, surfaced via a new `persist.skipped` log
  line so the speedup is visible).

## Non-goals

- No global toast system (we already considered and rejected this).
- No "Backfill 12 months" separate button — covered by the default change.
- No bank-side month-skipping (Israeli scrapers fetch by date range,
  not by month; the library doesn't expose this).
- No change to credit-card behavior (`CARD_COMPANIES` already use the
  full requested window; this design subsumes that behavior into the
  general path).

## Design

### 1. Data model

**Migration 35** in `sidecar/src/db.ts`:

```sql
ALTER TABLE connections ADD COLUMN history_months INTEGER NOT NULL DEFAULT 12;
```

- Defaults every existing connection to 12 immediately — recovery is
  automatic on the next sync.
- Range `[1, 24]` enforced at API + repo layer (no DB CHECK constraint;
  matches the schema's permissive style).
- Schema rolls from `SCHEMA_VERSION = 34` to `35`.

### 2. Repo surface

`sidecar/src/repo.ts`:

- `Connection` type gains `historyMonths: number`.
- The bare-SELECT used by `listConnections()` / `getConnection()`
  (analogous to `TXN_COLS`) gains `history_months AS historyMonths`.
  **Adding this is load-bearing — same hazard as `TXN_COLS`.**
- New method: `setConnectionHistoryMonths(id: string, months: number): Connection`.
  Validates `[1, 24]` (throws on out-of-range). Returns the updated row.

### 3. Engine sync behavior

`sidecar/src/runner.ts` — gut `chooseStartDate`:

```ts
private chooseStartDate(_connectionId: string, _companyId: string, monthsBack: number): Date {
  return startDateMonthsAgo(monthsBack);
}
```

- `CARD_COMPANIES` constant is **removed** — `chooseStartDate` was its
  only consumer (verified by grep). Keeping it would trip the
  no-unused-vars rule.
- `BANK_SESSION_DENYLIST` stays — still referenced by the bank-session
  branches in `execute()` (lines ~239, ~255). Max session-replay still
  breaks; that mitigation is unrelated to the history-window change.
- `lastSuccessfulScrapeAt` continues to be logged in `execute()` as
  informational metadata, but no longer drives `startDate`.

**Add one new log line** in `execute()` after persist:

```ts
log.info('persist.skipped', {
  fetched: outcome.accounts.reduce((s, a) => s + a.transactions.length, 0),
  saved: saved.transactions,
  skipped: outcome.accounts.reduce((s, a) => s + a.transactions.length, 0) - saved.transactions,
});
```

Makes the "of N fetched, only M were new" speedup visible and provable.

### 4. Server routes

`sidecar/src/server.ts`:

**`POST /connections/:id/scrape`** — body `{ interactive, monthsBack? }`:
- If `monthsBack` is a finite number → clamp `[1, 24]`, use it (manual override).
- If absent → load `connection.historyMonths` from repo, use that.
- (Today: hard fallback to 12 if missing. Replaced with per-connection lookup.)

**`PATCH /connections/:id/history-months`** (NEW) — body `{ historyMonths }`:
- 400 on missing / non-integer / out-of-range.
- 404 on unknown connection id.
- 401 without token (route is token-gated like every other).
- 200 with the updated `Connection` shape.

### 5. React UI

`web/src/accounts/AccountsView.tsx`:

**`startSync`**: drop hard-coded `monthsBack: 24`. Body is `{ interactive: true }`
only. Engine picks the per-connection window.

**`SyncState` discriminator gains a new variant**:

```ts
type SyncState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; runId: string; message: string }
  | { kind: 'needs-otp'; runId: string; message: string }
  | { kind: 'success'; accountsCount: number; transactionsCount: number }  // NEW
  | { kind: 'error'; message: string };
```

`pollRun` on `status === 'success'`:

1. Set `{ kind: 'success', accountsCount, transactionsCount }`.
2. `await refresh()`.
3. `pollTimers.current[id] = setTimeout(() => setSyncForConnection(id, { kind: 'idle' }), 5000)`.

Existing unmount-cleanup clears the timer (no extra plumbing needed).

**Render**: inside whichever child currently renders the sync pill (the
"Syncing — Reading transactions…" badge), branch on `sync.kind === 'success'`
to emit:

```tsx
<span className="sync-pill sync-pill-success" role="status">
  ✓ Done — {sync.transactionsCount} transactions
</span>
```

`.sync-pill-success` reuses `.sync-pill`'s shape; green tint via
existing token palette. Fade-out respects `prefers-reduced-motion`.

**Settings drawer — history window**:

Inside the per-connection settings drawer (next to "Disable sync",
"Delete connection"):

> **History window**: `[ 12 ▾ ] months`

- Radix `<Select>` with options `[3, 6, 12, 18, 24]`.
- Reads initial value from `connection.historyMonths`.
- PATCHes `/connections/:id/history-months` on change.
- Optimistic update (matches `toggleAccountExcluded` pattern); reverts
  to stored value on error.

### 6. Types & API contract

`web/src/accounts/types.ts` — `Connection` type gains
`historyMonths: number`. Existing test fixtures that build a
`Connection` need the field added (validate by typecheck).

## Testing strategy

### Sidecar (vitest, no live SDK / Puppeteer)

1. `db.test.ts` — migration 35 adds `history_months` with default 12 on
   existing v34 rows.
2. `repo.test.ts`:
   - `getConnection` / `listConnections` return `historyMonths`.
   - `setConnectionHistoryMonths(id, 18)` persists.
   - Out-of-range values throw.
3. `runner.test.ts`:
   - `chooseStartDate` returns `startDateMonthsAgo(monthsBack)` for all
     branches (cards, non-cards, with/without `lastSuccess`).
   - Old `lastSuccess - 14d` branch tests deleted.
4. `server.test.ts`:
   - `POST /connections/:id/scrape` body `{}` → runner gets
     `monthsBack === connection.historyMonths`.
   - Body `{ monthsBack: 6 }` → override wins.
   - Body `{ monthsBack: 99 }` → clamped to 24.
   - `PATCH /history-months` — 200 / 400 / 404 / 401 cases.

### Web (vitest + Testing Library)

5. `AccountsView.test.tsx` — extend "clicking sync POSTs and polls":
   - Body sent is `{ interactive: true }` (no `monthsBack`).
   - On success-poll, pill `✓ Done — 42 transactions` renders.
   - After 5s (fake timers, `shouldAdvanceTime: true`), pill is gone.
   - Unmount mid-pill clears the timer cleanly.
6. `AccountsView.test.tsx` or a new file for settings drawer:
   - History-window Select renders current value.
   - Change to `18` PATCHes `/connections/:id/history-months`
     `{ historyMonths: 18 }`.
   - 400 from server reverts the select.

### Manual verification (PROJECT-RULES.md §2)

- chrome-devtools MCP: load app → trigger sync → confirm pill rendered →
  screenshot.
- sqlite check:
  `SELECT MIN(date) FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = '<id>')`
  shows ≥ 365 days back.

### Test count delta

- Sidecar baseline 55 → ~63 (+8).
- Web baseline 315 → ~327 (+12).

## Files touched

| File | Approx LOC delta |
|---|---|
| `sidecar/src/db.ts` | +10 (migration 35) |
| `sidecar/src/repo.ts` | +30 (type, SELECT, setter) |
| `sidecar/src/runner.ts` | net −8 (gut shortcut, add log line) |
| `sidecar/src/server.ts` | +25 (per-conn default, PATCH route) |
| `web/src/accounts/types.ts` | +2 |
| `web/src/api.ts` | 0 (no shape changes) |
| `web/src/accounts/AccountsView.tsx` | +60 (success variant, pill, settings select) |
| `web/src/accounts/*.test.tsx` | +120 |
| `sidecar/src/*.test.ts` | +80 |
| `HANDOFF.md` | end-of-session refresh |

**Net: ~7 source files, ~10 test files, ~320 LOC.**

## Risks

| Risk | Mitigation |
|---|---|
| Israeli scrapers internally cap at < 12 months for some companies (Max may default to 60d) | Hard ceiling we can't change in this PR. Documented limit. Follow-up phase to thread explicit `startDate` deeper into scrapers if it bites. |
| OTP-walled banks (Hapoalim/Beinleumi) now refetch full 12 months every sync | OTP cost is per-sync, not per-month. User already pays this. Network delta is seconds. |
| Stale `Connection` type fixtures in tests | Typecheck catches; listed in plan. |
| 5s pill timer leaks on unmount | `pollTimers.current[id]` cleanup catches it (existing pattern). |
| Worktree-vs-main collision | PROJECT-RULES.md §3 worktree pattern handles. Topic slug `sync-window-12mo`. |

## Rollout

Single PR / session worktree. No feature flag — small surface, DB dedup
keeps the heavier window cost-free on persistence. Recovery for existing
2-month-only connections is automatic via the migration's default + the
gutted shortcut: the next user-triggered sync per connection pulls 12
months and `INSERT OR IGNORE` fills gaps.

## Open questions

None at spec-approval time.

## Out of scope (deferred)

- Threading explicit `startDate` into bank scraper configs to bypass
  library-internal caps. (Phase 2 if any specific bank still under-pulls.)
- Toast system / global notification primitive.
- Auto-retry on partial-sync failures.
