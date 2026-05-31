# Savings Transaction Mark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user mark a bank transaction as "Savings" so it's pulled out of every spend/minus calculation and instead tallied as money saved this cycle.

**Architecture:** A first-class `savings` flag on transactions (new column, mirrors the existing `excluded_manual` pattern). A new `PATCH /transactions/:id/savings` route persists it; the two marks are mutually exclusive. Backend `monthlySpending` and the React shared `isExcludedFromCycle` predicate both treat savings rows as out-of-cycle. The React Activity tab gains a "Savings" toggle + a "Savings" bucket, and the Overview gains a "Saved this cycle" line.

**Tech stack:** Node + Fastify + better-sqlite3 (sidecar), React 19 + TS strict + Vitest (web).

**Spec:** `docs/superpowers/specs/2026-05-31-savings-transaction-mark-design.md`

**Runtime note:** better-sqlite3 returns INTEGER columns as JS numbers, and the codebase does not coerce `excluded_manual` to a boolean. We therefore use **truthy** checks for `savings` (`if (t.savings)`) rather than `=== true`, and type it `boolean | null` to match the existing `excludedManual` convention. Do NOT add coercion — out of scope.

**Worktree:** already created at `.claude/worktrees/savings-txn-mark-2026-05-31` with `web/node_modules` symlinked. Run web commands from `<worktree>/web`, sidecar from `<worktree>/sidecar`.

---

## File Structure

- `sidecar/src/db.ts` — migration v38 + `SCHEMA_VERSION` bump (38).
- `sidecar/src/repo.ts` — `TXN_COLS` += `savings`; `TxnRow.savings`; `setTransactionSavings`; mutual-exclusivity in `setTransactionExcluded`; `monthlySpending` excludes savings.
- `sidecar/src/server.ts` — `PATCH /transactions/:id/savings`.
- `sidecar/tests/repo.test.ts` — repo savings behaviour.
- `web/src/activity/types.ts` — `Transaction.savings`.
- `web/src/activity/excluded.ts` — savings ⇒ out-of-cycle.
- `web/src/overview/spend.ts` — `savedThisCycle` helper.
- `web/src/activity/ActivityView.tsx` — third bucket, `SavingsSection`, sidebar "Savings" toggle.
- `web/src/overview/OverviewView.tsx` — "Saved this cycle" line.
- `web/src/styles.css` — `.act-savings*` + `.ov-saved`.
- Test files alongside (`*.test.ts(x)`).

---

## Task 1: DB migration — `savings` column

**Files:**
- Modify: `sidecar/src/db.ts` (`SCHEMA_VERSION`, migrations array)

- [ ] **Step 1: Bump `SCHEMA_VERSION`**

`sidecar/src/db.ts` line 5:
```ts
export const SCHEMA_VERSION = 38;
```

- [ ] **Step 2: Append the migration** after the `version: 37` (`splitwise_repayments`) entry, before the closing `];` of the migrations array:

```ts
  {
    // Per-transaction "Savings" mark. 1 = money the user moved to savings;
    // such rows are pulled OUT of spend / "minus" calculations (like
    // excluded_manual) AND tallied as "saved this cycle". Mutually exclusive
    // with excluded_manual (the repo setters enforce that).
    version: 38,
    sql: `ALTER TABLE transactions ADD COLUMN savings INTEGER;`,
  },
```

- [ ] **Step 3: Typecheck**

Run: `cd sidecar && npm run typecheck`
Expected: PASS (no output errors).

- [ ] **Step 4: Commit**

```bash
git add sidecar/src/db.ts
git commit -m "feat(db): add transactions.savings column (migration 38)"
```

---

## Task 2: Repo — persist + read + exclude savings from spend

**Files:**
- Modify: `sidecar/src/repo.ts` (`TXN_COLS`, `TxnRow`, `setTransactionExcluded`, `setTransactionSavings`, `monthlySpending`)
- Test: `sidecar/tests/repo.test.ts`

