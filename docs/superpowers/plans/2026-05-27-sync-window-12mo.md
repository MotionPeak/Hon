# Sync Window & Completion Pill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-connection `history_months` column (default 12) drives every sync's start-date; the `lastSuccess`-based incremental shortcut is removed; React shows `✓ Done — N transactions` for ~5s after sync; engine logs a `persist.skipped` line so DB-level dedup is visibly the speedup it has always been.

**Architecture:** New `connections.history_months` column (migration **36** — schema is already at v35). `runner.chooseStartDate` reduces to `startDateMonthsAgo(monthsBack)`. `POST /connections/:id/scrape` falls back to the connection's column when the request omits `monthsBack`. New `PATCH /connections/:id/history-months` exposes per-connection control. React sends `{ interactive: true }` only, gains a `success` `SyncState` variant + 5s auto-clear, and renders an inline `<select>` for the history window on the connection card.

**Tech Stack:** TypeScript strict, Fastify, better-sqlite3, React 19, Vitest + Testing Library. All commits via the session worktree at `.claude/worktrees/sync-window-12mo-2026-05-27/` on branch `session/sync-window-12mo-2026-05-27`.

**Spec reference:** `docs/superpowers/specs/2026-05-27-sync-window-12mo-design.md`.

**Worktree setup:** Already created. All edits land in
`/Users/shaharsolomons/Documents/Code/Hon/.claude/worktrees/sync-window-12mo-2026-05-27/`.
All `cd` commands and paths in this plan are relative to that worktree
unless absolute.

**Verification baseline (run once at the start, before Task 1):**

```bash
cd web && npm test -- --run    # expect 315 passing
cd ../sidecar && npm test -- --run    # expect 55 passing
cd ../web && npm run typecheck    # clean
cd ../sidecar && npm run typecheck    # clean
```

If any of these fail before edits, stop and investigate — the plan assumes a green baseline.

---

## File Structure

**Files modified:**

| File | Responsibility |
|---|---|
| `sidecar/src/db.ts` | Add migration v36, bump `SCHEMA_VERSION` |
| `sidecar/src/repo.ts` | `Connection` type + `historyMonths` field; `CONNECTION_COLS` update; new `setConnectionHistoryMonths` |
| `sidecar/src/runner.ts` | Gut `chooseStartDate`; drop unused `CARD_COMPANIES`; add `persist.skipped` log line |
| `sidecar/src/server.ts` | `POST /scrape` reads `connection.historyMonths` when body omits it; new `PATCH /history-months` route |
| `web/src/accounts/types.ts` | `Connection.historyMonths: number` |
| `web/src/accounts/AccountsView.tsx` | Drop hard-coded `monthsBack: 24`; `success` `SyncState` + 5s auto-clear; inline history-months `<select>` |

**Files created:**

| File | Responsibility |
|---|---|
| (none) | All changes extend existing files. Test cases land in existing `*.test.ts`/`*.test.tsx` files. |

---

## Task 1: Migration 36 — add `connections.history_months`

**Files:**
- Modify: `sidecar/src/db.ts`
- Test: `sidecar/src/db.test.ts`

- [ ] **Step 1: Write the failing test**

Open `sidecar/src/db.test.ts` and add this test at the bottom of the existing `describe` (or wherever schema/migration tests live — search for `SCHEMA_VERSION` in the file to find peer tests).

```ts
import { openDatabase, SCHEMA_VERSION } from './db.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('migration 36: connections.history_months exists with default 12', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hon-mig36-'));
  const { db } = openDatabase(dir);

  // Seed a connection without specifying history_months — must take the default.
  db.prepare(
    "INSERT INTO connections (id, company_id, display_name, created_at) VALUES ('c1', 'hapoalim', 'Hapoalim', '2026-01-01')"
  ).run();

  const row = db
    .prepare('SELECT history_months FROM connections WHERE id = ?')
    .get('c1') as { history_months: number };
  expect(row.history_months).toBe(12);
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(36);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd sidecar && npm test -- --run db.test.ts
```

Expected: FAIL — `no such column: history_months` or similar.

- [ ] **Step 3: Add the migration and bump SCHEMA_VERSION**

Edit `sidecar/src/db.ts`:

1. Change `export const SCHEMA_VERSION = 35;` (line 5) to `export const SCHEMA_VERSION = 36;`.
2. Append a new migration entry at the end of the `MIGRATIONS` array (after the v35 `excluded_manual` entry, immediately before the closing `];`):

```ts
  {
    // Per-connection history window. Drives runner.chooseStartDate
    // and POST /connections/:id/scrape's default monthsBack. Range
    // [1, 24] enforced at API + repo layer (no DB CHECK constraint).
    // Default 12 means every existing connection recovers to a full
    // year on its next sync — see runner.ts where the lastSuccess-
    // based incremental shortcut was removed in the same change.
    version: 36,
    sql: `ALTER TABLE connections ADD COLUMN history_months INTEGER NOT NULL DEFAULT 12;`,
  },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd sidecar && npm test -- --run db.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/db.ts sidecar/src/db.test.ts
git commit -m "sidecar: migration 36 — connections.history_months default 12"
```

---

## Task 2: `Connection` type + `CONNECTION_COLS` carry `historyMonths`

**Files:**
- Modify: `sidecar/src/repo.ts` (lines ~280–283 `CONNECTION_COLS`, plus the `Connection` interface and `ConnectionRow`/`toConnection` shape — search for `interface Connection {` and `function toConnection(`)
- Test: `sidecar/src/repo.test.ts`

- [ ] **Step 1: Find the `Connection` interface and its DB-row mapper**

