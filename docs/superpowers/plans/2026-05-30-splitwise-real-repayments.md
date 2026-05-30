# Splitwise Real Repayments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive Splitwise paid-state from real incoming transactions the user marks as repayments, not from Splitwise's settle-up flag; compute owed-to-you from Hon's own links.

**Architecture:** Keep the existing oldest-first allocation, but swap the "paid" pool source from Splitwise `get_expenses` payment records to a new `splitwise_repayments` table (incoming txns the user marks). Extract a pure `allocatePayments()`; `recomputePaidStates(repo)` persists per-link `paid_amount`/`paid_state` plus a per-counterparty `paid`. `OwedToYouCard` + the Overview projection compute from links via a pure `owedByFriend()`. The `txn_effective`/`splitwise_virtual` SQL is unchanged.

**Tech Stack:** TS strict; better-sqlite3 (sidecar) + Fastify routes; React 19 + Vitest + Testing-Library (web).

**Spec:** `docs/superpowers/specs/2026-05-30-splitwise-real-repayments-design.md`

---

## File Structure

**sidecar:**
- `sidecar/src/db.ts` — migration 37 (`splitwise_repayments`), `SCHEMA_VERSION = 37`.
- `sidecar/src/repo.ts` — `SplitwiseRepayment` type; `paid?` on `SplitwiseCounterparty`; repayment CRUD + `getRepaymentPool()`; `updateSplitwiseLinkPaid()` gains a `counterparties` arg.
- `sidecar/src/splitwise.ts` — pure `allocatePayments()`; `recomputePaidStates(repo)`; `refreshSplitwise()` drops the `get_expenses` fetch + `attributePayments`.
- `sidecar/src/server.ts` — `POST`/`DELETE /splitwise/repayment`; `/splitwise/links` returns `{ links, repayments }`.

**web:**
- `web/src/splitwise/types.ts` — `paid?` on counterparty; `SplitwiseRepayment`.
- `web/src/splitwise/owed.ts` (new) — pure `owedByFriend(links)`.
- `web/src/splitwise/useSplitwise.ts` — `repayments`, `repaymentByTxnId`, `markRepayment`, `unmarkRepayment`.
- `web/src/overview/OwedToYouCard.tsx` + `web/src/overview/OverviewView.tsx` — owed from links.
- `web/src/activity/SplitwiseRepaymentSection.tsx` (new) + `web/src/activity/ActivityView.tsx` — the mark-repayment UI.

**Test commands:** sidecar — `cd sidecar && npm test`; web — `cd web && npm test`; typechecks — `cd sidecar && npm run typecheck`, `cd web && npm run typecheck`. Sidecar tests live in `sidecar/tests/*.test.ts` (harness `makeRepo()`); web tests are co-located `*.test.ts(x)` using `installFetchMock` from `web/src/test/mockFetch`.

**Convention (PROJECT-RULES §5):** `server.ts` route handlers are NOT unit-tested — the logic lives in repo + pure functions (which ARE tested); routes are covered by the live chrome-devtools verification at the end.

---

## Task 1: Migration 37 — `splitwise_repayments` table

**Files:**
- Modify: `sidecar/src/db.ts` (`SCHEMA_VERSION` line 5; add a migration object to the `MIGRATIONS` array)
- Test: `sidecar/tests/splitwiseRepayments.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/splitwiseRepayments.test.ts`:

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/db.js';
import { Repo } from '../src/repo.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-repo-'));
  const { db } = openDatabase(dir);
  return { repo: new Repo(db), db };
}