- [ ] **Step 1: Write failing tests** — append to `sidecar/tests/repo.test.ts` (follow the file's existing harness for opening an in-memory/temp repo + inserting a transaction; reuse whatever helper the existing tests use to create a txn — e.g. `insertTxn`/`upsertTxn`). Test names + assertions:

```ts
describe('savings mark', () => {
  it('setTransactionSavings(true) sets savings and clears excluded_manual', () => {
    const id = makeTxn(repo, { amount: -1000, category: 'Transfers' }); // existing helper
    repo.setTransactionExcluded(id, true);
    repo.setTransactionSavings(id, true);
    const row = repo.getTransaction(id)!;
    expect(row.savings).toBe(1);
    expect(row.excludedManual ?? null).toBeNull();
  });

  it('setTransactionExcluded(true) clears a prior savings mark', () => {
    const id = makeTxn(repo, { amount: -1000 });
    repo.setTransactionSavings(id, true);
    repo.setTransactionExcluded(id, true);
    const row = repo.getTransaction(id)!;
    expect(row.savings).toBe(0);
    expect(row.excludedManual).toBe(1);
  });

  it('monthlySpending excludes savings rows', () => {
    makeTxn(repo, { amount: -500, category: 'Shopping', date: '2026-05-10' });
    const sid = makeTxn(repo, { amount: -1000, category: 'Transfers', date: '2026-05-10' });
    repo.setTransactionSavings(sid, true);
    const spend = repo.monthlySpending('2026-05-01', '2026-06-01');
    const total = spend.reduce((s, r) => s + r.total, 0);
    expect(total).toBe(500); // the 1000 savings transfer is not counted
  });
});
```

> If the test file has no `makeTxn`/`getTransaction`-by-id helper, add a small local helper at the top of the describe that inserts a row via the same path other tests use, and read it back with `repo.getTransaction(id)`. `getTransaction` already exists (used by the routes).

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd sidecar && npx vitest run tests/repo.test.ts -t "savings mark"`
Expected: FAIL — `setTransactionSavings` is not a function / `row.savings` undefined.

- [ ] **Step 3: Add `savings` to `TXN_COLS`** (so reads include it). Change:

```ts
const TXN_COLS =
  'id, account_id AS accountId, external_id AS externalId, date, ' +
  'processed_date AS processedDate, amount, currency, description, memo, ' +
  'kind, status, category, created_at AS createdAt, loan_id AS loanId, ' +
  'excluded_manual AS excludedManual, savings';
```

- [ ] **Step 4: Add `savings` to the `TxnRow` interface** (after `refundForId?`):

```ts
  /** "Savings" mark: 1 = money moved to savings — out of spend, tallied as
   *  saved. Mutually exclusive with excluded_manual. */
  savings?: number | null;
```

- [ ] **Step 5: Make `setTransactionExcluded` clear savings when excluding.** Replace the method body:

```ts
  setTransactionExcluded(txnId: string, excluded: boolean | null): void {
    if (excluded === true) {
      // Excluding manually and the Savings mark are mutually exclusive.
      this.db
        .prepare('UPDATE transactions SET excluded_manual = 1, savings = 0 WHERE id = ?')
        .run(txnId);
      return;
    }
    const value = excluded === null ? null : 0;
    this.db
      .prepare('UPDATE transactions SET excluded_manual = ? WHERE id = ?')
      .run(value, txnId);
  }
```

- [ ] **Step 6: Add `setTransactionSavings`** directly below it:

```ts
  /** Mark/unmark a transaction as a savings transfer. A savings row is pulled
   *  out of spend (like an excluded row) AND tallied as "saved this cycle".
   *  Marking savings clears any manual exclude — the two are mutually
   *  exclusive. */
  setTransactionSavings(txnId: string, savings: boolean): void {
    if (savings) {
      this.db
        .prepare('UPDATE transactions SET savings = 1, excluded_manual = NULL WHERE id = ?')
        .run(txnId);
    } else {
      this.db
        .prepare('UPDATE transactions SET savings = 0 WHERE id = ?')
        .run(txnId);
    }
  }
```

- [ ] **Step 7: Exclude savings from `monthlySpending`.** In the `monthlySpending` SQL, add the savings filter to the WHERE clause:

```ts
        `SELECT category, SUM(-amount) AS total
         FROM txn_effective
         WHERE category IS NOT NULL AND amount < 0 AND currency = 'ILS'
           AND date >= @start AND date < @end ${exclude}
           AND id NOT IN (SELECT id FROM transactions WHERE savings = 1)
         GROUP BY category`,
```

> `txn_effective` exposes `t.id` as `id`; the subquery drops savings rows. `monthlyInflow` needs no change — savings transfers are outflows (`amount < 0`) and inflow only sums positive Income/Transfers.

- [ ] **Step 8: Run tests — verify they pass**

Run: `cd sidecar && npx vitest run tests/repo.test.ts -t "savings mark"`
Expected: PASS (3 tests).

- [ ] **Step 9: Run full sidecar suite + typecheck**

Run: `cd sidecar && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add sidecar/src/repo.ts sidecar/tests/repo.test.ts
git commit -m "feat(repo): savings mark — persist, mutual-exclude, drop from monthlySpending"
```

---

## Task 3: Server — `PATCH /transactions/:id/savings`

**Files:**
- Modify: `sidecar/src/server.ts` (after the `/transactions/:id/excluded` handler, ~line 1805)

- [ ] **Step 1: Add the route** immediately after the existing `app.patch('/transactions/:id/excluded', ...)` block:

```ts
/**
 * Mark/unmark a transaction as a savings transfer. Body `{ savings: boolean }`.
 * A savings row drops out of spend totals AND is tallied as "saved this cycle";
 * it is mutually exclusive with the manual exclude (the repo clears one when
 * setting the other).
 */
app.patch('/transactions/:id/savings', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { savings?: boolean };
  if (typeof body.savings !== 'boolean') {
    return reply.code(400).send({ error: 'savings must be a boolean' });
  }
  if (!repo.getTransaction(id)) {
    return reply.code(404).send({ error: 'transaction not found' });
  }
  repo.setTransactionSavings(id, body.savings);
  return { ok: true, savings: body.savings };
});
```

- [ ] **Step 2: Typecheck** (routes are tested manually per project convention)

Run: `cd sidecar && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add sidecar/src/server.ts
git commit -m "feat(server): PATCH /transactions/:id/savings"
```

---

## Task 4: React — `savings` field + out-of-cycle predicate

**Files:**
- Modify: `web/src/activity/types.ts`
- Modify: `web/src/activity/excluded.ts`
- Test: `web/src/activity/excluded.test.ts` (create if absent)

- [ ] **Step 1: Add the field** to `Transaction` in `web/src/activity/types.ts`, after `excludedManual`:

```ts
  /** "Savings" mark — money moved to savings. Out of spend, tallied as saved.
   *  Number at runtime (SQLite INTEGER); use truthy checks. */
  savings?: boolean | null;