In `sidecar/src/repo.ts`, search for:
- `export interface Connection {` (the user-facing type)
- `interface ConnectionRow {` or similar (the raw DB row)
- `function toConnection(` (the row→Connection mapper)
- `const CONNECTION_COLS =` (the bare-SELECT — already located at lines ~280–283)

Note their line numbers for Step 3.

- [ ] **Step 2: Write the failing test**

In `sidecar/src/repo.test.ts`, add:

```ts
it('getConnection returns historyMonths', () => {
  const { repo } = makeRepo(); // existing helper in the test file
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  const fetched = repo.getConnection(c.id);
  expect(fetched?.historyMonths).toBe(12);
});

it('listConnections returns historyMonths', () => {
  const { repo } = makeRepo();
  repo.createConnection('hapoalim', 'Hapoalim');
  const all = repo.listConnections();
  expect(all.every((c) => c.historyMonths === 12)).toBe(true);
});
```

If `makeRepo` is not the helper name in this file, scan the top of `repo.test.ts` for the helper and use whatever name it has. Do NOT invent new helpers.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd sidecar && npm test -- --run repo.test.ts
```

Expected: FAIL — `Property 'historyMonths' does not exist on type 'Connection'`.

- [ ] **Step 4: Add the field everywhere**

In `sidecar/src/repo.ts`:

1. **Update the `Connection` interface** (search `export interface Connection {`):

```ts
export interface Connection {
  id: string;
  companyId: string;
  displayName: string;
  createdAt: string;
  lastScrapeAt: string | null;
  lastStatus: string | null;
  hasCredentials: boolean;
  /** Months of transaction history to fetch each sync. Default 12; range [1, 24]. */
  historyMonths: number;
}
```

2. **Update `ConnectionRow`** (or whatever the DB-row type is — search `ConnectionRow`):

Add `historyMonths: number` to the DB-row shape so the SELECT result is typed correctly.

3. **Update `CONNECTION_COLS`** at lines ~280–283:

```ts
const CONNECTION_COLS =
  'c.id, c.company_id AS companyId, c.display_name AS displayName, ' +
  'c.created_at AS createdAt, c.last_scrape_at AS lastScrapeAt, ' +
  'c.last_status AS lastStatus, c.history_months AS historyMonths, ' +
  '(cr.connection_id IS NOT NULL) AS hasCredentials';
```

4. **Update `toConnection`** if it doesn't pass through unknown fields. If it spreads (`return { ...row }`) the new field is carried automatically; if it picks fields explicitly, add `historyMonths: row.historyMonths`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd sidecar && npm test -- --run repo.test.ts
cd sidecar && npm run typecheck
```

Both expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/repo.ts sidecar/src/repo.test.ts
git commit -m "sidecar: surface historyMonths through Connection / CONNECTION_COLS"
```

---

## Task 3: `repo.setConnectionHistoryMonths` — write path + validation

**Files:**
- Modify: `sidecar/src/repo.ts`
- Test: `sidecar/src/repo.test.ts`

- [ ] **Step 1: Write the failing tests**

In `sidecar/src/repo.test.ts`:

```ts
it('setConnectionHistoryMonths persists the new value', () => {
  const { repo } = makeRepo();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  const updated = repo.setConnectionHistoryMonths(c.id, 18);
  expect(updated.historyMonths).toBe(18);
  expect(repo.getConnection(c.id)?.historyMonths).toBe(18);
});

it('setConnectionHistoryMonths rejects values below 1', () => {
  const { repo } = makeRepo();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  expect(() => repo.setConnectionHistoryMonths(c.id, 0)).toThrow(/range/i);
  expect(() => repo.setConnectionHistoryMonths(c.id, -1)).toThrow(/range/i);
});

it('setConnectionHistoryMonths rejects values above 24', () => {
  const { repo } = makeRepo();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  expect(() => repo.setConnectionHistoryMonths(c.id, 25)).toThrow(/range/i);
  expect(() => repo.setConnectionHistoryMonths(c.id, 99)).toThrow(/range/i);
});

it('setConnectionHistoryMonths rejects non-integer values', () => {
  const { repo } = makeRepo();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  expect(() => repo.setConnectionHistoryMonths(c.id, 12.5)).toThrow(/integer/i);
});

it('setConnectionHistoryMonths throws on unknown connection id', () => {
  const { repo } = makeRepo();
  expect(() => repo.setConnectionHistoryMonths('does-not-exist', 12))
    .toThrow(/not found/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sidecar && npm test -- --run repo.test.ts
```

Expected: FAIL — `repo.setConnectionHistoryMonths is not a function`.

- [ ] **Step 3: Add the method**

In `sidecar/src/repo.ts`, find the existing connection mutators (search for `deleteConnection` or `setConnectionStatus`). Add this method nearby:

```ts
/**
 * Updates the per-connection history window used by sync.
 *
 * Validates [1, 24] (matches the API-layer clamp). Throws on out-of-range
 * or non-integer input, and on unknown connection id, so the server
 * route can rely on the throw to translate into a 4xx.
 */
setConnectionHistoryMonths(id: string, months: number): Connection {
  if (!Number.isInteger(months)) {
    throw new Error(`historyMonths must be an integer, got ${months}`);
  }
  if (months < 1 || months > 24) {
    throw new Error(`historyMonths out of range [1, 24]: ${months}`);
  }
  const result = this.db
    .prepare('UPDATE connections SET history_months = ? WHERE id = ?')
    .run(months, id);
  if (result.changes === 0) {
    throw new Error(`connection not found: ${id}`);
  }
  return this.getConnection(id)!;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sidecar && npm test -- --run repo.test.ts
cd sidecar && npm run typecheck
```

Both expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/repo.ts sidecar/src/repo.test.ts
git commit -m "sidecar: repo.setConnectionHistoryMonths with [1,24] validation"
```

---

## Task 4: Gut `chooseStartDate` — always use full monthsBack

**Files:**
- Modify: `sidecar/src/runner.ts`
- Test: `sidecar/src/runner.test.ts` (if it exists — otherwise inline behavior covered via Task 6's server tests)

- [ ] **Step 1: Check whether `runner.test.ts` exists**

```bash
ls sidecar/src/runner.test.ts 2>/dev/null && echo EXISTS || echo MISSING
```

If MISSING: skip the test-add step in this task; coverage is provided by the server test in Task 6 (which exercises the runner via `runner.start`). If EXISTS: proceed with Step 2.

- [ ] **Step 2: Write the failing test (only if runner.test.ts exists)**

Add to `sidecar/src/runner.test.ts`:

```ts
it('chooseStartDate ignores lastSuccess and returns startDateMonthsAgo(monthsBack)', () => {
  // chooseStartDate is private; test by observing behavior through runner.start.
  // Verify the runner passes startDate = ~12 months ago even when lastSuccess
  // is recent.
  // (Concrete shape depends on existing test helpers in this file — mirror them.)
});
```

If runner.test.ts has no existing pattern for mocking the repo's `lastSuccessfulScrapeAt`, skip this step and rely on Task 6.

- [ ] **Step 3: Strip `chooseStartDate`**

In `sidecar/src/runner.ts`:

1. **Delete `CARD_COMPANIES`** (lines ~33–36):

```ts
// (remove the whole declaration block)
const CARD_COMPANIES = new Set(['max', 'visaCal', 'isracard', 'amex']);
```

The comment block above it can also be removed — search for `Companies whose "balance" is the next-bill outstanding` and remove that paragraph.

2. **Replace `chooseStartDate`** body (lines ~125–136). Before:

```ts
private chooseStartDate(connectionId: string, companyId: string, monthsBack: number): Date {
  if (CARD_COMPANIES.has(companyId)) return startDateMonthsAgo(monthsBack);
  const lastSuccess = this.repo.lastSuccessfulScrapeAt(connectionId);
  if (lastSuccess) {
    const since = new Date(lastSuccess);
    if (!Number.isNaN(since.getTime())) {
      since.setDate(since.getDate() - 14);
      return since;
    }
  }
  return startDateMonthsAgo(monthsBack);
}
```

After:

```ts
/**
 * Picks the start date for a scrape: always `monthsBack` months ago.
 *
 * Earlier behavior used `lastSuccess - 14d` as an incremental shortcut, but
 * once any connection had a small first sync the shortcut locked it into
 * the same small window forever. Per-connection `historyMonths`
 * (default 12) is now the only knob — DB UNIQUE(account_id, external_id)
 * makes refetching old months a free no-op on persistence.
 */
private chooseStartDate(_connectionId: string, _companyId: string, monthsBack: number): Date {
  return startDateMonthsAgo(monthsBack);
}
```

3. **`lastSuccessfulScrapeAt` is still logged in `execute()` (~line 187) — leave that call.** It's informational.

- [ ] **Step 4: Verify the typecheck passes**

```bash
cd sidecar && npm run typecheck
```

Expected: clean. If TS warns about unused `CARD_COMPANIES` import elsewhere (unlikely — it's module-local), remove that too.

- [ ] **Step 5: Run all sidecar tests**

```bash
cd sidecar && npm test -- --run
```

Expected: all 55 still pass. If any test was asserting the old incremental behavior, delete that test — the spec explicitly removes the shortcut.

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/runner.ts sidecar/src/runner.test.ts 2>/dev/null
git commit -m "sidecar: runner.chooseStartDate — drop lastSuccess shortcut & CARD_COMPANIES"
```

---

## Task 5: Log `persist.skipped` so the speedup is visible

**Files:**
- Modify: `sidecar/src/runner.ts` (`execute` method, after the persist call ~line 297)
- Test: covered by manual log inspection; no automated test needed (logs are stderr-bound and not asserted elsewhere in the suite).

- [ ] **Step 1: Find the persist call**

Search `sidecar/src/runner.ts` for `repo.saveScrapeResult` (around line 297). After this line, the existing code captures `saved.accounts` and `saved.transactions`.

- [ ] **Step 2: Add the log line**

Immediately after `persistDone({ accountsSaved: saved.accounts, transactionsSaved: saved.transactions });` (line ~298), add:

```ts
const txnsFetched = outcome.accounts.reduce((s, a) => s + a.transactions.length, 0);
log.info('persist.skipped', {
  fetched: txnsFetched,
  saved: saved.transactions,
  skipped: txnsFetched - saved.transactions,
});
```

- [ ] **Step 3: Typecheck + tests**

```bash
cd sidecar && npm run typecheck
cd sidecar && npm test -- --run
```

Both expected: clean / all pass.

- [ ] **Step 4: Commit**

```bash
git add sidecar/src/runner.ts
git commit -m "sidecar: log persist.skipped per scrape so DB-level dedup is visible"
```

---

## Task 6: `POST /scrape` uses connection's `historyMonths` when body omits it

**Files:**
- Modify: `sidecar/src/server.ts` (lines ~270–300 — the existing `POST /connections/:id/scrape` handler)
- Test: `sidecar/src/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `sidecar/src/server.test.ts` (use whatever existing helper builds the Fastify app + token; mirror neighbour tests):

```ts
it('POST /connections/:id/scrape uses connection.historyMonths when body omits monthsBack', async () => {
  const { app, repo, runner } = await buildTestServer(); // existing helper shape
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  repo.setConnectionHistoryMonths(c.id, 18);
  // Stub vault to claim credentials exist for this test path.
  // (Reuse whatever stubVault helper neighbour tests use.)
  const startSpy = vi.spyOn(runner, 'start');

  const res = await app.inject({
    method: 'POST',
    url: `/connections/${c.id}/scrape`,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    payload: { interactive: true },
  });
  expect(res.statusCode).toBe(200);
  expect(startSpy).toHaveBeenCalledWith(
    expect.objectContaining({ monthsBack: 18 }),
  );
});

it('POST /connections/:id/scrape lets request body override the per-connection default', async () => {
  const { app, repo, runner } = await buildTestServer();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  repo.setConnectionHistoryMonths(c.id, 18);
  const startSpy = vi.spyOn(runner, 'start');

  const res = await app.inject({
    method: 'POST',
    url: `/connections/${c.id}/scrape`,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    payload: { interactive: true, monthsBack: 6 },
  });
  expect(res.statusCode).toBe(200);
  expect(startSpy).toHaveBeenCalledWith(
    expect.objectContaining({ monthsBack: 6 }),
  );
});

it('POST /connections/:id/scrape clamps monthsBack to [1, 24]', async () => {
  const { app, repo, runner } = await buildTestServer();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  const startSpy = vi.spyOn(runner, 'start');

  await app.inject({
    method: 'POST',
    url: `/connections/${c.id}/scrape`,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    payload: { interactive: true, monthsBack: 99 },
  });
  expect(startSpy).toHaveBeenCalledWith(
    expect.objectContaining({ monthsBack: 24 }),
  );
});
```

If `server.test.ts` does NOT exist or has no existing harness to inject HTTP requests, **stop and ask** before writing one from scratch — the HANDOFF notes that "Route handlers in `server.ts` are tested manually (per existing convention)". In that case, skip Step 2/4 and rely on the React test (Task 9) + manual verification.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sidecar && npm test -- --run server.test.ts
```

Expected: FAIL (assertions or test infrastructure errors).

- [ ] **Step 3: Update the handler**

In `sidecar/src/server.ts`, change lines ~287–290:

Before:

```ts
const monthsBack =
  typeof body.monthsBack === 'number' && Number.isFinite(body.monthsBack)
    ? Math.max(1, Math.min(24, Math.round(body.monthsBack)))
    : 12;
```

After:

```ts
// Per-connection default; body override clamped to [1, 24].
const monthsBack =
  typeof body.monthsBack === 'number' && Number.isFinite(body.monthsBack)
    ? Math.max(1, Math.min(24, Math.round(body.monthsBack)))
    : connection.historyMonths;
```

(The existing `connection` reference is in scope from the `repo.getConnection(id)` call at the top of the handler.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sidecar && npm test -- --run server.test.ts
cd sidecar && npm run typecheck
```

Both expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/server.ts sidecar/src/server.test.ts 2>/dev/null
git commit -m "sidecar: POST /scrape falls back to connection.historyMonths"
```

---

## Task 7: `PATCH /connections/:id/history-months` route

**Files:**
- Modify: `sidecar/src/server.ts`
- Test: `sidecar/src/server.test.ts` (same caveat as Task 6 — skip the automated test if no harness exists)

- [ ] **Step 1: Write the failing tests (skip if no server-test harness)**

```ts
it('PATCH /history-months persists and returns the updated connection', async () => {
  const { app, repo } = await buildTestServer();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  const res = await app.inject({
    method: 'PATCH',
    url: `/connections/${c.id}/history-months`,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    payload: { historyMonths: 18 },
  });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.connection.historyMonths).toBe(18);
  expect(repo.getConnection(c.id)?.historyMonths).toBe(18);
});

it('PATCH /history-months rejects out-of-range values with 400', async () => {
  const { app, repo } = await buildTestServer();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  for (const bad of [0, 25, -1, 12.5]) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/connections/${c.id}/history-months`,
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { historyMonths: bad },
    });
    expect(res.statusCode).toBe(400);
  }
});

it('PATCH /history-months returns 404 on unknown connection', async () => {
  const { app } = await buildTestServer();
  const res = await app.inject({
    method: 'PATCH',
    url: '/connections/does-not-exist/history-months',
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    payload: { historyMonths: 12 },
  });
  expect(res.statusCode).toBe(404);
});

it('PATCH /history-months returns 401 without bearer token', async () => {
  const { app, repo } = await buildTestServer();
  const c = repo.createConnection('hapoalim', 'Hapoalim');
  const res = await app.inject({
    method: 'PATCH',
    url: `/connections/${c.id}/history-months`,
    payload: { historyMonths: 12 },
  });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sidecar && npm test -- --run server.test.ts
```

Expected: FAIL (route not registered).

- [ ] **Step 3: Add the route**

In `sidecar/src/server.ts`, near the other `/connections/:id/...` handlers (after the `/scrape` handler is a good spot), add:

```ts
app.patch('/connections/:id/history-months', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { historyMonths?: unknown };

  // 404 first so callers can distinguish "bad id" from "bad value".
  if (!repo.getConnection(id)) {
    return reply.code(404).send({ error: 'connection not found' });
  }

  const months = body.historyMonths;
  if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > 24) {
    return reply.code(400).send({
      error: 'historyMonths must be an integer in [1, 24]',
    });
  }

  const connection = repo.setConnectionHistoryMonths(id, months);
  return { connection };
});
```

Token-auth: the route inherits whatever auth hook the file uses for the rest of `/connections/*` — no per-route auth needed.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sidecar && npm test -- --run server.test.ts
cd sidecar && npm run typecheck
```

Both expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/server.ts sidecar/src/server.test.ts 2>/dev/null
git commit -m "sidecar: PATCH /connections/:id/history-months"
```

---

## Task 8: React `Connection` type carries `historyMonths`

**Files:**
- Modify: `web/src/accounts/types.ts`
- Modify: any test fixture that constructs a `Connection` literal (typecheck will flag them)

- [ ] **Step 1: Add the field**

In `web/src/accounts/types.ts`, change the `Connection` interface (lines 16–24):

```ts
export interface Connection {
  id: string;
  companyId: string;
  displayName: string;
  createdAt: string;
  lastScrapeAt: string | null;
  lastStatus: string | null;
  hasCredentials: boolean;
  /** Months of transaction history to fetch each sync. Default 12; range [1, 24]. */
  historyMonths: number;
}
```

- [ ] **Step 2: Run typecheck to find fixture call sites**

```bash
cd web && npm run typecheck
```

Expected: typecheck errors at each test fixture that builds a `Connection` literal without `historyMonths`.

- [ ] **Step 3: Add `historyMonths: 12` to each flagged fixture**

For every error of the form `Property 'historyMonths' is missing in type '{...}' but required in type 'Connection'`, edit that test/fixture and add `historyMonths: 12,` to the literal.

- [ ] **Step 4: Verify typecheck is clean**

```bash
cd web && npm run typecheck
cd web && npm test -- --run
```

Both expected: clean / all 315 still pass (or whatever the new baseline is after Task 9's added tests — at this point still 315).

- [ ] **Step 5: Commit**

```bash
git add web/src/accounts/types.ts web/src/**/*.{ts,tsx}
git commit -m "web: Connection.historyMonths threaded through fixtures"
```

---

## Task 9: React — drop hard-coded `monthsBack: 24`, add `success` SyncState

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` (lines 51–56 `SyncState`; line 252–276 `startSync`; line 221–250 `pollRun`; line 666–671 sync render area)
- Test: `web/src/accounts/AccountsView.test.tsx` (extend the existing "clicking sync POSTs and polls" test, around line 427)

- [ ] **Step 1: Write the failing tests**

In `web/src/accounts/AccountsView.test.tsx`, add tests in the `describe` that already covers sync (the one with "clicking sync POSTs to /connections/:id/scrape and polls until success" at line 427). Mirror its setup pattern:

Before writing the new tests, open `AccountsView.test.tsx` at the existing "clicking sync POSTs to /connections/:id/scrape and polls until success" test (line ~427) and copy its mock setup verbatim — you need the same `GET /api/companies` / `GET /api/connections` / `GET /api/accounts` etc. fixtures it uses. The shape below references the same fixture; just make sure `historyMonths: 12` (or `18` where indicated) lives on each `Connection` row in the connections mock.

```ts
const connectionsFixture = [{
  id: 'c-bank-1', companyId: 'hapoalim', displayName: 'Hapoalim',
  createdAt: '2026-01-01T00:00:00Z', lastScrapeAt: null, lastStatus: null,
  hasCredentials: true, historyMonths: 18,
}];

it('sync POST omits monthsBack so engine uses connection default', async () => {
  const postSpy = vi.fn().mockResolvedValue({ runId: 'r-1' });
  installFetchMock({
    'GET /api/companies': () => [{ id: 'hapoalim', name: 'Hapoalim', loginFields: ['username', 'password'], type: 'bank', interactive: true }],
    'GET /api/connections': () => connectionsFixture,
    'GET /api/accounts': () => [],
    'GET /api/assets': () => [],
    'GET /api/loans': () => [],
    'GET /api/holdings': () => [],
    'POST /api/connections/c-bank-1/scrape': postSpy,
    'GET /api/scrape/r-1': () => ({ run: {
      runId: 'r-1', connectionId: 'c-bank-1', status: 'success',
      message: 'Imported 1 account(s) and 42 transaction(s).',
      accountsCount: 1, transactionsCount: 42,
      startedAt: '2026-05-27T10:00:00Z', finishedAt: '2026-05-27T10:00:30Z',
    } }),
  });
  render(<AccountsView />);
  await userEvent.click(await screen.findByRole('button', { name: /sync/i }));
  await waitFor(() => expect(postSpy).toHaveBeenCalled());
  const callPayload = postSpy.mock.calls[0][0]; // verify shape per existing helper
  expect(callPayload).toEqual({ interactive: true });
  expect(callPayload).not.toHaveProperty('monthsBack');
});

it('renders ✓ Done — N transactions for ~5s after successful sync, then clears', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installFetchMock({
    'GET /api/companies': () => [{ id: 'hapoalim', name: 'Hapoalim', loginFields: ['username', 'password'], type: 'bank', interactive: true }],
    'GET /api/connections': () => connectionsFixture,
    'GET /api/accounts': () => [],
    'GET /api/assets': () => [],
    'GET /api/loans': () => [],
    'GET /api/holdings': () => [],
    'POST /api/connections/c-bank-1/scrape': () => ({ runId: 'r-1' }),
    'GET /api/scrape/r-1': () => ({ run: {
      runId: 'r-1', connectionId: 'c-bank-1', status: 'success',
      message: 'Imported 1 account(s) and 42 transaction(s).',
      accountsCount: 1, transactionsCount: 42,
      startedAt: '2026-05-27T10:00:00Z', finishedAt: '2026-05-27T10:00:30Z',
    } }),
  });
  render(<AccountsView />);
  await userEvent.click(await screen.findByRole('button', { name: /sync/i }));
  expect(await screen.findByText(/Done.*42 transactions/i)).toBeInTheDocument();

  await act(async () => { vi.advanceTimersByTime(5100); });
  expect(screen.queryByText(/Done.*42 transactions/i)).not.toBeInTheDocument();
  vi.useRealTimers();
});

it('clears the 5s timer on unmount without warning', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installFetchMock({
    'GET /api/companies': () => [{ id: 'hapoalim', name: 'Hapoalim', loginFields: ['username', 'password'], type: 'bank', interactive: true }],
    'GET /api/connections': () => connectionsFixture,
    'GET /api/accounts': () => [],
    'GET /api/assets': () => [],
    'GET /api/loans': () => [],
    'GET /api/holdings': () => [],
    'POST /api/connections/c-bank-1/scrape': () => ({ runId: 'r-1' }),
    'GET /api/scrape/r-1': () => ({ run: {
      runId: 'r-1', connectionId: 'c-bank-1', status: 'success',
      message: 'Imported 1 account(s) and 42 transaction(s).',
      accountsCount: 1, transactionsCount: 42,
      startedAt: '2026-05-27T10:00:00Z', finishedAt: '2026-05-27T10:00:30Z',
    } }),
  });
  const { unmount } = render(<AccountsView />);
  await userEvent.click(await screen.findByRole('button', { name: /sync/i }));
  await screen.findByText(/Done.*42 transactions/i);
  unmount();
  await act(async () => { vi.advanceTimersByTime(10000); });
  vi.useRealTimers();
});
```

Note: the exact payload-extraction pattern (`callPayload`) depends on how `installFetchMock` records calls in this repo. Mirror existing tests around line 450 — they extract the POST body via `post.mock.calls[0][?]`. Use the same pattern.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && npm test -- --run AccountsView.test.tsx
```

Expected: FAIL (payload still has `monthsBack`, no Done text rendered).

- [ ] **Step 3: Extend the `SyncState` discriminator**

In `web/src/accounts/AccountsView.tsx` lines 51–56, change to:

```ts
type SyncState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; runId: string; message: string }
  | { kind: 'needs-otp'; runId: string; message: string }
  | { kind: 'success'; accountsCount: number; transactionsCount: number }
  | { kind: 'error'; message: string };
```

- [ ] **Step 4: Drop the hard-coded `monthsBack` in `startSync`**

In `AccountsView.tsx` around lines 263–267, change:

```ts
const { runId } = await api<{ runId: string }>(
  `/connections/${encodeURIComponent(connection.id)}/scrape`,
  'POST',
  { interactive: true, monthsBack: 24 },
);
```

To:

```ts
const { runId } = await api<{ runId: string }>(
  `/connections/${encodeURIComponent(connection.id)}/scrape`,
  'POST',
  { interactive: true },
);
```

Delete the now-stale 3-line comment above the call ("monthsBack=24 matches the legacy default…"). Replace with one line:

```ts
// Engine picks the per-connection historyMonths default.
```

- [ ] **Step 5: Wire the `success` state into `pollRun` + auto-clear timer**

In `AccountsView.tsx` around lines 238–240, change:

```ts
} else if (run.status === 'success') {
  setSyncForConnection(connectionId, { kind: 'idle' });
  await refresh();
}
```

To:

```ts
} else if (run.status === 'success') {
  setSyncForConnection(connectionId, {
    kind: 'success',
    accountsCount: run.accountsCount,
    transactionsCount: run.transactionsCount,
  });
  await refresh();
  // Auto-clear after 5s. Stash the timer in pollTimers so the
  // existing unmount-cleanup catches it.
  pollTimers.current[connectionId] = setTimeout(() => {
    setSyncForConnection(connectionId, { kind: 'idle' });
  }, 5000);
}
```

- [ ] **Step 6: Render the Done pill on the connection card**

In `AccountsView.tsx` around lines 666–671, after the existing `{syncState.kind === 'error' && ...}` block, add:

```tsx
{syncState.kind === 'success' && (
  <div className="conn-sync-done" role="status">
    ✓ Done — {syncState.transactionsCount} transaction
    {syncState.transactionsCount === 1 ? '' : 's'}
  </div>
)}
```

- [ ] **Step 7: Add a minimal CSS rule for `.conn-sync-done`**

Find the existing `.conn-sync-msg` / `.conn-sync-err` rules (search in `web/src/` — likely `web/src/index.css` or a component-scoped file). Add a sibling rule:

```css
.conn-sync-done {
  font-size: 0.85rem;
  color: var(--ok, #2a8a3a);
  margin-top: 4px;
  /* Match the existing motion-respecting fade if .conn-sync-msg uses one. */
}

@media (prefers-reduced-motion: reduce) {
  .conn-sync-done {
    transition: none;
  }
}
```

If `--ok` doesn't exist in the token palette, use `#2a8a3a` directly (matches the existing palette green for "Last payment" badge in Loans).

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd web && npm test -- --run AccountsView.test.tsx
cd web && npm run typecheck
```

Both expected: PASS / clean.

- [ ] **Step 9: Commit**

```bash
git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx web/src/**/*.css
git commit -m "web: drop hard-coded monthsBack; show ✓ Done — N transactions for 5s"
```

---

## Task 10: React — inline history-months `<select>` on connection card

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` (the connection-card render around lines 629–663, the callbacks shape around line 524, and the `AccountsView` body where callbacks are constructed)
- Test: `web/src/accounts/AccountsView.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
const baseFixtureMocks = (historyMonths: number, patchSpy?: ReturnType<typeof vi.fn>) => ({
  'GET /api/companies': () => [{ id: 'hapoalim', name: 'Hapoalim', loginFields: ['username', 'password'], type: 'bank' as const, interactive: true }],
  'GET /api/connections': () => [{
    id: 'c-bank-1', companyId: 'hapoalim', displayName: 'Hapoalim',
    createdAt: '2026-01-01T00:00:00Z', lastScrapeAt: null, lastStatus: null,
    hasCredentials: true, historyMonths,
  }],
  'GET /api/accounts': () => [],
  'GET /api/assets': () => [],
  'GET /api/loans': () => [],
  'GET /api/holdings': () => [],
  ...(patchSpy ? { 'PATCH /api/connections/c-bank-1/history-months': patchSpy } : {}),
});

it('connection card renders history-months select with current value', async () => {
  installFetchMock(baseFixtureMocks(18));
  render(<AccountsView />);
  const select = await screen.findByLabelText(/history months/i) as HTMLSelectElement;
  expect(select.value).toBe('18');
});

it('changing the select PATCHes /connections/:id/history-months', async () => {
  const patchSpy = vi.fn().mockResolvedValue({
    connection: {
      id: 'c-bank-1', companyId: 'hapoalim', displayName: 'Hapoalim',
      createdAt: '2026-01-01T00:00:00Z', lastScrapeAt: null, lastStatus: null,
      hasCredentials: true, historyMonths: 6,
    },
  });
  installFetchMock(baseFixtureMocks(12, patchSpy));
  render(<AccountsView />);
  const select = await screen.findByLabelText(/history months/i);
  await userEvent.selectOptions(select, '6');
  await waitFor(() => expect(patchSpy).toHaveBeenCalled());
  const payload = patchSpy.mock.calls[0][0];
  expect(payload).toEqual({ historyMonths: 6 });
});

it('reverts the select when PATCH fails', async () => {
  const patchSpy = vi.fn().mockRejectedValue(
    new ApiError(400, 'historyMonths must be an integer in [1, 24]'),
  );
  installFetchMock(baseFixtureMocks(12, patchSpy));
  render(<AccountsView />);
  const select = await screen.findByLabelText(/history months/i) as HTMLSelectElement;
  await userEvent.selectOptions(select, '6');
  // Optimistic update flashes to 6, then reverts on error.
  await waitFor(() => expect(select.value).toBe('12'));
});
```

The `baseFixtureMocks` helper is local to this `describe` block — define it once near the top of the new section, then reuse across the three tests. `ApiError` is imported from `web/src/api.ts` (mirror the existing test file's imports at the top).

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && npm test -- --run AccountsView.test.tsx
```

Expected: FAIL (no select rendered, no handler wired).

- [ ] **Step 3: Add an `onSetHistoryMonths` callback to `AccountsView`**

In the `AccountsView` body, mirror the existing `toggleAccountExcluded` pattern (around lines 278–286):

```ts
const setHistoryMonths = useCallback(async (connection: Connection, months: number) => {
  // Optimistic update.
  const previous = connection.historyMonths;
  setData((d) => d && ({
    ...d,
    connections: d.connections.map((c) =>
      c.id === connection.id ? { ...c, historyMonths: months } : c,
    ),
  }));
  try {
    await api(
      `/connections/${encodeURIComponent(connection.id)}/history-months`,
      'PATCH',
      { historyMonths: months },
    );
  } catch {
    // Revert on failure.
    setData((d) => d && ({
      ...d,
      connections: d.connections.map((c) =>
        c.id === connection.id ? { ...c, historyMonths: previous } : c,
      ),
    }));
  }
}, []);
```

- [ ] **Step 4: Add the callback to the props shape and forward it**

In the `interface` around line 524 (where `onSync`, `syncStates` etc. live), add:

```ts
onSetHistoryMonths: (connection: Connection, months: number) => void;
```

Pass `onSetHistoryMonths: setHistoryMonths` wherever the callbacks object is built (search for `onSync: startSync` — line ~354 — to find that site).

- [ ] **Step 5: Render the select in the connection card**

In the conn-buttons area (around lines 629–663), between the "Sync" button and the "Remove" button (only show when `connection.hasCredentials` is true, matching the Sync button's gate):

```tsx
{connection.hasCredentials && (
  <label className="conn-history-label">
    <span className="conn-history-text">History</span>
    <select
      className="conn-history-select mini"
      aria-label="History months"
      value={connection.historyMonths}
      onChange={(e) => callbacks.onSetHistoryMonths(connection, Number(e.target.value))}
    >
      <option value={3}>3 mo</option>
      <option value={6}>6 mo</option>
      <option value={12}>12 mo</option>
      <option value={18}>18 mo</option>
      <option value={24}>24 mo</option>
    </select>
  </label>
)}
```

- [ ] **Step 6: Add minimal CSS**

In the same stylesheet that holds `.conn-sync-msg`, add:

```css
.conn-history-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
}
.conn-history-select.mini {
  padding: 2px 4px;
  font: inherit;
}
```

- [ ] **Step 7: Run tests + typecheck**

```bash
cd web && npm test -- --run AccountsView.test.tsx
cd web && npm run typecheck
```

Both expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx web/src/**/*.css
git commit -m "web: per-connection history-months select on conn-card"
```

---

## Task 11: Visual verification via chrome-devtools MCP

**Files:**
- (No source changes — verification only, per PROJECT-RULES.md §2)

- [ ] **Step 1: Ensure chrome-devtools MCP is connected**

```bash
curl -s http://127.0.0.1:9222/json/version | head -1
```

If empty/connection-refused, launch headed Chrome with CDP per PROJECT-RULES.md §2:

```bash
mkdir -p /tmp/chrome-cdp-profile
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-cdp-profile \
  --no-first-run --no-default-browser-check \
  >/tmp/chrome-cdp.log 2>&1 &
sleep 2
```

- [ ] **Step 2: Confirm the dev server is running and load the app**

The user runs vite themselves (PROJECT-RULES.md §1 — NEVER call `preview_start`). If `curl -sI http://localhost:5173 | head -1` returns 200, proceed. Otherwise ask the user to run `cd Hon && npm run dev`.

Read the dev token:

```bash
TOKEN=$(cat "$HOME/Library/Application Support/Hon/dev-token")
echo "Token loaded, length=${#TOKEN}"
```

Navigate via `mcp__chrome-devtools__new_page` to `http://localhost:5173/#token=<TOKEN>`.

- [ ] **Step 3: Snapshot the Accounts tab**

`mcp__chrome-devtools__navigate_page { type: "reload", ignoreCache: true }` then `mcp__chrome-devtools__take_snapshot`. Confirm a connection card exists.

- [ ] **Step 4: Verify the history-months select is rendered + default 12**

Find the History select in the snapshot. `mcp__chrome-devtools__take_screenshot { filePath: "/tmp/sync-step-1-history-select.png" }`. Read the screenshot.

- [ ] **Step 5: Change the select to 18 and verify the PATCH**

`mcp__chrome-devtools__list_network_requests` (after the click) — find `PATCH /connections/.../history-months` and `mcp__chrome-devtools__get_network_request` to confirm the body shape `{ historyMonths: 18 }` and a 200 response.

- [ ] **Step 6: Trigger a sync and screenshot the Done pill**

Click the Sync button via `mcp__chrome-devtools__click`. Wait via `mcp__chrome-devtools__wait_for` until the snapshot contains `Done`. Screenshot:

```
mcp__chrome-devtools__take_screenshot { filePath: "/tmp/sync-step-2-done-pill.png" }
```

Read the screenshot — confirm it shows `✓ Done — N transactions`.

- [ ] **Step 7: Confirm the DB has ≥ 12 months of transactions**

```bash
DB="$HOME/Library/Application Support/Hon/hon.db"
sqlite3 "$DB" "SELECT MIN(date), MAX(date), COUNT(*) FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = '<id of the synced connection>')"
```

Expected: `MIN(date)` is ≥ 365 days before today (or as far back as the bank allows — document the actual span if the institution caps it).

- [ ] **Step 8: No commit (verification only)**

This task produces evidence files in `/tmp/`. Reference them in the session summary.

---

## Task 12: Update HANDOFF.md

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Refresh the TL;DR + "What shipped this session"**

Update the `## TL;DR — state of the world` date to today, and the most-recent-commit line to the head of this branch.

Replace `## What shipped this session (2026-05-27)` with a new section dated today summarizing:

1. Per-connection `history_months` column (migration 36, default 12).
2. `runner.chooseStartDate` gutted — no more `lastSuccess − 14d` shortcut; `CARD_COMPANIES` removed.
3. `persist.skipped` log line so DB-level dedup is visible.
4. New `PATCH /connections/:id/history-months` route.
5. React: dropped hard-coded `monthsBack: 24`, added `✓ Done — N transactions` pill (5s auto-clear), inline history-months `<select>` on each conn-card.
6. Tests: sidecar baseline + N, web baseline + N (fill in actual counts after running).

Add a bullet under "Highest-value next steps" if any follow-up surfaced (e.g. some bank scraper internally caps below 12 months — note which one).

- [ ] **Step 2: Verify the file still reads cleanly**

`mcp__plugin_context-mode_context-mode__ctx_execute_file { path: "HANDOFF.md", language: "shell", code: "head -50 HANDOFF.md" }` — confirm formatting intact.

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: HANDOFF — per-connection history window + sync completion pill"
```

---

## Task 13: Merge back to main (post-user-approval)

**Files:**
- (No source changes)

- [ ] **Step 1: Confirm green baseline**

```bash
cd web && npm test -- --run
cd ../sidecar && npm test -- --run
cd ../web && npm run typecheck
cd ../sidecar && npm run typecheck
```

All four must pass before merge.

- [ ] **Step 2: Show the user the diff**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon
git log --oneline main..session/sync-window-12mo-2026-05-27
git diff main...session/sync-window-12mo-2026-05-27 --stat
```

Present to the user. Wait for explicit "merge" / "PR" / "hold".

- [ ] **Step 3: Per user instruction — merge or PR**

If "merge":

```bash
git merge --no-ff session/sync-window-12mo-2026-05-27
```

If "PR":

```bash
gh pr create --base main --head session/sync-window-12mo-2026-05-27 \
  --title "Per-connection history window + sync completion pill" \
  --body "$(cat <<'EOF'
## Summary
- Migration 36 — connections.history_months default 12
- runner.chooseStartDate always uses full monthsBack (no lastSuccess shortcut)
- PATCH /connections/:id/history-months
- React: ✓ Done — N transactions pill, inline history-months select

## Test plan
- [ ] sidecar tests pass
- [ ] web tests pass
- [ ] Visual verification screenshots in /tmp/sync-step-*.png

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: NEVER push without explicit user "push"**

Per PROJECT-RULES.md §3 — wait for the user to say "push" before `git push origin main` or `git push origin <branch>`.

- [ ] **Step 5: After merge confirmed — clean up worktree**

```bash
git worktree remove .claude/worktrees/sync-window-12mo-2026-05-27
git branch -d session/sync-window-12mo-2026-05-27   # only if user confirms delete
```

---

## Final sanity checks

After Task 12 (before Task 13):

```bash
# All four must succeed.
cd web && npm test -- --run                # expect 315 + N (N ≈ 6) passing
cd ../sidecar && npm test -- --run         # expect 55 + N (N ≈ 8) passing
cd ../web && npm run typecheck             # clean
cd ../sidecar && npm run typecheck         # clean
```

Visual evidence saved to `/tmp/sync-step-*.png`. Reference these in the session summary.