describe('migration 37 — splitwise_repayments', () => {
  it('bumps SCHEMA_VERSION to 37', () => {
    expect(SCHEMA_VERSION).toBe(37);
  });

  it('creates the splitwise_repayments table', () => {
    const { db } = makeRepo();
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='splitwise_repayments'",
      )
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('splitwise_repayments');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npx vitest run tests/splitwiseRepayments.test.ts`
Expected: FAIL — `SCHEMA_VERSION` is 36; the table query returns undefined.

- [ ] **Step 3: Implement the migration**

In `sidecar/src/db.ts`, change line 5:

```typescript
export const SCHEMA_VERSION = 37;
```

Append a new object to the END of the `MIGRATIONS` array (after the v36 `history_months` entry):

```typescript
  {
    // Splitwise repayments — incoming transactions the user marks as a
    // friend paying them back. Replaces trusting Splitwise's settle-up flag:
    // paid_amount/paid_state are recomputed from these rows, not from
    // Splitwise payment records. `amount` is captured from the txn at mark
    // time (incoming bank credits don't change). ON DELETE CASCADE mirrors
    // splitwise_links so removing a txn cleans up.
    version: 37,
    sql: `CREATE TABLE splitwise_repayments (
      transaction_id    TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
      counterparty_id   TEXT NOT NULL,
      counterparty_name TEXT NOT NULL,
      currency          TEXT NOT NULL,
      amount            REAL NOT NULL,
      created_at        TEXT NOT NULL
    );`,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npx vitest run tests/splitwiseRepayments.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/db.ts sidecar/tests/splitwiseRepayments.test.ts
git commit -m "feat(splitwise): migration 37 — splitwise_repayments table"
```

---

## Task 2: Repo — repayment CRUD, pool, per-counterparty paid

**Files:**
- Modify: `sidecar/src/repo.ts` (`SplitwiseCounterparty` ~251; `updateSplitwiseLinkPaid` ~685; add repayment section after the splitwise-links block ~696)
- Test: `sidecar/tests/splitwiseRepayments.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `sidecar/tests/splitwiseRepayments.test.ts`:

```typescript
describe('Repo — splitwise repayments', () => {
  const cp = (id: number, name: string, owed: number) => ({ id, name, owed });

  it('creates, lists, and deletes a repayment', () => {
    const { repo } = makeRepo();
    repo.createRepayment({
      transactionId: 'r1', counterpartyId: 2, counterpartyName: 'Roomie',
      currency: 'ILS', amount: 60,
    });
    expect(repo.listRepayments()).toEqual([
      expect.objectContaining({
        transactionId: 'r1', counterpartyId: 2, counterpartyName: 'Roomie',
        currency: 'ILS', amount: 60,
      }),
    ]);
    repo.deleteRepayment('r1');
    expect(repo.listRepayments()).toHaveLength(0);
  });

  it('getRepaymentPool sums amounts per counterparty+currency', () => {
    const { repo } = makeRepo();
    repo.createRepayment({ transactionId: 'r1', counterpartyId: 2, counterpartyName: 'A', currency: 'ILS', amount: 40 });
    repo.createRepayment({ transactionId: 'r2', counterpartyId: 2, counterpartyName: 'A', currency: 'ILS', amount: 25 });
    repo.createRepayment({ transactionId: 'r3', counterpartyId: 3, counterpartyName: 'B', currency: 'USD', amount: 10 });
    const pool = repo.getRepaymentPool();
    expect(pool.get('2|ILS')).toBe(65);
    expect(pool.get('3|USD')).toBe(10);
  });

  it('updateSplitwiseLinkPaid persists paid_amount, state, and counterparties JSON', () => {
    const { repo } = makeRepo();
    repo.createSplitwiseLink({
      transactionId: 'e1', expenseId: 'x1', groupId: null, currency: 'ILS',
      owedToMe: 60, counterparties: [cp(2, 'Roomie', 60)],
    });
    repo.updateSplitwiseLinkPaid('e1', 60, 'paid', [{ ...cp(2, 'Roomie', 60), paid: 60 }]);
    const link = repo.getSplitwiseLink('e1')!;
    expect(link.paidAmount).toBe(60);
    expect(link.paidState).toBe('paid');
    expect(link.counterparties[0].paid).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npx vitest run tests/splitwiseRepayments.test.ts`
Expected: FAIL — `repo.createRepayment` / `listRepayments` / `getRepaymentPool` undefined; `updateSplitwiseLinkPaid` takes 3 args.

- [ ] **Step 3: Implement repo changes**

(a) In `sidecar/src/repo.ts`, extend `SplitwiseCounterparty` (lines 251-255):

```typescript
export interface SplitwiseCounterparty {
  id: number;
  name: string;
  owed: number;
  /** Amount of `owed` covered by linked repayments (set by recomputePaidStates). */
  paid?: number;
}
```

(b) Add a `SplitwiseRepayment` interface right after the `SplitwiseLink` interface (after line 270):

```typescript
/** An incoming transaction the user marked as a friend repaying them. */
export interface SplitwiseRepayment {
  transactionId: string;
  counterpartyId: number;
  counterpartyName: string;
  currency: string;
  amount: number;
  createdAt: string;
}
```

(c) Replace `updateSplitwiseLinkPaid` (lines 684-692) to also persist counterparties:

```typescript
  /** Updates a link's paid figures + per-counterparty paid after a recompute. */
  updateSplitwiseLinkPaid(
    transactionId: string,
    paidAmount: number,
    paidState: string,
    counterparties: SplitwiseCounterparty[],
  ): void {
    this.db
      .prepare(
        `UPDATE splitwise_links
            SET paid_amount = ?, paid_state = ?, counterparties = ?, synced_at = ?
          WHERE transaction_id = ?`,
      )
      .run(
        paidAmount,
        paidState,
        JSON.stringify(counterparties),
        new Date().toISOString(),
        transactionId,
      );
  }
```

(d) Add the repayment methods immediately after `deleteSplitwiseLink` (after line 696):

```typescript
  // --- Splitwise repayments -------------------------------------------------
  // Incoming transactions the user marked as a friend paying them back. These
  // drive paid-state (via recomputePaidStates), replacing Splitwise's settle-up
  // flag. `amount` is captured at mark time from the incoming txn.

  private static readonly SWR_COLS =
    'transaction_id AS transactionId, counterparty_id AS counterpartyId, ' +
    'counterparty_name AS counterpartyName, currency, amount, created_at AS createdAt';

  private static toRepayment(row: {
    transactionId: string; counterpartyId: string; counterpartyName: string;
    currency: string; amount: number; createdAt: string;
  }): SplitwiseRepayment {
    return { ...row, counterpartyId: Number(row.counterpartyId) };
  }

  listRepayments(): SplitwiseRepayment[] {
    const rows = this.db
      .prepare(`SELECT ${Repo.SWR_COLS} FROM splitwise_repayments ORDER BY created_at`)
      .all() as Parameters<typeof Repo.toRepayment>[0][];
    return rows.map(Repo.toRepayment);
  }

  getRepayment(transactionId: string): SplitwiseRepayment | undefined {
    const row = this.db
      .prepare(`SELECT ${Repo.SWR_COLS} FROM splitwise_repayments WHERE transaction_id = ?`)
      .get(transactionId) as Parameters<typeof Repo.toRepayment>[0] | undefined;
    return row ? Repo.toRepayment(row) : undefined;
  }

  createRepayment(r: {
    transactionId: string;
    counterpartyId: number;
    counterpartyName: string;
    currency: string;
    amount: number;
  }): SplitwiseRepayment {
    this.db
      .prepare(
        `INSERT INTO splitwise_repayments
           (transaction_id, counterparty_id, counterparty_name, currency, amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (transaction_id) DO UPDATE SET
           counterparty_id = excluded.counterparty_id,
           counterparty_name = excluded.counterparty_name,
           currency = excluded.currency, amount = excluded.amount`,
      )
      .run(
        r.transactionId,
        String(r.counterpartyId),
        r.counterpartyName,
        r.currency,
        r.amount,
        new Date().toISOString(),
      );
    return this.getRepayment(r.transactionId)!;
  }

  deleteRepayment(transactionId: string): void {
    this.db.prepare('DELETE FROM splitwise_repayments WHERE transaction_id = ?').run(transactionId);
  }

  /** Pool of money each person has repaid, keyed `counterpartyId|currency`. */
  getRepaymentPool(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT counterparty_id AS counterpartyId, currency, SUM(amount) AS amount
           FROM splitwise_repayments GROUP BY counterparty_id, currency`,
      )
      .all() as { counterpartyId: string; currency: string; amount: number }[];
    const pool = new Map<string, number>();
    for (const row of rows) pool.set(`${row.counterpartyId}|${row.currency}`, row.amount);
    return pool;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npx vitest run tests/splitwiseRepayments.test.ts`
Expected: PASS (all Task 1 + Task 2 tests). Note: `updateSplitwiseLinkPaid`'s old 3-arg caller in `splitwise.ts` now mis-types — that's fixed in Task 4; if `npm test` (full) is run now it may show a typecheck error in `splitwise.ts`. Running just this file passes.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/repo.ts sidecar/tests/splitwiseRepayments.test.ts
git commit -m "feat(splitwise): repo repayment CRUD, pool, per-counterparty paid"
```

---

## Task 3: Pure `allocatePayments()`

**Files:**
- Modify: `sidecar/src/splitwise.ts` (add exported pure function near the bottom)
- Test: `sidecar/tests/splitwiseAllocate.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/splitwiseAllocate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { allocatePayments } from '../src/splitwise.js';
import type { SplitwiseLink } from '../src/repo.js';

const link = (over: Partial<SplitwiseLink>): SplitwiseLink => ({
  transactionId: 'e', expenseId: 'x', groupId: null, currency: 'ILS',
  owedToMe: 60, counterparties: [{ id: 2, name: 'A', owed: 60 }],
  paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null, ...over,
});

describe('allocatePayments', () => {
  it('marks a link paid when the pool covers it', () => {
    const out = allocatePayments([link({})], new Map([['2|ILS', 60]]));
    expect(out[0]).toMatchObject({ paidAmount: 60, paidState: 'paid' });
    expect(out[0].counterparties[0].paid).toBe(60);
  });

  it('marks partial when the pool is short', () => {
    const out = allocatePayments([link({})], new Map([['2|ILS', 25]]));
    expect(out[0]).toMatchObject({ paidAmount: 25, paidState: 'partial' });
  });

  it('leaves a link open when the pool is empty', () => {
    const out = allocatePayments([link({})], new Map());
    expect(out[0]).toMatchObject({ paidAmount: 0, paidState: 'open' });
  });

  it('consumes a person pool oldest-first across links', () => {
    const out = allocatePayments(
      [link({ transactionId: 'new', createdAt: '2026-05-10' }),
       link({ transactionId: 'old', createdAt: '2026-05-01' })],
      new Map([['2|ILS', 60]]),
    );
    const byId = Object.fromEntries(out.map((r) => [r.transactionId, r]));
    expect(byId.old.paidState).toBe('paid');
    expect(byId.new.paidState).toBe('open');
  });

  it('ignores a pool in a different currency', () => {
    const out = allocatePayments([link({})], new Map([['2|USD', 60]]));
    expect(out[0].paidState).toBe('open');
  });

  it('does not over-allocate beyond what is owed', () => {
    const out = allocatePayments([link({})], new Map([['2|ILS', 200]]));
    expect(out[0].paidAmount).toBe(60);
  });

  it('splits a payment across multiple counterparties in one link', () => {
    const out = allocatePayments(
      [link({ owedToMe: 100, counterparties: [
        { id: 2, name: 'A', owed: 60 }, { id: 3, name: 'B', owed: 40 },
      ] })],
      new Map([['2|ILS', 60], ['3|ILS', 20]]),
    );
    expect(out[0].paidAmount).toBe(80);
    expect(out[0].paidState).toBe('partial');
    expect(out[0].counterparties.find((c) => c.id === 3)?.paid).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npx vitest run tests/splitwiseAllocate.test.ts`
Expected: FAIL — `allocatePayments` is not exported.

- [ ] **Step 3: Implement the pure allocator**

In `sidecar/src/splitwise.ts`, add near the top (after the imports, the `SplitwiseCounterparty` is already imported via `./repo.js`):

```typescript
export interface PaidResult {
  transactionId: string;
  paidAmount: number;
  paidState: 'open' | 'partial' | 'paid';
  counterparties: SplitwiseCounterparty[];
}

/**
 * Pure allocation: consume each person's repayment pool against their linked
 * expenses oldest-first, setting per-counterparty `paid`. `pool` is keyed
 * `counterpartyId|currency`. Splitwise tracks debt per person, not per expense,
 * so oldest-first is the honest approximation.
 */
export function allocatePayments(
  links: SplitwiseLink[],
  pool: Map<string, number>,
): PaidResult[] {
  const remaining = new Map(pool);
  const ordered = [...links].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const results: PaidResult[] = [];
  for (const link of ordered) {
    let paid = 0;
    const counterparties = link.counterparties.map((cp) => {
      const key = `${cp.id}|${link.currency}`;
      const available = remaining.get(key) ?? 0;
      const take = Math.min(cp.owed, available);
      if (take > 0) {
        remaining.set(key, available - take);
        paid += take;
      }
      return { ...cp, paid: Math.round(take * 100) / 100 };
    });
    paid = Math.round(paid * 100) / 100;
    const paidState: PaidResult['paidState'] =
      paid >= link.owedToMe - 0.01 ? 'paid' : paid > 0.01 ? 'partial' : 'open';
    results.push({ transactionId: link.transactionId, paidAmount: paid, paidState, counterparties });
  }
  return results;
}
```

Ensure `SplitwiseCounterparty` is imported — change the import at line 6:

```typescript
import type { Repo, SplitwiseCounterparty, SplitwiseLink } from './repo.js';
```

(It already imports `SplitwiseCounterparty` — confirm; if not, add it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && npx vitest run tests/splitwiseAllocate.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/splitwise.ts sidecar/tests/splitwiseAllocate.test.ts
git commit -m "feat(splitwise): pure allocatePayments (per-counterparty paid)"
```

---

## Task 4: `recomputePaidStates()` + drop the Splitwise payment fetch

**Files:**
- Modify: `sidecar/src/splitwise.ts` (replace `attributePayments` + rewrite `refreshSplitwise`; remove `SwExpense`/`SwRepayment`)
- Modify: `sidecar/src/server.ts` (update the `refreshSplitwise` call site — it loses `myId`)
- Test: `sidecar/tests/splitwiseRepayments.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/splitwiseRepayments.test.ts`:

```typescript
import { recomputePaidStates } from '../src/splitwise.js';

describe('recomputePaidStates', () => {
  it('marks a link paid from a linked repayment, not from Splitwise', () => {
    const { repo } = makeRepo();
    repo.createSplitwiseLink({
      transactionId: 'e1', expenseId: 'x1', groupId: null, currency: 'ILS',
      owedToMe: 60, counterparties: [{ id: 2, name: 'Roomie', owed: 60 }],
    });
    // No repayment yet → stays open.
    recomputePaidStates(repo);
    expect(repo.getSplitwiseLink('e1')!.paidState).toBe('open');

    // Link the real repayment → paid.
    repo.createRepayment({ transactionId: 'r1', counterpartyId: 2, counterpartyName: 'Roomie', currency: 'ILS', amount: 60 });
    recomputePaidStates(repo);
    const link = repo.getSplitwiseLink('e1')!;
    expect(link.paidState).toBe('paid');
    expect(link.paidAmount).toBe(60);
    expect(link.counterparties[0].paid).toBe(60);

    // Unlink → reverts to open.
    repo.deleteRepayment('r1');
    recomputePaidStates(repo);
    expect(repo.getSplitwiseLink('e1')!.paidState).toBe('open');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && npx vitest run tests/splitwiseRepayments.test.ts`
Expected: FAIL — `recomputePaidStates` not exported.

- [ ] **Step 3: Implement recompute + rewrite refresh**

In `sidecar/src/splitwise.ts`:

(a) Delete the `SwRepayment` (lines 30-34) and `SwExpense` (lines 35-42) interfaces — they were only used by `attributePayments`.

(b) Replace the entire `refreshSplitwise` function (lines 272-295) and the `attributePayments` function (lines 297-343) with:

```typescript
/**
 * Refreshes per-friend balances (for the picker) and recomputes paid-state from
 * the user's linked repayment transactions. Splitwise's own settle-up flag is no
 * longer trusted — only real repayments the user marked move a split toward paid.
 */
export async function refreshSplitwise(
  apiKey: string,
  repo: Repo,
): Promise<SplitwiseRefresh> {
  const friendsData = await swRequest<{ friends?: SwFriend[] }>(apiKey, '/get_friends');
  const friends: SplitwiseFriendBalance[] = (friendsData.friends ?? []).map((f) => ({
    id: f.id,
    name: personName(f),
    balances: (f.balance ?? [])
      .map((b) => ({ currency: b.currency_code, amount: Number(b.amount) || 0 }))
      .filter((b) => b.amount !== 0),
  }));
  recomputePaidStates(repo);
  return { friends, links: repo.listSplitwiseLinks() };
}

/** Recomputes every link's paid-state from the local repayment pool. */
export function recomputePaidStates(repo: Repo): void {
  const links = repo.listSplitwiseLinks();
  if (links.length === 0) return;
  const pool = repo.getRepaymentPool();
  for (const r of allocatePayments(links, pool)) {
    repo.updateSplitwiseLinkPaid(r.transactionId, r.paidAmount, r.paidState, r.counterparties);
  }
}
```

(c) In `sidecar/src/server.ts`, update the `/splitwise/refresh` handler's call (line ~922) from:

```typescript
    return await refreshSplitwise(acct.apiKey, acct.userId, repo);
```

to:

```typescript
    return await refreshSplitwise(acct.apiKey, repo);
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `cd sidecar && npx vitest run tests/splitwiseRepayments.test.ts`
Expected: PASS.
Run: `cd sidecar && npm run typecheck`
Expected: clean (no unused `SwExpense`/`SwRepayment`, no 3-arg `updateSplitwiseLinkPaid`, refresh call updated).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/splitwise.ts sidecar/src/server.ts sidecar/tests/splitwiseRepayments.test.ts
git commit -m "feat(splitwise): recomputePaidStates from repayments; drop get_expenses settle-up source"
```

---

## Task 5: Routes — mark/unmark repayment + links payload

**Files:**
- Modify: `sidecar/src/server.ts` (import `recomputePaidStates`; `/splitwise/links` ~910; add two routes after the splitwise-expense routes ~1013)

> Per PROJECT-RULES §5, `server.ts` routes are verified live (Task 9), not unit-tested. This task has no automated test step; verification is the typecheck + the final live check.

- [ ] **Step 1: Add `recomputePaidStates` to the splitwise import**

In `sidecar/src/server.ts`, find the import from `./splitwise.js` and add `recomputePaidStates`:

```typescript
import {
  verifyKey, fetchPickList, planSplit, createExpense, deleteExpense,
  refreshSplitwise, recomputePaidStates,
} from './splitwise.js';
```

(Match the existing import members; add `recomputePaidStates` to the list — keep whatever names are already imported.)

- [ ] **Step 2: Make `/splitwise/links` return repayments too**

Replace the `/splitwise/links` handler (lines 910-913):

```typescript
  app.get('/splitwise/links', async (_req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    return { links: repo.listSplitwiseLinks(), repayments: repo.listRepayments() };
  });
```

- [ ] **Step 3: Add the repayment routes**

Insert after the `DELETE /splitwise/expense/:transactionId` handler (after line 1013):

```typescript
  app.post('/splitwise/repayment', async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const body = (req.body ?? {}) as {
      transactionId?: string; counterpartyId?: number; counterpartyName?: string;
    };
    const txn = body.transactionId ? repo.getTransaction(body.transactionId) : undefined;
    if (!txn) return reply.code(404).send({ error: 'transaction not found' });
    if (!(txn.amount > 0)) {
      return reply.code(400).send({ error: 'only an incoming transaction can be a repayment' });
    }
    if (typeof body.counterpartyId !== 'number') {
      return reply.code(400).send({ error: 'a counterparty is required' });
    }
    repo.createRepayment({
      transactionId: txn.id,
      counterpartyId: body.counterpartyId,
      counterpartyName: (body.counterpartyName ?? '').trim() || `User ${body.counterpartyId}`,
      currency: txn.currency,
      amount: txn.amount,
    });
    recomputePaidStates(repo);
    return { links: repo.listSplitwiseLinks(), repayments: repo.listRepayments() };
  });

  app.delete('/splitwise/repayment/:transactionId', async (req, reply) => {
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const { transactionId } = req.params as { transactionId: string };
    if (!repo.getRepayment(transactionId)) {
      return reply.code(404).send({ error: 'repayment not found' });
    }
    repo.deleteRepayment(transactionId);
    recomputePaidStates(repo);
    return { links: repo.listSplitwiseLinks(), repayments: repo.listRepayments() };
  });
```

- [ ] **Step 4: Typecheck + full sidecar suite**

Run: `cd sidecar && npm run typecheck`
Expected: clean.
Run: `cd sidecar && npm test`
Expected: PASS (all sidecar tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/server.ts
git commit -m "feat(splitwise): POST/DELETE /splitwise/repayment + repayments in /links"
```

---

## Task 6: Web — types, owedByFriend, useSplitwise repayments

**Files:**
- Modify: `web/src/splitwise/types.ts`
- Create: `web/src/splitwise/owed.ts` + `web/src/splitwise/owed.test.ts`
- Modify: `web/src/splitwise/useSplitwise.ts`
- Test: `web/src/splitwise/useSplitwise.test.ts` (extend)

- [ ] **Step 1: Write the failing owed.ts test**

Create `web/src/splitwise/owed.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { owedByFriend } from './owed';
import type { SplitwiseLink } from './types';

const link = (over: Partial<SplitwiseLink>): SplitwiseLink => ({
  transactionId: 'e', expenseId: 'x', groupId: null, currency: 'ILS',
  owedToMe: 60, counterparties: [{ id: 2, name: 'Roomie', owed: 60 }],
  paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null, ...over,
});

describe('owedByFriend', () => {
  it('sums remaining (owed - paid) per friend across links', () => {
    const out = owedByFriend([
      link({ transactionId: 'a', counterparties: [{ id: 2, name: 'Roomie', owed: 60, paid: 0 }] }),
      link({ transactionId: 'b', counterparties: [{ id: 2, name: 'Roomie', owed: 40, paid: 10 }] }),
    ]);
    expect(out).toEqual([{ id: 2, name: 'Roomie', currency: 'ILS', owed: 90 }]);
  });

  it('drops a friend who is fully paid', () => {
    const out = owedByFriend([
      link({ counterparties: [{ id: 2, name: 'Roomie', owed: 60, paid: 60 }] }),
    ]);
    expect(out).toEqual([]);
  });

  it('keeps currencies separate', () => {
    const out = owedByFriend([
      link({ transactionId: 'a', currency: 'ILS' }),
      link({ transactionId: 'b', currency: 'USD', counterparties: [{ id: 2, name: 'Roomie', owed: 10 }] }),
    ]);
    expect(out).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/splitwise/owed.test.ts`
Expected: FAIL — `./owed` does not exist.

- [ ] **Step 3: Implement types + owed.ts**

(a) In `web/src/splitwise/types.ts`, add `paid` to `SplitwiseCounterparty`:

```typescript
export interface SplitwiseCounterparty {
  id: number;
  name: string;
  owed: number;
  /** Amount of `owed` covered by linked repayments (server-computed). */
  paid?: number;
}
```

(b) Append a `SplitwiseRepayment` type to `web/src/splitwise/types.ts`:

```typescript
/** An incoming transaction the user marked as a friend repaying them. */
export interface SplitwiseRepayment {
  transactionId: string;
  counterpartyId: number;
  counterpartyName: string;
  currency: string;
  amount: number;
  createdAt: string;
}
```

(c) Create `web/src/splitwise/owed.ts`:

```typescript
import type { SplitwiseLink } from './types';

export interface OwedFriend {
  id: number;
  name: string;
  currency: string;
  owed: number;
}

/**
 * Per-friend money still owed to the user, from Hon's own links
 * (`Σ owed − Σ paid` per counterparty+currency, positive only). This replaces
 * reading Splitwise's net friend balances, which settle-ups shrink on their side.
 */
export function owedByFriend(links: SplitwiseLink[]): OwedFriend[] {
  const acc = new Map<string, OwedFriend>();
  for (const link of links) {
    for (const cp of link.counterparties) {
      const remaining = Math.max(0, cp.owed - (cp.paid ?? 0));
      if (remaining <= 0.001) continue;
      const key = `${cp.id}|${link.currency}`;
      const cur = acc.get(key);
      if (cur) cur.owed += remaining;
      else acc.set(key, { id: cp.id, name: cp.name, currency: link.currency, owed: remaining });
    }
  }
  return [...acc.values()].map((f) => ({ ...f, owed: Math.round(f.owed * 100) / 100 }));
}
```

- [ ] **Step 4: Run owed.test.ts to verify it passes**

Run: `cd web && npx vitest run src/splitwise/owed.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing useSplitwise repayment test**

Append inside the `describe('useSplitwise', …)` block in `web/src/splitwise/useSplitwise.test.ts`:

```typescript
  it('marks a repayment and updates links + repayments from the response', async () => {
    const link = {
      transactionId: 'e1', expenseId: 'x1', groupId: null, currency: 'ILS',
      owedToMe: 60, counterparties: [{ id: 2, name: 'Roomie', owed: 60, paid: 0 }],
      paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
    };
    const paidLink = { ...link, paidAmount: 60, paidState: 'paid',
      counterparties: [{ id: 2, name: 'Roomie', owed: 60, paid: 60 }] };
    const repayment = { transactionId: 'r1', counterpartyId: 2, counterpartyName: 'Roomie',
      currency: 'ILS', amount: 60, createdAt: '2026-05-10' };
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [link], repayments: [] }),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [link] }),
      'POST /api/splitwise/repayment': () => ({ links: [paidLink], repayments: [repayment] }),
    });
    const { result } = renderHook(() => useSplitwise());
    await waitFor(() => expect(result.current.connected).toBe(true));
    await act(async () => { await result.current.markRepayment('r1', 2, 'ILS'); });
    expect(result.current.linkByTxnId.get('e1')?.paidState).toBe('paid');
    expect(result.current.repaymentByTxnId.get('r1')?.counterpartyName).toBe('Roomie');
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd web && npx vitest run src/splitwise/useSplitwise.test.ts`
Expected: FAIL — `markRepayment` / `repaymentByTxnId` undefined.

- [ ] **Step 7: Implement useSplitwise changes**

In `web/src/splitwise/useSplitwise.ts`:

(a) Extend the type import:

```typescript
import type {
  SplitwiseFriendBalance, SplitwiseLink, SplitwisePickList, SplitwiseRepayment,
  SplitwiseShare, SplitwiseUser,
} from './types';
```

(b) Add `repayments` to `CacheShape` and the initial cache + `__resetSplitwiseCache`:

```typescript
interface CacheShape {
  loaded: boolean;
  connected: boolean;
  user: SplitwiseUser | null;
  links: SplitwiseLink[];
  friends: SplitwiseFriendBalance[];
  repayments: SplitwiseRepayment[];
}

let cache: CacheShape = {
  loaded: false, connected: false, user: null, links: [], friends: [], repayments: [],
};
```

```typescript
export function __resetSplitwiseCache(): void {
  cache = { loaded: false, connected: false, user: null, links: [], friends: [], repayments: [] };
  inFlight = null;
}
```

(c) In `fetchAll`, read repayments from `/splitwise/links` and carry them:

```typescript
async function fetchAll(): Promise<void> {
  const [status, links] = await Promise.all([
    api<{ connected: boolean; user: SplitwiseUser | null }>('/splitwise/status'),
    api<{ links: SplitwiseLink[]; repayments: SplitwiseRepayment[] }>('/splitwise/links'),
  ]);
  cache = {
    loaded: true,
    connected: !!status.connected,
    user: status.user ?? null,
    links: links.links ?? [],
    friends: cache.friends,
    repayments: links.repayments ?? [],
  };
  broadcast();
  if (!cache.connected) return;
  try {
    const r = await api<{ friends: SplitwiseFriendBalance[]; links: SplitwiseLink[] }>(
      '/splitwise/refresh', 'POST',
    );
    cache = { ...cache, friends: r.friends ?? [], links: r.links ?? cache.links };
    broadcast();
  } catch { /* balances are best-effort — never block the dashboard */ }
}
```

(d) In `disconnect`, reset repayments too:

```typescript
  const disconnect = useCallback(() => guard(async () => {
    await api('/splitwise/disconnect', 'POST');
    cache = { loaded: true, connected: false, user: null, links: [], friends: [], repayments: [] };
    broadcast();
  }), [guard]);
```

(e) Add `markRepayment` / `unmarkRepayment` after `deleteExpense`:

```typescript
  const markRepayment = useCallback((
    transactionId: string, counterpartyId: number, counterpartyName: string,
  ) => guard(async () => {
    const r = await api<{ links: SplitwiseLink[]; repayments: SplitwiseRepayment[] }>(
      '/splitwise/repayment', 'POST', { transactionId, counterpartyId, counterpartyName },
    );
    cache = { ...cache, links: r.links ?? cache.links, repayments: r.repayments ?? cache.repayments };
    broadcast();
  }), [guard]);

  const unmarkRepayment = useCallback((transactionId: string) => guard(async () => {
    const r = await api<{ links: SplitwiseLink[]; repayments: SplitwiseRepayment[] }>(
      `/splitwise/repayment/${encodeURIComponent(transactionId)}`, 'DELETE',
    );
    cache = { ...cache, links: r.links ?? cache.links, repayments: r.repayments ?? cache.repayments };
    broadcast();
  }), [guard]);
```

(f) Add `repaymentByTxnId` + expose the new members. Before the `return`:

```typescript
  const linkByTxnId = new Map(cache.links.map((l) => [l.transactionId, l]));
  const repaymentByTxnId = new Map(cache.repayments.map((r) => [r.transactionId, r]));
```

In the `UseSplitwise` interface add:

```typescript
  repayments: SplitwiseRepayment[];
  repaymentByTxnId: Map<string, SplitwiseRepayment>;
  markRepayment: (transactionId: string, counterpartyId: number, counterpartyName: string) => Promise<void>;
  unmarkRepayment: (transactionId: string) => Promise<void>;
```

In the returned object add: `repayments: cache.repayments, repaymentByTxnId, markRepayment, unmarkRepayment,`.

> Note: `markRepayment`'s 3rd arg is `counterpartyName` (sent so the chip reads correctly even before a refresh). The Task 6 test calls `markRepayment('r1', 2, 'ILS')` — update that call's 3rd arg to a name. Use `markRepayment('r1', 2, 'Roomie')` and keep the mock as written (the mock ignores the body).

- [ ] **Step 8: Run useSplitwise + owed tests**

Run: `cd web && npx vitest run src/splitwise/useSplitwise.test.ts src/splitwise/owed.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/splitwise/types.ts web/src/splitwise/owed.ts web/src/splitwise/owed.test.ts web/src/splitwise/useSplitwise.ts web/src/splitwise/useSplitwise.test.ts
git commit -m "feat(splitwise): web owedByFriend + useSplitwise repayment mark/unmark"
```

---

## Task 7: Overview — owed-to-you + projection from links

**Files:**
- Modify: `web/src/overview/OwedToYouCard.tsx`
- Modify: `web/src/overview/OverviewView.tsx` (`BankProjection`, the `owed` computation ~248-252)
- Test: `web/src/overview/OwedToYouCard.test.tsx` (extend or add a case)

- [ ] **Step 1: Write the failing test**

Add to `web/src/overview/OwedToYouCard.test.tsx` (mirror the existing file's imports + `installFetchMock`/`__resetSplitwiseCache` setup; this case proves the card reads links, not Splitwise net balances):

```typescript
  it('shows per-friend owed from links even when Splitwise reports settled', async () => {
    const link = {
      transactionId: 'e1', expenseId: 'x1', groupId: null, currency: 'ILS',
      owedToMe: 60, counterparties: [{ id: 2, name: 'Roomie', owed: 60, paid: 0 }],
      paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
    };
    installFetchMock({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
      'GET /api/splitwise/links': () => ({ links: [link], repayments: [] }),
      // Splitwise says the friend settled (no balance) — the card must ignore this.
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [link] }),
    });
    render(<OwedToYouCard />);
    expect(await screen.findByText('Roomie')).toBeInTheDocument();
    expect(screen.getByText(/₪60/)).toBeInTheDocument();
  });
```

(If the test file lacks `render`/`screen`/`__resetSplitwiseCache` setup, copy it from the existing test cases in that file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/overview/OwedToYouCard.test.tsx`
Expected: FAIL — the card currently maps `sw.friends` (empty here) so "Roomie" isn't rendered.

- [ ] **Step 3: Rewrite OwedToYouCard to use links**

Replace `web/src/overview/OwedToYouCard.tsx`:

```typescript
import { money } from '../format';
import { owedByFriend } from '../splitwise/owed';
import { useSplitwise } from '../splitwise/useSplitwise';

// Overview card: friends who currently owe the user money, from Hon's own
// tracked splits (owed − linked repayments). Hidden until Splitwise is
// connected; "all settled up" when nothing is owed. Splitwise's own settle-up
// flag is intentionally not consulted — only real linked repayments reduce this.
export function OwedToYouCard() {
  const sw = useSplitwise();
  if (!sw.connected) return null;

  const owing = owedByFriend(sw.links);

  return (
    <section className="card">
      <div className="card-head">
        <h3>Owed to you</h3>
        <span className="spacer" />
        <span className="meta">via Splitwise</span>
      </div>
      {owing.length > 0 ? (
        <div className="list">
          {owing.map((f) => (
            <div key={`${f.id}-${f.currency}`} className="row">
              <div className="name">{f.name}</div>
              <span className="amount pos">{money(f.owed, f.currency)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">You're all settled up on Splitwise.</div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Update the BankProjection `owed` computation**

In `web/src/overview/OverviewView.tsx`, add the import near the other splitwise import:

```typescript
import { owedByFriend } from '../splitwise/owed';
```

Replace the `owed` computation in `BankProjection` (lines ~248-252):

```typescript
  const owed = sw.connected
    ? owedByFriend(sw.links)
        .filter((f) => f.currency === currency)
        .reduce((s, f) => s + f.owed, 0)
    : 0;
```

- [ ] **Step 5: Run the Overview tests**

Run: `cd web && npx vitest run src/overview/OwedToYouCard.test.tsx src/overview/OverviewView.test.tsx`
Expected: PASS. If a pre-existing OverviewView/OwedToYouCard case asserted the old friends-balance behavior, update its fixture to drive `links` (the projection's "Owed to you" line now comes from link counterparties, not `friends[].balances`).

- [ ] **Step 6: Commit**

```bash
git add web/src/overview/OwedToYouCard.tsx web/src/overview/OwedToYouCard.test.tsx web/src/overview/OverviewView.tsx web/src/overview/OverviewView.test.tsx
git commit -m "feat(splitwise): Overview owed-to-you + projection from links, not Splitwise balances"
```

---

## Task 8: Activity — mark an incoming transaction as a repayment

**Files:**
- Create: `web/src/activity/SplitwiseRepaymentSection.tsx` + `web/src/activity/SplitwiseRepaymentSection.test.tsx`
- Modify: `web/src/activity/ActivityView.tsx` (render it in the sidebar, next to `SplitwiseSection` ~956)

- [ ] **Step 1: Write the failing test**

Create `web/src/activity/SplitwiseRepaymentSection.test.tsx`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { SplitwiseRepaymentSection } from './SplitwiseRepaymentSection';
import type { Transaction } from './types';

afterEach(() => { vi.restoreAllMocks(); __resetSplitwiseCache(); });

const incoming: Transaction = {
  id: 'r1', accountId: 'a', externalId: 'x', date: '2026-05-10', processedDate: null,
  amount: 60, currency: 'ILS', description: 'Bit from roomie', memo: null, kind: null,
  status: null, category: null, createdAt: '2026-05-10',
};
const outgoing: Transaction = { ...incoming, id: 'o1', amount: -60 };

function connected() {
  installFetchMock({
    'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1, name: 'Me' } }),
    'GET /api/splitwise/links': () => ({ links: [], repayments: [] }),
    'POST /api/splitwise/refresh': () => ({ friends: [], links: [] }),
    'GET /api/splitwise/groups': () => ({ friends: [{ id: 2, name: 'Roomie' }], groups: [], me: { id: 1, name: 'Me' } }),
    'POST /api/splitwise/repayment': () => ({
      links: [], repayments: [{ transactionId: 'r1', counterpartyId: 2, counterpartyName: 'Roomie', currency: 'ILS', amount: 60, createdAt: '2026-05-10' }],
    }),
  });
}

describe('SplitwiseRepaymentSection', () => {
  it('renders nothing for an outgoing transaction', async () => {
    connected();
    const { container } = render(<SplitwiseRepaymentSection transaction={outgoing} />);
    await waitFor(() => expect(screen.queryByText(/repayment/i)).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it('lets the user mark an incoming transaction as a repayment', async () => {
    const user = userEvent.setup();
    connected();
    render(<SplitwiseRepaymentSection transaction={incoming} />);
    await user.click(await screen.findByRole('button', { name: /mark as splitwise repayment/i }));
    await user.click(await screen.findByRole('button', { name: 'Roomie' }));
    expect(await screen.findByText(/Repayment from Roomie/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/activity/SplitwiseRepaymentSection.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the component**

Create `web/src/activity/SplitwiseRepaymentSection.tsx`:

```typescript
import { useState } from 'react';
import { useSplitwise } from '../splitwise/useSplitwise';
import type { SplitwiseFriend } from '../splitwise/types';
import type { Transaction } from './types';

// Sidebar block for an INCOMING transaction: mark it as a friend repaying the
// user. Drives Splitwise paid-state from the real money, not Splitwise's
// settle-up flag. Hidden unless connected, the amount is positive, and the txn
// isn't already a split expense.
export function SplitwiseRepaymentSection({ transaction }: { transaction: Transaction }) {
  const sw = useSplitwise();
  const [picking, setPicking] = useState(false);
  const [friends, setFriends] = useState<SplitwiseFriend[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isExpenseLink = sw.linkByTxnId.has(transaction.id);
  if (!sw.connected || !(transaction.amount > 0) || isExpenseLink) return null;

  const existing = sw.repaymentByTxnId.get(transaction.id);

  const openPicker = async (): Promise<void> => {
    setError(null);
    setPicking(true);
    if (!friends) {
      try { setFriends((await sw.loadPickList()).friends); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); setPicking(false); }
    }
  };

  const pick = async (f: SplitwiseFriend): Promise<void> => {
    setBusy(true); setError(null);
    try { await sw.markRepayment(transaction.id, f.id, f.name); setPicking(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const unmark = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { await sw.unmarkRepayment(transaction.id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="txn-sidebar-section">
      <div className="label">Splitwise repayment</div>
      {existing ? (
        <div className="rf-linked">
          <div className="rf-linked-name">↩ Repayment from {existing.counterpartyName}</div>
          <button
            type="button" className="rf-unlink" aria-label="Remove repayment"
            disabled={busy} onClick={() => void unmark()}
          >✕</button>
        </div>
      ) : picking ? (
        <div className="rf-picklist">
          {(friends ?? []).map((f) => (
            <button
              key={f.id} type="button" className="txn-sidebar-action"
              disabled={busy} onClick={() => void pick(f)}
            >{f.name}</button>
          ))}
        </div>
      ) : (
        <button type="button" className="txn-sidebar-action" onClick={() => void openPicker()}>
          Mark as Splitwise repayment
        </button>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run src/activity/SplitwiseRepaymentSection.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Render it in the Activity sidebar**

In `web/src/activity/ActivityView.tsx`, add the import next to the `SplitwiseSection` import (line ~14):

```typescript
import { SplitwiseRepaymentSection } from './SplitwiseRepaymentSection';
```

Render it right after `<SplitwiseSection transaction={transaction} />` (line ~956):

```typescript
            <SplitwiseSection transaction={transaction} />
            <SplitwiseRepaymentSection transaction={transaction} />
```

- [ ] **Step 6: Full web suite + both typechecks**

Run: `cd web && npm test`
Expected: PASS (all web tests).
Run: `cd web && npm run typecheck`
Expected: clean.
Run: `cd sidecar && npm test && npm run typecheck`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/activity/SplitwiseRepaymentSection.tsx web/src/activity/SplitwiseRepaymentSection.test.tsx web/src/activity/ActivityView.tsx
git commit -m "feat(splitwise): mark an incoming transaction as a repayment (Activity sidebar)"
```

---

## Task 9: Live verification (PROJECT-RULES §2 — required gate, not a code task)

> No commit. The dev server is Shahar's own — do NOT call `preview_start`. Run a worktree vite (`<worktree>/web`, a free port) against the live engine on `:4000`, verify via chrome-devtools, read screenshots back. Splitwise must be connected in the live DB for the full flow; if it isn't, verify what's reachable and say so.

- [ ] **Step 1:** Symlink node_modules into the worktree (`web`, `sidecar`) if missing; start `npx vite --port <free> --strictPort` from `<worktree>/web`. Read the dev token from `<dataDir>/dev-token`. Connect chrome-devtools (CDP 9222).
- [ ] **Step 2:** Overview tab — screenshot "Owed to you" (now from links).
- [ ] **Step 3:** Activity tab — open an incoming transaction's sidebar; screenshot the "Mark as Splitwise repayment" control; mark it from a friend; screenshot the chip; confirm the linked expense's "remaining owed" drops and the expense's effective amount reverts. Unmark; confirm it reverts.
- [ ] **Step 4:** Confirm a Splitwise-side settle-up alone no longer changes Hon's owed-to-you (open splits stay owed with no repayment linked).
- [ ] **Step 5:** Stop the worktree vite; close the throwaway page.

---

## Self-Review

**1. Spec coverage:**
- "Stop reading Splitwise payment records; pool from marked repayments" → Tasks 3-4 (drop `get_expenses`/`attributePayments`, `recomputePaidStates` from `getRepaymentPool`).
- "`splitwise_repayments` table (migration 37)" → Task 1. "per-counterparty `paid` in counterparties JSON" → Tasks 2-3 (`paid?` + `allocatePayments`).
- "Owed-to-you + projection from links" → Tasks 6-7 (`owedByFriend`, OwedToYouCard, BankProjection).
- "Activity: mark incoming txn as repayment; chip; unmark; only positive amounts" → Task 8.
- "Behavior on existing data: prematurely-paid revert to open" → covered by the recompute (Task 4 test asserts open with no repayment) and verified live (Task 9 step 4).
- "Edge cases (overpay, currency mismatch, partial, multi-friend, non-incoming reject)" → Task 3 tests + Task 5 route guards + Task 8 outgoing test.
- "txn_effective unchanged" → no DB view edits anywhere; `paid_amount` semantics preserved.
- "Tests + verification" → per-task tests + Task 9.
- Spec refinement noted: the pool reads `splitwise_repayments.amount` captured at mark time rather than joining `transactions` — same result, simpler + testable. ✅ all covered.

**2. Placeholder scan:** No TBD/TODO; every code step has full code; commands have expected output. The one "match the existing import members" instruction (Task 5 Step 1) is a concrete edit, not a placeholder.

**3. Type consistency:** `allocatePayments(links, Map<string,number>) → PaidResult[]` used identically in Task 3 (def) and Task 4 (`recomputePaidStates`). `updateSplitwiseLinkPaid(id, amount, state, counterparties)` 4-arg signature defined Task 2, called Task 4. `SplitwiseRepayment` fields identical across repo (Task 2), web types (Task 6), routes (Task 5), and tests. `markRepayment(transactionId, counterpartyId: number, counterpartyName: string)` consistent: hook (Task 6) ↔ component `pick` call `sw.markRepayment(transaction.id, f.id, f.name)` (Task 8). `owedByFriend(links) → {id,name,currency,owed}[]` consistent: def (Task 6) ↔ OwedToYouCard + BankProjection (Task 7). Pool key format `"{id}|{currency}"` identical in `getRepaymentPool` (Task 2), `allocatePayments` (Task 3), and `owedByFriend`'s grouping. Counterparty id is `number` in JSON/TS and stored `String()` in DB, parsed back with `Number()` (Task 2 `toRepayment`) — consistent.