```

- [ ] **Step 2: Write failing test** in `web/src/activity/excluded.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isExcludedFromCycle } from './excluded';
import type { Transaction } from './types';

const base = { currency: 'ILS', amount: -100, description: 'x' } as Transaction;
const settings = { hideCardTotals: true, cardProviders: [] };

describe('isExcludedFromCycle — savings', () => {
  it('treats a savings row as out of cycle', () => {
    expect(isExcludedFromCycle({ ...base, savings: true }, settings)).toBe(true);
  });
  it('a normal row is not out of cycle', () => {
    expect(isExcludedFromCycle({ ...base, savings: false }, settings)).toBe(false);
  });
});
```

- [ ] **Step 3: Run — verify it fails**

Run: `cd web && npx vitest run src/activity/excluded.test.ts`
Expected: FAIL — savings row returns false.

- [ ] **Step 4: Implement** — add the savings check at the top of `isExcludedFromCycle` in `web/src/activity/excluded.ts`:

```ts
export function isExcludedFromCycle(
  t: Transaction,
  settings: ExclusionSettings,
): boolean {
  if (t.savings) return true; // savings transfers are never counted as spend
  if (t.excludedManual === true) return true;
  if (t.excludedManual === false) return false;
  return ruleMatches(t, settings);
}
```

- [ ] **Step 5: Run — verify pass**

Run: `cd web && npx vitest run src/activity/excluded.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/activity/types.ts web/src/activity/excluded.ts web/src/activity/excluded.test.ts
git commit -m "feat(web): Transaction.savings + isExcludedFromCycle treats savings as out-of-cycle"
```

---

## Task 5: React — `savedThisCycle` tally helper

**Files:**
- Modify: `web/src/overview/spend.ts`
- Test: `web/src/overview/spend.test.ts`

- [ ] **Step 1: Write failing test** — append to `web/src/overview/spend.test.ts` (reuse the existing `txn()` factory in that file):

```ts
import { savedThisCycle } from './spend';

describe('savedThisCycle', () => {
  it('sums |amount| of ILS savings rows in the cycle, ignores the rest', () => {
    const txns = [
      txn({ amount: -1000, savings: true, date: '2026-05-10' }),
      txn({ amount: -250, savings: true, date: '2026-05-20' }),
      txn({ amount: -999, savings: false, date: '2026-05-10' }), // not savings
      txn({ amount: -500, savings: true, currency: 'USD', date: '2026-05-10' }), // non-ILS
      txn({ amount: -700, savings: true, date: '2026-04-10' }), // prev cycle
    ];
    expect(savedThisCycle(txns, '2026-05', 1)).toBe(1250);
  });
});
```

> If `txn()` in `spend.test.ts` doesn't accept `savings`, it spreads `...over`, so `txn({ savings: true })` already works.

- [ ] **Step 2: Run — verify fail**

Run: `cd web && npx vitest run src/overview/spend.test.ts -t savedThisCycle`
Expected: FAIL — `savedThisCycle` is not exported.

- [ ] **Step 3: Implement** — add to `web/src/overview/spend.ts` (uses the already-imported `cycleKey`):

```ts
/**
 * Total money marked as "Savings" in the given cycle (ILS only). Sums the
 * absolute amount of savings-flagged rows so the Overview can show "saved this
 * cycle" — the counterpart to the donut's spend total.
 */
export function savedThisCycle(
  transactions: Transaction[],
  key: string,
  monthStartDay: number,
): number {
  let total = 0;
  for (const t of transactions) {
    if (!t.savings) continue;
    if (t.currency !== 'ILS') continue;
    if (cycleKey(t.date, monthStartDay) !== key) continue;
    total += Math.abs(t.amount);
  }
  return total;
}
```

- [ ] **Step 4: Run — verify pass + full overview suite**

Run: `cd web && npx vitest run src/overview`
Expected: PASS (the existing `categorySpend` tests still pass — savings rows are dropped from the pie via `isExcludedFromCycle`, which `categorySpend`'s `isExcluded` argument already applies in OverviewView).

- [ ] **Step 5: Commit**

```bash
git add web/src/overview/spend.ts web/src/overview/spend.test.ts
git commit -m "feat(web): savedThisCycle tally helper"
```

---

## Task 6: React Activity — Savings toggle + Savings bucket

**Files:**
- Modify: `web/src/activity/ActivityView.tsx`
- Modify: `web/src/styles.css`
- Test: `web/src/activity/ActivityView.test.tsx`

- [ ] **Step 1: Three-way bucket split.** Replace the existing two-bucket loop (the `for (const t of monthTxnsAll)` block) with:

```tsx
  const monthTxns: Transaction[] = [];
  const excludedTxns: Transaction[] = [];
  const savingsTxns: Transaction[] = [];
  for (const t of monthTxnsAll) {
    if (t.savings) savingsTxns.push(t);                       // savings bucket
    else if (isExcludedFromCycle(t, exclusionSettings)) excludedTxns.push(t);
    else monthTxns.push(t);
  }
```

> Order matters: savings is checked first so savings rows land in their own bucket, not the generic "Excluded" one (`isExcludedFromCycle` also returns true for them now).

- [ ] **Step 2: Add the `SavingsSection` component.** Add directly below the existing `ExcludedSection` function. It mirrors `ExcludedSection` but with a savings label/icon and `act-savings` classes:

```tsx
interface SavingsSectionProps {
  transactions: Transaction[];
  accountById: Map<string, Account>;
  onPickTxn: (t: Transaction) => void;
  selectedIds: Set<string>;
}

/** Bottom-of-page collapsible holding transactions marked as Savings. Its
 *  header total is the "saved this cycle" figure; clicking a row reopens the
 *  sidebar to unmark it. */
function SavingsSection({
  transactions, accountById, onPickTxn, selectedIds,
}: SavingsSectionProps) {
  const [open, setOpen] = useState(false);
  const total = transactions.reduce((s, t) => s + Math.abs(t.amount), 0);
  const cur = transactions[0]?.currency ?? 'ILS';
  return (
    <section className="act-savings">
      <button
        type="button"
        className="act-savings-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="act-savings-caret">{open ? '▾' : '▸'}</span>
        <span className="act-savings-name">Savings ({transactions.length})</span>
        <span className="act-savings-line" />
        <span className="act-savings-total">{money(total, cur)}</span>
      </button>
      {open && (
        <ul className="txn-list">
          {transactions
            .slice()
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .map((t) => {
              const acct = accountById.get(t.accountId);
              const selected = selectedIds.has(t.id);
              return (
                <li
                  key={t.id}
                  className={`txn act-savings-row${selected ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onPickTxn(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPickTxn(t); }
                  }}
                >
                  <span className="txn-icon">💰</span>
                  <div className="txn-main">
                    <div className="txn-name">{t.description}</div>
                    <div className="txn-sub">
                      {fmtDate(t.date)}
                      {acct && (<><span className="sep"> · </span>{acct.label || acct.connectionName}</>)}
                    </div>
                  </div>
                  <div className="txn-amt">{money(t.amount, t.currency)}</div>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}
```

> Match the exact closing markup of `ExcludedSection`'s `<li>` (amount span class etc.) — copy that row's trailing JSX verbatim if it differs from the above (e.g. the amount element). Read the lines after 625 to confirm the row tail before finalizing.

- [ ] **Step 3: Render `SavingsSection`** next to the existing `ExcludedSection` render (the `{excludedTxns.length > 0 && (<ExcludedSection .../>)}` block). Add right before it:

```tsx
          {savingsTxns.length > 0 && (
            <SavingsSection
              transactions={savingsTxns}
              accountById={accountById}
              onPickTxn={setMoving}
              selectedIds={selectedIds}
            />
          )}
```

> Use the SAME prop values the sibling `ExcludedSection` is given (`accountById`, the pick handler, `selectedIds`). If those identifiers differ in the file, match the `ExcludedSection` call exactly.

- [ ] **Step 4: Empty-state guard.** The empty check `monthTxns.length === 0 && excludedTxns.length === 0` must also consider savings. Update it to:

```tsx
      ) : monthTxns.length === 0 && excludedTxns.length === 0 && savingsTxns.length === 0 ? (
```

- [ ] **Step 5: Add the "Savings" sidebar toggle.** The sidebar component (the one receiving `excluded` / `ruleMatched` / `onSetExcluded`) gets two new props. Add to its props interface:

```tsx
  /** Whether this txn is marked as a savings transfer. */
  savings: boolean;
  onSetSavings: (next: boolean) => void | Promise<void>;
```

Destructure `savings, onSetSavings` alongside `excluded, ruleMatched, onSetExcluded`. Then add a second toggle inside the existing `<div className="txn-sidebar-section">` (the "Cycle calculations" block), right after the "Exclude from cycle" `<label>`:

```tsx
              <label className="txn-sidebar-toggle">
                <span className="txn-sidebar-toggle-main">
                  <span className="txn-sidebar-toggle-name">Savings</span>
                  <span className="txn-sidebar-toggle-sub">
                    {savings
                      ? 'Money moved to savings — kept out of spend, tallied separately.'
                      : 'Counts as regular spend. Turn on for transfers to savings.'}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={savings}
                  disabled={busy}
                  onChange={(e) => { void onSetSavings(e.target.checked); }}
                  aria-label="Mark as savings transfer"
                />
              </label>
```

- [ ] **Step 6: Wire the sidebar props at the mount site.** Where the sidebar is rendered with `excluded={isExcludedFromCycle(moving, ...)}` / `onSetExcluded={...}`, add:

```tsx
          savings={!!moving.savings}
          onSetSavings={async (next: boolean) => {
            await api(
              `/transactions/${encodeURIComponent(moving.id)}/savings`,
              'PATCH',
              { savings: next },
            );
            await refresh();
          }}
```

- [ ] **Step 7: Add CSS** — append to `web/src/styles.css`. Reuse the `.act-excluded*` look (find that block and mirror it). Minimal addition:

```css
/* Activity "Savings" bucket — mirrors .act-excluded, money-tinted. */
.act-savings { margin-top: 10px; }
.act-savings-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  background: none; border: 0; cursor: pointer; padding: 8px 4px;
  color: var(--muted); font-size: 12.5px; font-weight: 600;
}
.act-savings-caret { width: 12px; color: var(--faint); }
.act-savings-name { color: var(--green); }
.act-savings-line { flex: 1; height: 1px; background: var(--hairline); }
.act-savings-total { color: var(--green); font-variant-numeric: tabular-nums; font-weight: 700; }
.act-savings-row .txn-amt { color: var(--green); }
```

> If `.act-excluded` uses different structure, copy its rules and rename `excluded`→`savings`, swapping the accent to `--green`.

- [ ] **Step 8: Write/extend tests** in `web/src/activity/ActivityView.test.tsx` (follow the file's existing render + `installFetchMock` harness; mock `GET /api/transactions` to include a `savings: true` row in the current cycle):

```tsx
it('files savings rows in a Savings bucket, not the spend list', async () => {
  // ...mock transactions incl. { id:'s1', amount:-1000, savings:true, date:<current cycle> }
  // render, open Activity
  expect(await screen.findByText(/Savings \(1\)/)).toBeInTheDocument();
  // expand + assert the row + total ₪1,000 present; assert it's absent from the counted list
});
```

> Use the same current-cycle date helper the other ActivityView tests use. Keep the assertion focused on the bucket header + total.

- [ ] **Step 9: Run web tests + typecheck**

Run: `cd web && npx vitest run src/activity && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add web/src/activity/ActivityView.tsx web/src/styles.css web/src/activity/ActivityView.test.tsx
git commit -m "feat(web): Activity Savings toggle + Savings bucket"
```

---

## Task 7: React Overview — "Saved this cycle" line

**Files:**
- Modify: `web/src/overview/OverviewView.tsx`
- Modify: `web/src/styles.css`
- Test: `web/src/overview/OverviewView.test.tsx`

- [ ] **Step 1: Import the helper.** Add `savedThisCycle` to the existing import from `./spend`:

```tsx
import { buildPieCats, savedThisCycle } from './spend';
```

- [ ] **Step 2: Compute the figure** next to the existing `spend`/`spendChangePct` computation in `OverviewView` (uses the already-present `recurring`, `curKey`, `settings.monthStartDay`):

```tsx
  const saved = recurring
    ? savedThisCycle(recurring.transactions, curKey, settings.monthStartDay)
    : 0;
```

- [ ] **Step 3: Render the line** — inside the `ov-stack`, immediately after the `</div>` that closes the `ov-grid` block and before `<OwedToYouCard />`:

```tsx
        {saved > 0 && (
          <div className="ov-saved" data-testid="saved-this-cycle">
            <span className="ov-saved-ico">💰</span>
            <span className="ov-saved-label">Saved this cycle</span>
            <span className="ov-saved-amt">{money(saved, 'ILS')}</span>
          </div>
        )}
```

- [ ] **Step 4: Add CSS** — append to `web/src/styles.css`:

```css
/* Overview "saved this cycle" line. */
.ov-saved {
  display: flex; align-items: center; gap: 10px;
  background: var(--card); border: 1px solid var(--hairline);
  border-radius: 14px; padding: 13px 16px; box-shadow: var(--shadow-sm);
}
.ov-saved-ico { font-size: 16px; }
.ov-saved-label { color: var(--muted); font-size: 13px; font-weight: 600; }
.ov-saved-amt {
  margin-left: auto; color: var(--green); font-weight: 800;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 5: Write the test** in `web/src/overview/OverviewView.test.tsx` (reuse `mocks()`; override `GET /api/transactions` to include a current-cycle `savings: true` row alongside `RECURRING_DEFAULT.transactions`):

```tsx
it('shows "Saved this cycle" from savings-marked transactions', async () => {
  installFetchMock(mocks({
    'GET /api/transactions': () => ({ transactions: [
      ...RECURRING_DEFAULT.transactions,
      { id: 'sv1', date: `${currentCycleKey(1)}-12`, amount: -1500, currency: 'ILS',
        description: 'To savings', category: 'Transfers', refundForId: null, savings: true },
    ] }),
  }));
  renderOverview();
  const line = await screen.findByTestId('saved-this-cycle');
  expect(within(line).getByText(/1,?500/)).toBeInTheDocument();
});
```

> Import `currentCycleKey` from `../cycle` in the test if not already imported. `renderOverview`, `mocks`, `RECURRING_DEFAULT` already exist in the file.

- [ ] **Step 6: Run + typecheck**

Run: `cd web && npx vitest run src/overview/OverviewView.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/overview/OverviewView.tsx web/src/styles.css web/src/overview/OverviewView.test.tsx
git commit -m "feat(web): Overview 'Saved this cycle' line"
```

---

## Task 8: Full verification

- [ ] **Step 1: Full suites + typechecks**

Run: `cd web && npm test && npm run typecheck` then `cd ../sidecar && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 2: Visual verification (PROJECT-RULES §2 — required).** Start a worktree vite on a spare port; load the app via chrome-devtools MCP against the running engine (`:4000`); then:
  1. Activity → pick a transfer-to-savings transaction → toggle **Savings** on → confirm it leaves the counted list and appears in the **Savings** bucket with the right total.
  2. Overview → confirm the spend pie / "Variable spent" dropped by that amount and **"Saved this cycle"** shows it.
  3. Toggle it back off → confirm it returns to spend and the saved line updates.
  Screenshot each and Read the screenshots. Do NOT claim done without the screenshots.

  > Marking savings writes to the real DB. Use a transaction that genuinely is a savings transfer (or revert the mark after verifying) so the user's data isn't left mis-tagged.

- [ ] **Step 3: Update HANDOFF.md** with a short entry (what shipped, the new column/route, mutual-exclusivity, legacy-out-of-scope note).

- [ ] **Step 4: Commit + present merge options** (merge local / PR / keep), per the session's established flow. Engine restart note: the new migration runs on next engine start — confirm `npm run dev` has been cycled before relying on it live.

---

## Self-review notes

- **Spec coverage:** data model (T1–2), API (T3), spend-calc backend (T2 `monthlySpending`) + React (T4 `isExcludedFromCycle`, inherited by pie/Insights/Activity), Activity toggle (T6) + bucket (T6), Overview tally (T7), net-worth untouched (no code), mutual-exclusivity (T2), legacy out of scope (no task). ✓
- **Type consistency:** `setTransactionSavings(txnId, savings: boolean)` used identically in repo + server; `savedThisCycle(transactions, key, monthStartDay)` defined in T5, called in T7; `Transaction.savings` defined T4, used T5/T6/T7. ✓
- **Truthy `savings`:** every React read uses `if (t.savings)` / `!!moving.savings` / `!t.savings`, never `=== true`, matching the number-at-runtime reality. ✓
