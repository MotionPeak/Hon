# Loan detection & linking — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bank-scraped loans live only in the Loans tab, with a "Last payment" badge + expandable payment history sourced from auto-linked transactions, plus a post-sync banner + nav-dot when a new loan is detected.

**Architecture:** New `transactions.loan_id` column + heuristic matcher run on every scrape (and as a 12-month backfill at loan creation). `GET /loans` augmented to include a `payments` field per loan. A new `PATCH /transactions/:id/loan` endpoint for manual override. UI: `AccountsView` drops its loan section; `LoansView` renders the new badge + history; the existing transaction-move sidebar gains a Loans section; localStorage tracks unseen loan ids for the post-sync banner + nav-dot.

**Tech Stack:** SQLite via `better-sqlite3` (engine); Fastify routes; React 19 + Vitest + React Testing Library (web); Radix Dialog (already a dep).

**Spec:** [docs/superpowers/specs/2026-05-27-loan-detection-and-linking-design.md](../specs/2026-05-27-loan-detection-and-linking-design.md)

---

## File map

**Engine (`sidecar/`)**
- Modify `sidecar/src/db.ts` — add migration v33 (`ALTER TABLE transactions ADD COLUMN loan_id TEXT`) + bump `SCHEMA_VERSION` to 33.
- Create `sidecar/src/loanMatcher.ts` — pure `matchPaymentToLoan(txn, loans)` function.
- Modify `sidecar/src/repo.ts` — extend `TxnRow`/`Loan` row maps with `loanId`/`payments`, add `setTransactionLoan`, `listLoanPayments`, run matcher inside `upsertBankLoan` (12-mo backfill) + inside the per-account transaction sync (new rows pass).
- Modify `sidecar/src/server.ts` — augment `GET /loans` response shape, add `PATCH /transactions/:id/loan` route.
- Create `sidecar/tests/loanMatcher.test.ts` — table-driven matcher tests.
- Modify `sidecar/tests/loans.test.ts` — backfill + setTransactionLoan + endpoint tests.

**Web (`web/`)**
- Modify `web/src/accounts/types.ts` — extend `Loan` with `payments` field; add `LoanPayment` type.
- Modify `web/src/accounts/AccountsView.tsx` — drop loan render block + loan fetch.
- Modify `web/src/accounts/AccountsView.test.tsx` — drop loan-render assertions, add post-sync banner + localStorage tests.
- Modify `web/src/loans/LoansView.tsx` — render last-payment badge + collapsible history list.
- Modify `web/src/loans/LoansView.test.tsx` — last-payment + history toggle tests.
- Modify `web/src/activity/ActivityView.tsx` — add Loans section to the move sidebar.
- Modify `web/src/activity/ActivityView.test.tsx` — link/unlink-to-loan tests.
- Modify `web/src/App.tsx` — read `localStorage['hon.unseenLoanIds']`, attach `data-unseen` to Loans nav button.
- Modify `web/src/App.test.tsx` — nav-dot presence test.
- Modify `web/src/styles.css` — add `.loan-last-paid`, `.loan-history`, `.loan-new-banner`, `.nav-btn[data-unseen]::after` rules.

**Spec docs**
- Don't touch — already committed at `docs/superpowers/specs/2026-05-27-loan-detection-and-linking-design.md`.

---

## Conventions for this plan

- Engine tests run from `sidecar/` with `npm test`. Web tests run from `web/` with `npm test -- --run <path>`.
- Every "Commit" step uses the message format the repo's recent commits use (see `git log --oneline -20`): one-line subject, blank line, body, `Co-Authored-By` footer.
- Steps use `cd <dir> &&` explicitly so each command is copy-pasteable.

---

### Task 1: Engine — schema migration for `transactions.loan_id`

**Files:**
- Modify: `sidecar/src/db.ts:5` (bump constant), `sidecar/src/db.ts:639` (append migration)

- [ ] **Step 1: Bump `SCHEMA_VERSION` to 33**

Open `sidecar/src/db.ts` line 5 and change:

```ts
export const SCHEMA_VERSION = 29;
```

to:

```ts
export const SCHEMA_VERSION = 33;
```

(Existing migrations already reach v32; the new v33 below brings the constant + the migrations list back in sync.)

- [ ] **Step 2: Append the new migration**

Inside the `MIGRATIONS` array in `sidecar/src/db.ts` (the array ends at line 639 with `];`), insert a new entry right before the closing bracket:

```ts
  {
    // Per-transaction link to a Loan row. Bank-loan payments are detected
    // by the loanMatcher (sidecar/src/loanMatcher.ts) after each scrape
    // and after a new bank loan is first written, then this column carries
    // the link so the Loans tab can render a "Last payment" badge + the
    // per-loan payment history without re-running pattern matching on
    // every request. SQLite `ALTER TABLE ADD COLUMN` cannot carry a
    // REFERENCES clause, so the column is a plain TEXT — integrity is
    // maintained by setTransactionLoan's existence check and a
    // delete-time null-out step.
    version: 33,
    sql: `ALTER TABLE transactions ADD COLUMN loan_id TEXT;`,
  },
```

- [ ] **Step 3: Run the engine test suite to confirm the migration applies on a fresh DB**

```bash
cd sidecar && npm test
```

Expected: PASS — all 41 existing backend tests still green (each test uses an in-memory DB which now goes through the new migration on open).

- [ ] **Step 4: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add sidecar/src/db.ts && \
  git commit -m "$(cat <<'EOF'
sidecar: schema v33 — transactions.loan_id

New nullable TEXT column on transactions, populated by an upcoming
loanMatcher to attach bank-loan payment rows to their Loan record.
Plain TEXT (SQLite ALTER TABLE ADD COLUMN can't carry REFERENCES),
integrity will be maintained by the upcoming setTransactionLoan
endpoint + a delete-time null-out.

Bumps SCHEMA_VERSION from the stale 29 to 33 so the constant catches
up with the actual migrations list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Engine — pure `matchPaymentToLoan` function

**Files:**
- Create: `sidecar/src/loanMatcher.ts`
- Create: `sidecar/tests/loanMatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/loanMatcher.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchPaymentToLoan } from '../src/loanMatcher.js';
import type { Loan } from '../src/loans.js';

const baseLoan = (over: Partial<Loan> = {}): Loan => ({
  id: 'L1',
  name: 'משכנתא',
  principal: 1_000_000,
  startDate: '2022-01-01',
  termMonths: 240,
  isPrime: false,
  isCpiLinked: false,
  rateValue: 0.04,
  cpiStart: null,
  currency: 'ILS',
  excluded: false,
  notes: null,
  connectionId: 'C1',
  externalId: '12345678',
  nameOverridden: false,
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
  ...over,
});

describe('matchPaymentToLoan', () => {
  it('picks the loan whose externalId appears in the description', () => {
    const loans = [
      baseLoan({ id: 'A', externalId: '11111111' }),
      baseLoan({ id: 'B', externalId: '12345678' }),
    ];
    const m = matchPaymentToLoan(
      { description: 'הלואה-תשלום 12345678', amount: -1700 },
      loans,
    );
    expect(m).toBe('B');
  });

  it('falls back to a 3+ character name-token match', () => {
    const loans = [baseLoan({ id: 'A', externalId: '99999999', name: 'משכנתא דירה' })];
    const m = matchPaymentToLoan(
      { description: 'תשלום דירה חודשי', amount: -2400 },
      loans,
    );
    expect(m).toBe('A');
  });

  it('strips the literal word הלוואה/loan from the loan name before tokenising', () => {
    const loans = [baseLoan({ id: 'A', externalId: '99', name: 'הלוואה לרכב' })];
    // The description shares only the stop-word "הלוואה" + "לרכב". The token
    // match must succeed on "לרכב", NOT just because both texts say "הלוואה".
    expect(
      matchPaymentToLoan({ description: 'הלוואה לרכב', amount: -800 }, loans),
    ).toBe('A');
    // And it must NOT trigger when the only shared token is the stop-word.
    expect(
      matchPaymentToLoan({ description: 'הלוואה כללית', amount: -800 }, loans),
    ).toBe(null);
  });

  it('uses the single-loan fallback when the description mentions "הלוואה"', () => {
    const loans = [baseLoan({ id: 'A', externalId: '99', name: 'משכנתא' })];
    const m = matchPaymentToLoan(
      { description: 'הלואה-תשלום', amount: -1500 },
      loans,
    );
    expect(m).toBe('A');
  });

  it('uses the single-loan fallback when the description mentions "loan" (case-insensitive)', () => {
    const loans = [baseLoan({ id: 'A', externalId: '99', name: 'Car' })];
    expect(
      matchPaymentToLoan({ description: 'LOAN payment Apr', amount: -700 }, loans),
    ).toBe('A');
  });

  it('returns null on a multi-loan tie at the same rule', () => {
    const loans = [
      baseLoan({ id: 'A', externalId: '111', name: 'משכנתא' }),
      baseLoan({ id: 'B', externalId: '222', name: 'משכנתא' }),
    ];
    // Single-loan fallback is gated to exactly one loan, so two loans yields null.
    expect(
      matchPaymentToLoan({ description: 'הלוואה תשלום', amount: -1700 }, loans),
    ).toBe(null);
  });

  it('returns null for positive-amount transactions (income, not a payment)', () => {
    const loans = [baseLoan({ id: 'A', externalId: '12345678' })];
    expect(
      matchPaymentToLoan({ description: 'הלוואה 12345678', amount: 5000 }, loans),
    ).toBe(null);
  });

  it('returns null when no loans exist on the connection', () => {
    expect(
      matchPaymentToLoan({ description: 'הלוואה תשלום', amount: -1500 }, []),
    ).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sidecar && npm test -- loanMatcher
```

Expected: FAIL with "Cannot find module '../src/loanMatcher.js'".

- [ ] **Step 3: Write minimal implementation**

Create `sidecar/src/loanMatcher.ts`:

```ts
import type { Loan } from './loans.js';

/** The minimum shape of a transaction the matcher needs. Keeping this
 *  narrow lets the matcher run against either a TxnRow from the repo
 *  or a row mid-insert (where we have fields but not yet an id). */
export interface MatchableTxn {
  description: string;
  amount: number;
}

const LOAN_STOPWORD = /\b(הלוואה|halvaa|loan)\b/iu;
const LOAN_STOPWORD_STRIP = /הלוואה|halvaa|loan/giu;

/** Tokens of length ≥3 from a loan name after removing the literal
 *  "הלוואה" / "halvaa" / "loan" stopword. Lowercase Latin; Hebrew
 *  stays as-is (case-insensitivity is moot for Hebrew). */
function nameTokens(name: string): string[] {
  return name
    .replace(LOAN_STOPWORD_STRIP, ' ')
    .split(/[\s\-_.,/\\()]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map((t) => t.toLowerCase());
}

/** Returns the id of the matching loan, or null. Skips positive amounts
 *  (those are income, not payments). Tries externalId hit → name-token
 *  hit → single-loan stopword fallback, in that order. Multi-loan ties
 *  at any rule yield null so the user disambiguates manually. */
export function matchPaymentToLoan(
  txn: MatchableTxn,
  loans: Loan[],
): string | null {
  if (txn.amount >= 0) return null;
  if (loans.length === 0) return null;
  const desc = (txn.description || '').trim();
  if (!desc) return null;
  const descLower = desc.toLowerCase();

  // Rule 1 — externalId hit. Single match wins; multiple is a tie → null.
  const extHits = loans.filter(
    (l) => l.externalId && desc.includes(l.externalId),
  );
  if (extHits.length === 1) return extHits[0]!.id;
  if (extHits.length > 1) return null;

  // Rule 2 — name-token hit. Each loan contributes its tokens; pick the
  // loan whose tokens are uniquely present.
  const tokenHits = loans.filter((l) => {
    const tokens = nameTokens(l.name);
    return tokens.some((t) => descLower.includes(t));
  });
  if (tokenHits.length === 1) return tokenHits[0]!.id;
  if (tokenHits.length > 1) return null;

  // Rule 3 — single-loan stopword fallback.
  if (loans.length === 1 && LOAN_STOPWORD.test(desc)) return loans[0]!.id;

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sidecar && npm test -- loanMatcher
```

Expected: PASS — all 8 tests green.

- [ ] **Step 5: Run the whole engine suite to confirm nothing else broke**

```bash
cd sidecar && npm test
```

Expected: PASS — 41 prior + 8 new = 49 tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add sidecar/src/loanMatcher.ts sidecar/tests/loanMatcher.test.ts && \
  git commit -m "$(cat <<'EOF'
sidecar: matchPaymentToLoan — pure heuristic matcher

A small pure function that, given a transaction and the loans on its
connection, returns the loan id the transaction should attach to (or
null). Three rules in order:

  1. externalId substring hit (strongest — bank-emitted loan number)
  2. ≥3-char name-token hit, after stripping the literal stopword
     "הלוואה" / "halvaa" / "loan" so the stopword alone never wins
  3. Single-loan fallback when the only loan on the connection is
     paired with a stopword-bearing description

Ties at any rule → null (the user disambiguates via the upcoming
PATCH /transactions/:id/loan endpoint). Positive-amount rows skip
entirely — those are income, not payments.

8 new tests; 49/49 backend green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Engine — repo helpers + matcher invocation in `upsertBankLoan`

**Files:**
- Modify: `sidecar/src/repo.ts` — extend `Loan` row map, add `setTransactionLoan`, `listLoanPayments`, run the matcher in `upsertBankLoan` after the upsert.
- Modify: `sidecar/tests/loans.test.ts` — backfill test.

- [ ] **Step 1: Write the failing test for the 12-month backfill**

Open `sidecar/tests/loans.test.ts` and append (do not replace) a new `describe`:

```ts
describe('upsertBankLoan — backfill matcher', () => {
  it('attaches existing matching transactions to a newly-upserted loan', () => {
    const repo = freshRepo();
    // Create a connection + account with a pre-existing loan-payment
    // transaction, BEFORE the loan is upserted.
    const conn = repo.upsertConnection({
      companyId: 'beinleumi',
      displayName: 'Beinleumi',
    });
    const acctId = repo.upsertAccount({
      connectionId: conn.id,
      accountNumber: '1-2-3',
      label: 'Checking',
      balance: 1000,
      currency: 'ILS',
    });
    repo.upsertTransaction({
      accountId: acctId,
      externalId: 'txn-1',
      date: '2026-05-10',
      processedDate: null,
      amount: -1747.17,
      currency: 'ILS',
      description: 'הלואה-תשלום 12345678',
      memo: null, kind: null, status: null, rawJson: '{}',
    });

    // Now upsert the matching loan. The backfill should tag the prior txn.
    const loan = repo.upsertBankLoan(conn.id, {
      name: 'משכנתא',
      principal: 100_000,
      startDate: '2024-01-01',
      termMonths: 120,
      isPrime: false,
      isCpiLinked: false,
      rateValue: 0.04,
      currency: 'ILS',
      externalId: '12345678',
    });

    const payments = repo.listLoanPayments(loan.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.externalId).toBe('txn-1');
  });

  it('does NOT touch transactions older than 12 months', () => {
    const repo = freshRepo();
    const conn = repo.upsertConnection({
      companyId: 'beinleumi', displayName: 'Beinleumi',
    });
    const acctId = repo.upsertAccount({
      connectionId: conn.id, accountNumber: 'a', label: null,
      balance: 0, currency: 'ILS',
    });
    // 18 months ago — outside the backfill window.
    const oldDate = new Date();
    oldDate.setMonth(oldDate.getMonth() - 18);
    repo.upsertTransaction({
      accountId: acctId, externalId: 'old', date: oldDate.toISOString().slice(0, 10),
      processedDate: null, amount: -500, currency: 'ILS',
      description: 'הלוואה 12345678', memo: null, kind: null, status: null, rawJson: '{}',
    });
    const loan = repo.upsertBankLoan(conn.id, {
      name: 'L', principal: 1000, startDate: '2020-01-01',
      termMonths: 120, isPrime: false, isCpiLinked: false, rateValue: 0,
      currency: 'ILS', externalId: '12345678',
    });
    expect(repo.listLoanPayments(loan.id)).toHaveLength(0);
  });
});
```

(The `freshRepo()` helper already exists in this test file — re-use it. If the file lacks `upsertConnection` / `upsertAccount` / `upsertTransaction` helpers, fall back to the existing patterns at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sidecar && npm test -- loans
```

Expected: FAIL with "repo.listLoanPayments is not a function".

- [ ] **Step 3: Add `setTransactionLoan` and `listLoanPayments` to Repo**

In `sidecar/src/repo.ts`, after the existing `listLoans()` method (around line 1809) and before `upsertBankLoan` (around line 1867), add:

```ts
  /** Sets (or clears) the loan link on a single transaction. Validates
   *  that loanId, when provided, exists — callers can rely on the row
   *  being a valid foreign key without SQLite enforcing it. */
  setTransactionLoan(txnId: string, loanId: string | null): void {
    if (loanId !== null && !this.getLoan(loanId)) {
      throw new Error(`unknown loan id: ${loanId}`);
    }
    this.db
      .prepare('UPDATE transactions SET loan_id = ? WHERE id = ?')
      .run(loanId, txnId);
  }

  /** Every transaction linked to this loan, newest-first. */
  listLoanPayments(loanId: string): TxnRow[] {
    return this.db
      .prepare(
        `SELECT ${TXN_COLS}
         FROM transactions
         WHERE loan_id = ?
         ORDER BY date DESC, id DESC`,
      )
      .all(loanId) as TxnRow[];
  }
```

(`TXN_COLS` is the column-list constant used by other transaction queries in this file — search for `listTransactions` to find it. If it isn't a named constant, copy the SELECT column list verbatim.)

- [ ] **Step 4: Wire the backfill matcher into `upsertBankLoan`**

At the end of `upsertBankLoan` (around line 1925, just before the final `return this.getLoan(...)`), insert:

```ts
    // Backfill the 12-month window of this connection's transactions:
    // every negative-amount, loan_id=null row that matches the new loan
    // gets attached so the Loans card has history straight away instead
    // of waiting for the next month's payment to land.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const candidates = this.db
      .prepare(
        `SELECT t.id, t.description, t.amount
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.connection_id = ?
           AND t.loan_id IS NULL
           AND t.amount < 0
           AND t.date >= ?`,
      )
      .all(connectionId, cutoffIso) as
      { id: string; description: string; amount: number }[];
    const loansOnConn = this.listLoans().filter((l) => l.connectionId === connectionId);
    const update = this.db.prepare('UPDATE transactions SET loan_id = ? WHERE id = ?');
    for (const c of candidates) {
      const match = matchPaymentToLoan(c, loansOnConn);
      if (match) update.run(match, c.id);
    }
```

Add the import at the top of `sidecar/src/repo.ts`:

```ts
import { matchPaymentToLoan } from './loanMatcher.js';
```

- [ ] **Step 5: Run tests to verify backfill works**

```bash
cd sidecar && npm test -- loans
```

Expected: PASS — the new backfill tests + every prior loan test.

- [ ] **Step 6: Run the whole suite**

```bash
cd sidecar && npm test
```

Expected: PASS — 51 tests (49 prior + 2 backfill).

- [ ] **Step 7: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add sidecar/src/repo.ts sidecar/tests/loans.test.ts && \
  git commit -m "$(cat <<'EOF'
sidecar: repo — setTransactionLoan, listLoanPayments, upsert backfill

Three small additions wiring the new loan_id column into Repo:

- setTransactionLoan(txnId, loanId | null) — validates that loanId
  (when present) refers to a real loan before the UPDATE, since
  SQLite doesn't enforce the foreign key for plain TEXT columns.
- listLoanPayments(loanId) — TxnRow[] newest-first; backs the
  Loans card's expandable payment history.
- upsertBankLoan now finalises with a 12-month backfill: every
  unlinked negative-amount transaction on the connection is run
  through matchPaymentToLoan, hits get UPDATEd in place. Means a
  freshly-detected loan ships with history instead of an empty
  state that fills in over time.

2 new tests; 51/51 backend green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Engine — run matcher in the per-account transaction sync

**Files:**
- Modify: `sidecar/src/repo.ts` — find the per-account transaction upsert block (around line 855), run matcher on the new rows.

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/loans.test.ts`:

```ts
describe('per-account sync — matcher', () => {
  it('tags freshly-inserted matching transactions with the loan id', () => {
    const repo = freshRepo();
    const conn = repo.upsertConnection({
      companyId: 'beinleumi', displayName: 'Beinleumi',
    });
    // Loan exists first.
    const loan = repo.upsertBankLoan(conn.id, {
      name: 'משכנתא', principal: 100_000, startDate: '2024-01-01',
      termMonths: 120, isPrime: false, isCpiLinked: false, rateValue: 0.04,
      currency: 'ILS', externalId: '12345678',
    });
    // Now an account + a fresh transaction land via the sync path.
    repo.applyScrape(conn.id, {
      accounts: [{
        accountNumber: '1-2-3', label: 'Checking',
        balance: 1000, currency: 'ILS',
        transactions: [{
          externalId: 'txn-new', date: new Date().toISOString().slice(0, 10),
          processedDate: null, amount: -1747.17, currency: 'ILS',
          description: 'הלואה-תשלום 12345678',
          memo: null, kind: null, status: null, rawJson: '{}',
        }],
      }],
      holdings: [],
    });
    const payments = repo.listLoanPayments(loan.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.externalId).toBe('txn-new');
  });
});
```

(The `applyScrape` method name and shape may differ — search `sidecar/src/repo.ts` for the public method that takes `connectionId` + scraped accounts; copy its expected shape from the existing tests in this file.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sidecar && npm test -- loans
```

Expected: FAIL — payments list is empty because the matcher doesn't run on sync-time inserts yet.

- [ ] **Step 3: Wire the matcher into the per-account transaction pass**

In `sidecar/src/repo.ts`, locate the per-transaction loop inside the scrape-apply method (search for the `upsertTxn.run({` call around line 855). After the existing run, insert:

```ts
            // Auto-link bank-loan payments. Cheap: loansForConn is
            // computed once outside the loop; the matcher is pure.
            // Skip if a manual link already exists (we don't override).
            const existingLoanId = this.db
              .prepare('SELECT loan_id FROM transactions WHERE id = ?')
              .get(txn.id) as { loan_id: string | null } | undefined;
            if (!existingLoanId?.loan_id) {
              const match = matchPaymentToLoan(
                { description: txn.description, amount: txn.amount },
                loansForConn,
              );
              if (match) {
                this.db
                  .prepare('UPDATE transactions SET loan_id = ? WHERE id = ?')
                  .run(match, txn.id);
              }
            }
```

Above the per-account loop (search for where the outer scrape loop starts), compute `loansForConn` once:

```ts
    const loansForConn = this.listLoans().filter((l) => l.connectionId === connectionId);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd sidecar && npm test -- loans
```

Expected: PASS — the new sync-time test + every prior test.

- [ ] **Step 5: Run the whole suite**

```bash
cd sidecar && npm test
```

Expected: PASS — 52 tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add sidecar/src/repo.ts sidecar/tests/loans.test.ts && \
  git commit -m "$(cat <<'EOF'
sidecar: per-account sync runs loan matcher on fresh transactions

Freshly-scraped transactions now go through matchPaymentToLoan
inline with their upsert, so new loan payments arrive at the
Loans tab already linked. Pulls the connection's loans once
above the per-account loop (cheap; the matcher is pure). Skips
rows that already have loan_id set so a user's manual link or
unlink isn't clobbered by an auto-match on the next sync.

1 new test; 52/52 backend green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Engine — augment `GET /loans` + add `PATCH /transactions/:id/loan`

**Files:**
- Modify: `sidecar/src/server.ts` — augment `GET /loans`, add `PATCH /transactions/:id/loan`.
- Modify: `sidecar/tests/loans.test.ts` — endpoint tests via the existing test-server harness if one exists; otherwise test by hand-invoking the route handler.

- [ ] **Step 1: Write the failing test for the augmented `/loans` shape**

Append to `sidecar/tests/loans.test.ts`:

```ts
describe('GET /loans response shape', () => {
  it('includes a payments array per loan (sourced from listLoanPayments)', () => {
    const repo = freshRepo();
    const conn = repo.upsertConnection({
      companyId: 'beinleumi', displayName: 'Beinleumi',
    });
    const acctId = repo.upsertAccount({
      connectionId: conn.id, accountNumber: 'a', label: null,
      balance: 0, currency: 'ILS',
    });
    repo.upsertTransaction({
      accountId: acctId, externalId: 't1', date: '2026-05-10',
      processedDate: null, amount: -1747.17, currency: 'ILS',
      description: 'הלוואה 12345678', memo: null, kind: null,
      status: null, rawJson: '{}',
    });
    const loan = repo.upsertBankLoan(conn.id, {
      name: 'L', principal: 100_000, startDate: '2024-01-01',
      termMonths: 120, isPrime: false, isCpiLinked: false, rateValue: 0,
      currency: 'ILS', externalId: '12345678',
    });
    // The server route is thin — we exercise the repo-side shape here.
    const loans = repo.listLoans();
    const target = loans.find((l) => l.id === loan.id);
    expect(target).toBeDefined();
    const payments = repo.listLoanPayments(loan.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      externalId: 't1', date: '2026-05-10', amount: -1747.17,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
cd sidecar && npm test -- loans
```

Expected: PASS — this test exercises shapes that already exist after Tasks 3-4. (It's a regression guard, not a feature gate.)

- [ ] **Step 3: Augment the `GET /loans` route shape**

In `sidecar/src/server.ts`, find the `app.get('/loans', …)` handler (around line 1601). Locate the response build — it returns something like `{ loans: enriched }`. For each loan, attach a `payments` field:

```ts
app.get('/loans', async (_req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const loans = repo.listLoans().map((l) => {
    const state = computeLoanState(l, prime, cpiNow);
    return {
      ...l,
      rateType: l.isCpiLinked ? (l.isPrime ? 'cpi-prime' : 'cpi-fixed')
                              : (l.isPrime ? 'prime' : 'fixed'),
      state,
      payments: repo.listLoanPayments(l.id).map((p) => ({
        id: p.id, date: p.date, amount: p.amount,
        accountId: p.accountId, description: p.description,
      })),
    };
  });
  return { loans, rates: { prime, cpiNow } };
});
```

(The exact existing code may already wrap loans in an enrichment step — preserve that step and append `payments` to the spread. Match the existing style verbatim.)

- [ ] **Step 4: Add the manual-override route**

Right after the `GET /loans` handler, add:

```ts
app.patch('/transactions/:id/loan', async (req, reply) => {
  if (!repo) return reply.code(503).send({ error: 'database unavailable' });
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { loanId?: string | null };
  // Caller may pass loanId: null to unlink, or omit it (treated as null).
  const loanId = body.loanId ?? null;
  if (loanId !== null && !repo.getLoan(loanId)) {
    return reply.code(404).send({ error: 'loan not found' });
  }
  try {
    repo.setTransactionLoan(id, loanId);
    return { ok: true, loanId };
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});
```

- [ ] **Step 5: Run the whole engine suite**

```bash
cd sidecar && npm test
```

Expected: PASS — 53/53 (52 + the new shape regression).

- [ ] **Step 6: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add sidecar/src/server.ts sidecar/tests/loans.test.ts && \
  git commit -m "$(cat <<'EOF'
sidecar: GET /loans now returns payments per loan; PATCH txn loan

Two HTTP additions for the loan-detection feature:

- GET /loans augments each Loan with payments: { id, date, amount,
  accountId, description }[], newest-first, sourced from
  Repo.listLoanPayments. Single round trip — no new endpoint —
  so the React LoansView fetch shape stays unchanged.
- PATCH /transactions/:id/loan { loanId | null } — the manual
  override. Validates the loan id exists before writing; allows
  null to clear a link. Used by the Activity transaction-move
  sidebar's upcoming Loans section.

53/53 backend green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Web — `Loan` type + `LoanPayment` type

**Files:**
- Modify: `web/src/accounts/types.ts`

- [ ] **Step 1: Edit the file**

Open `web/src/accounts/types.ts` and add at the bottom (after the existing `Loan` interface):

```ts
/** A single linked loan-payment transaction. Mirrors the shape the engine
 *  attaches to each Loan on GET /loans. */
export interface LoanPayment {
  id: string;
  date: string;
  amount: number;
  accountId: string;
  description: string;
}
```

Then locate the `Loan` interface (search for `export interface Loan {`) and add to it:

```ts
  /** Bank-detected payments linked to this loan, newest-first. Empty for
   *  manual / SnapTrade / pension loans. Server-populated by listLoanPayments. */
  payments?: LoanPayment[];
}
```

(Optional `?` because manual fixtures in unit tests may omit it.)

- [ ] **Step 2: Run typecheck**

```bash
cd web && npm run typecheck
```

Expected: PASS — type additions are non-breaking.

- [ ] **Step 3: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add web/src/accounts/types.ts && \
  git commit -m "$(cat <<'EOF'
web: types — Loan.payments + LoanPayment interface

Mirrors the new field on the engine's GET /loans response so the
React Loans view can render last-payment + history without
type-casting around it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Web — `LoansView` last-payment badge + collapsible history

**Files:**
- Modify: `web/src/loans/LoansView.tsx`
- Modify: `web/src/loans/LoansView.test.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write the failing test for the last-payment badge**

Open `web/src/loans/LoansView.test.tsx` and append a new `describe`:

```ts
describe('LoansView — payment history', () => {
  const today = new Date();
  const isoDaysAgo = (n: number) => {
    const d = new Date(today); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const loanWithPayments = (over: Partial<Loan> = {}) => ({
    id: 'L1', name: 'Mortgage', principal: 100_000, startDate: '2024-01-01',
    termMonths: 120, isPrime: false, isCpiLinked: false, rateValue: 0.04,
    cpiStart: null, currency: 'ILS', excluded: false, notes: null,
    connectionId: 'C1', externalId: '12345678', nameOverridden: false,
    createdAt: '2025-01-01', updatedAt: '2025-01-01',
    rateType: 'fixed' as const,
    state: { monthsElapsed: 12, monthsRemaining: 108, annualRate: 0.04,
      monthlyPayment: 1747, outstanding: 92_000, totalPaid: 21_000,
      progress: 0.1, cpiRatio: 1 },
    payments: [
      { id: 't1', date: isoDaysAgo(10), amount: -1747.17, accountId: 'a', description: 'הלואה' },
      { id: 't2', date: isoDaysAgo(40), amount: -1747.17, accountId: 'a', description: 'הלואה' },
    ],
    ...over,
  });

  it('renders a Last payment badge when payments exist', async () => {
    installFetchMock({
      'GET /api/loans': () => ({ loans: [loanWithPayments()], rates: { prime: 6, cpiNow: 1 } }),
    });
    render(<LoansView />);
    expect(await screen.findByText(/last payment/i)).toBeInTheDocument();
    expect(screen.getByText(/1,?747/)).toBeInTheDocument();
  });

  it('does NOT render the badge when payments is empty', async () => {
    installFetchMock({
      'GET /api/loans': () => ({
        loans: [loanWithPayments({ payments: [] })],
        rates: { prime: 6, cpiNow: 1 },
      }),
    });
    render(<LoansView />);
    await screen.findByText('Mortgage');
    expect(screen.queryByText(/last payment/i)).not.toBeInTheDocument();
  });

  it('history toggle reveals every linked payment, newest-first', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/loans': () => ({ loans: [loanWithPayments()], rates: { prime: 6, cpiNow: 1 } }),
    });
    render(<LoansView />);
    await user.click(await screen.findByRole('button', { name: /2 payments/i }));
    // Two payment rows now visible.
    const list = await screen.findByTestId('loan-history-L1');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
  });
});
```

Add the missing imports at the top of the file (skip any already present):

```ts
import userEvent from '@testing-library/user-event';
import { within } from '@testing-library/react';
import type { Loan } from '../accounts/types';
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- --run src/loans
```

Expected: FAIL — the badge and toggle don't exist yet.

- [ ] **Step 3: Render the badge + history in `LoansView`**

In `web/src/loans/LoansView.tsx`, inside the per-loan card render (search for where the card body is built), insert the badge above the existing card meta and a toggle/history block below it. Replace the existing `<article className="loan-card">…</article>` block's body with one that includes:

```tsx
function LoanCard({ loan }: { loan: Loan }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const payments = loan.payments ?? [];
  const lastPaid = payments[0] ?? null;
  const daysSince = lastPaid
    ? Math.round((Date.now() - new Date(lastPaid.date).getTime()) / 86_400_000)
    : null;
  const overdue = daysSince !== null && daysSince > 35;
  return (
    <article className="loan-card">
      {/* …existing card head + summary remains untouched… */}
      {lastPaid && (
        <div className={`loan-last-paid${overdue ? ' overdue' : ' ok'}`}>
          {overdue ? '⚠ Possibly missed' : '✓ Last payment'}
          {' · '}
          <b>{money(Math.abs(lastPaid.amount), loan.currency)}</b>
          {' on '}
          {new Date(lastPaid.date).toLocaleDateString(undefined,
            { day: 'numeric', month: 'short' })}
        </div>
      )}
      {payments.length > 0 && (
        <>
          <button
            type="button"
            className="loan-history-toggle"
            onClick={() => setHistoryOpen((o) => !o)}
            aria-expanded={historyOpen}
          >
            {historyOpen ? '▴' : '▾'} {payments.length} payment{payments.length === 1 ? '' : 's'}
          </button>
          {historyOpen && (
            <ul className="loan-history" data-testid={`loan-history-${loan.id}`}>
              {payments.slice(0, 24).map((p) => (
                <li key={p.id} className="loan-history-row">
                  <span className="loan-history-date">
                    {new Date(p.date).toLocaleDateString(undefined,
                      { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                  <span className="loan-history-amt">
                    {money(Math.abs(p.amount), loan.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}
```

(If the existing `LoansView.tsx` renders cards inline rather than via a `<LoanCard>` component, extract the per-loan JSX into the component above and replace the inline render with `<LoanCard key={l.id} loan={l} />`.)

Ensure `useState` is imported.

- [ ] **Step 4: Add the CSS**

Append to `web/src/styles.css`:

```css
/* Loan-card: last-paid badge + collapsible history. */
.loan-last-paid {
  font-size: 12px; font-weight: 600;
  padding: 5px 10px; border-radius: 999px;
  display: inline-flex; align-items: baseline; gap: 4px;
  margin-top: 8px;
}
.loan-last-paid.ok      { background: rgba(61,220,132,0.14); color: var(--green); }
.loan-last-paid.overdue { background: rgba(245,181,74,0.16); color: var(--amber); }
.loan-last-paid b { font-variant-numeric: tabular-nums; }

.loan-history-toggle {
  margin-top: 10px;
  background: transparent; border: 0; cursor: pointer;
  color: var(--muted); font-size: 11.5px; font-weight: 600;
  padding: 4px 0;
}
.loan-history-toggle:hover { color: var(--text); }

.loan-history {
  list-style: none; padding: 6px 0 0; margin: 0;
  display: flex; flex-direction: column; gap: 4px;
  max-height: 320px; overflow-y: auto;
  border-top: 1px solid var(--hairline);
  margin-top: 6px;
}
.loan-history-row {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 12px; padding: 5px 2px;
  border-top: 1px solid var(--hairline);
}
.loan-history-row:first-child { border-top: 0; }
.loan-history-date { color: var(--muted); }
.loan-history-amt  { color: var(--text); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 5: Run tests to verify everything passes**

```bash
cd web && npm test -- --run src/loans
```

Expected: PASS — every existing LoansView test + the three new ones.

- [ ] **Step 6: Run the whole web suite + typecheck**

```bash
cd web && npm test -- --run && npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add web/src/loans/LoansView.tsx web/src/loans/LoansView.test.tsx web/src/styles.css && \
  git commit -m "$(cat <<'EOF'
web: LoansView — Last payment badge + collapsible history list

Per-loan card grows two new affordances driven by the new
loan.payments field from GET /loans:

- Last payment badge in the card header (green when within ~35
  days, amber + "Possibly missed" when older).
- Collapsible "▾ N payments" toggle at the foot; expanded body
  is a newest-first list of (date · amount) rows, capped at 24
  per render (more-button next pass).

Both hidden when payments is empty so manual / SnapTrade /
pension loans see exactly the card they see today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Web — drop loan section from `AccountsView`

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx`
- Modify: `web/src/accounts/AccountsView.test.tsx`

- [ ] **Step 1: Write the failing test that asserts loans aren't rendered**

Append to `web/src/accounts/AccountsView.test.tsx`:

```ts
describe('AccountsView — no longer shows loans', () => {
  it('does not render a loan card even when /loans returns one', async () => {
    installFetchMock({
      'GET /api/companies':   () => ({ companies: [] }),
      'GET /api/connections': () => ({ connections: [] }),
      'GET /api/accounts':    () => ({ accounts: [] }),
      'GET /api/assets':      () => ({ assets: [] }),
      'GET /api/loans':       () => ({
        loans: [{
          id: 'L1', name: 'Mortgage', principal: 100_000,
          startDate: '2024-01-01', termMonths: 120,
          isPrime: false, isCpiLinked: false, rateValue: 0.04,
          cpiStart: null, currency: 'ILS', excluded: false, notes: null,
          connectionId: 'C1', externalId: '12345678', nameOverridden: false,
          createdAt: '2025-01-01', updatedAt: '2025-01-01',
        }],
        rates: { prime: null, cpiNow: null },
      }),
      'GET /api/brokerage': () => ({ holdings: [] }),
    });
    render(<AccountsView />);
    // No loan-card class, no "Mortgage" text in the Assets tab.
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Mortgage')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- --run src/accounts
```

Expected: FAIL — Mortgage is still rendered.

- [ ] **Step 3: Remove the loan render block + adjust counts**

In `web/src/accounts/AccountsView.tsx`:

1. Delete the JSX block that renders the loans section (search for `<LoanCard` and remove the surrounding `<section>` along with its heading).
2. Remove `<LoanCard>` import (if it becomes unused).
3. Adjust the empty-state computation: search for `data.connections.length + data.assets.length + data.loans.length` (around line 253) and replace with `data.connections.length + data.assets.length`.
4. Optionally drop the `/loans` fetch from the parallel `Promise.all` and the `loans: l.loans` field — but for now keep them so the data shape doesn't churn; the field just isn't consumed by render.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web && npm test -- --run src/accounts
```

Expected: PASS — Mortgage no longer in the document.

- [ ] **Step 5: Run the whole web suite**

```bash
cd web && npm test -- --run
```

Expected: PASS — every prior test still green (no other view renders the loan cards from `AccountsView`).

- [ ] **Step 6: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx && \
  git commit -m "$(cat <<'EOF'
web: Assets tab no longer renders loan cards

Loans now have a single home: the Loans tab. Removes the
parallel rendering of LoanCard from AccountsView. The /loans
fetch stays in the parallel Promise.all for now — its data is
still used by AccountsView's empty-state count and by the
upcoming post-sync new-loan detector (next task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Web — post-sync banner + Loans nav dot

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` — diff `/loans` → write `unseenLoanIds`; render banner.
- Modify: `web/src/App.tsx` — read `unseenLoanIds`, attach `data-unseen` on Loans nav button.
- Modify: `web/src/loans/LoansView.tsx` — clear `unseenLoanIds` on mount.
- Modify: `web/src/accounts/AccountsView.test.tsx` — banner appearance test.
- Modify: `web/src/App.test.tsx` — nav dot test.
- Modify: `web/src/loans/LoansView.test.tsx` — mount-clear test.
- Modify: `web/src/styles.css` — banner + nav-dot CSS.

- [ ] **Step 1: Write the failing test — banner appears after a fresh-loan sync**

Append to `web/src/accounts/AccountsView.test.tsx`:

```ts
describe('AccountsView — new-loan banner', () => {
  beforeEach(() => {
    window.localStorage.removeItem('hon.knownLoanIds');
    window.localStorage.removeItem('hon.unseenLoanIds');
  });

  it('renders the banner when /loans returns ids absent from knownLoanIds', async () => {
    window.localStorage.setItem('hon.knownLoanIds', JSON.stringify([]));
    installFetchMock({
      'GET /api/companies':   () => ({ companies: [{
        id: 'beinleumi', name: 'Beinleumi', loginFields: [], type: 'bank',
      }] }),
      'GET /api/connections': () => ({ connections: [{
        id: 'C1', companyId: 'beinleumi', displayName: 'Beinleumi',
        createdAt: '2025-01-01', lastScrapeAt: null, lastStatus: null,
        hasCredentials: true,
      }] }),
      'GET /api/accounts':    () => ({ accounts: [] }),
      'GET /api/assets':      () => ({ assets: [] }),
      'GET /api/loans':       () => ({
        loans: [{
          id: 'L-NEW', name: 'Mortgage', principal: 100_000,
          startDate: '2024-01-01', termMonths: 120,
          isPrime: false, isCpiLinked: false, rateValue: 0.04,
          cpiStart: null, currency: 'ILS', excluded: false, notes: null,
          connectionId: 'C1', externalId: '12345678', nameOverridden: false,
          createdAt: '2025-01-01', updatedAt: '2025-01-01',
        }],
        rates: { prime: null, cpiNow: null },
      }),
      'GET /api/brokerage': () => ({ holdings: [] }),
    });
    render(<AccountsView />);
    expect(await screen.findByTestId('new-loan-banner')).toBeInTheDocument();
    expect(within(screen.getByTestId('new-loan-banner'))
      .getByText(/Beinleumi/)).toBeInTheDocument();
    // localStorage queue was populated.
    const unseen = JSON.parse(window.localStorage.getItem('hon.unseenLoanIds') ?? '[]');
    expect(unseen).toContain('L-NEW');
  });

  it('dismissing the banner moves the ids from unseen → known', async () => {
    window.localStorage.setItem('hon.knownLoanIds', JSON.stringify([]));
    installFetchMock({
      'GET /api/companies':   () => ({ companies: [{
        id: 'beinleumi', name: 'Beinleumi', loginFields: [], type: 'bank',
      }] }),
      'GET /api/connections': () => ({ connections: [{
        id: 'C1', companyId: 'beinleumi', displayName: 'Beinleumi',
        createdAt: '2025-01-01', lastScrapeAt: null, lastStatus: null,
        hasCredentials: true,
      }] }),
      'GET /api/accounts': () => ({ accounts: [] }),
      'GET /api/assets':   () => ({ assets: [] }),
      'GET /api/loans':    () => ({
        loans: [{
          id: 'L-NEW', name: 'M', principal: 1, startDate: '2024-01-01',
          termMonths: 120, isPrime: false, isCpiLinked: false, rateValue: 0,
          cpiStart: null, currency: 'ILS', excluded: false, notes: null,
          connectionId: 'C1', externalId: 'x', nameOverridden: false,
          createdAt: '2025-01-01', updatedAt: '2025-01-01',
        }],
        rates: { prime: null, cpiNow: null },
      }),
      'GET /api/brokerage': () => ({ holdings: [] }),
    });
    const user = userEvent.setup();
    render(<AccountsView />);
    const banner = await screen.findByTestId('new-loan-banner');
    await user.click(within(banner).getByRole('button', { name: /dismiss/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('new-loan-banner')).not.toBeInTheDocument(),
    );
    const known = JSON.parse(window.localStorage.getItem('hon.knownLoanIds') ?? '[]');
    expect(known).toContain('L-NEW');
    const unseen = JSON.parse(window.localStorage.getItem('hon.unseenLoanIds') ?? '[]');
    expect(unseen).not.toContain('L-NEW');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- --run src/accounts
```

Expected: FAIL — `new-loan-banner` test-id not in the DOM.

- [ ] **Step 3: Implement detection + banner in `AccountsView`**

Near the top of `AccountsView.tsx`, add helpers:

```ts
const STORE_KNOWN = 'hon.knownLoanIds';
const STORE_UNSEEN = 'hon.unseenLoanIds';
const readIds = (key: string): string[] => {
  try { return JSON.parse(window.localStorage.getItem(key) ?? '[]'); }
  catch { return []; }
};
const writeIds = (key: string, ids: string[]): void => {
  window.localStorage.setItem(key, JSON.stringify(Array.from(new Set(ids))));
  // Same-tab listeners (the nav dot in App.tsx) need this event since the
  // built-in `storage` event only fires across tabs.
  window.dispatchEvent(new Event('hon.loan-ids-changed'));
};
```

In the component, after the `/loans` fetch resolves, diff and write:

```ts
// After data is loaded (whether on initial mount or after a sync refresh):
useEffect(() => {
  if (!data) return;
  const currentIds = data.loans.map((l) => l.id);
  const known = readIds(STORE_KNOWN);
  const fresh = currentIds.filter((id) => !known.includes(id));
  if (fresh.length === 0) return;
  const unseen = readIds(STORE_UNSEEN);
  writeIds(STORE_UNSEEN, [...unseen, ...fresh]);
}, [data]);
```

Render the banner above the connections list:

```tsx
{(() => {
  const unseen = readIds(STORE_UNSEEN);
  if (unseen.length === 0) return null;
  const ids = new Set(unseen);
  const newLoans = (data?.loans ?? []).filter((l) => ids.has(l.id));
  // Connection display name lookup.
  const connNameById = new Map(
    (data?.connections ?? []).map((c) => [c.id, c.displayName]),
  );
  const bankNames = Array.from(new Set(
    newLoans.map((l) => connNameById.get(l.connectionId) ?? 'a connection'),
  ));
  const dismiss = () => {
    const known = readIds(STORE_KNOWN);
    writeIds(STORE_KNOWN, [...known, ...unseen]);
    writeIds(STORE_UNSEEN, []);
  };
  return (
    <div className="new-loan-banner" data-testid="new-loan-banner">
      <span className="new-loan-banner-emoji">✨</span>
      <span>
        Found {newLoans.length} new loan{newLoans.length === 1 ? '' : 's'}
        {' from '}{bankNames.join(', ')}
        {' — '}
        <button
          type="button"
          className="new-loan-banner-link"
          onClick={dismiss}
        >View in Loans</button>
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="new-loan-banner-dismiss"
        aria-label="Dismiss"
        onClick={dismiss}
      >✕</button>
    </div>
  );
})()}
```

(The render is intentionally a self-invoking arrow so it stays inline with the other JSX without adding a separate top-level state hook for the banner — `unseenLoanIds` is read directly from storage; clicking dismiss mutates storage and triggers a re-render via the event below.)

To re-render when storage changes, add a tiny tick state:

```ts
const [storageTick, setStorageTick] = useState(0);
useEffect(() => {
  const h = () => setStorageTick((t) => t + 1);
  window.addEventListener('hon.loan-ids-changed', h);
  window.addEventListener('storage', h);
  return () => {
    window.removeEventListener('hon.loan-ids-changed', h);
    window.removeEventListener('storage', h);
  };
}, []);
// `storageTick` is unused as a value but its change forces a re-render
// when the banner's dismiss button moves ids around in localStorage.
void storageTick;
```

- [ ] **Step 4: Run test to verify the banner appears + dismiss works**

```bash
cd web && npm test -- --run src/accounts
```

Expected: PASS.

- [ ] **Step 5: Write the failing nav-dot test**

Append to `web/src/App.test.tsx`:

```ts
describe('App nav — Loans dot', () => {
  beforeEach(() => {
    window.localStorage.removeItem('hon.knownLoanIds');
    window.localStorage.removeItem('hon.unseenLoanIds');
  });

  it('attaches data-unseen on the Loans nav button when unseenLoanIds is non-empty', async () => {
    withToken();
    installFetchMock(EMPTY);
    window.localStorage.setItem('hon.unseenLoanIds', JSON.stringify(['L1']));
    render(<App />);
    const btn = await screen.findByRole('tab', { name: /loans/i });
    expect(btn).toHaveAttribute('data-unseen', 'true');
  });

  it('clears the dot once the user opens the Loans tab', async () => {
    withToken();
    installFetchMock(EMPTY);
    window.localStorage.setItem('hon.unseenLoanIds', JSON.stringify(['L1']));
    const user = userEvent.setup();
    render(<App />);
    const btn = await screen.findByRole('tab', { name: /loans/i });
    await user.click(btn);
    // LoansView mount clears unseen → next read returns [] → re-render
    // drops the attribute.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /loans/i }))
        .not.toHaveAttribute('data-unseen');
    });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
cd web && npm test -- --run src/App
```

Expected: FAIL — no `data-unseen` attribute set.

- [ ] **Step 7: Wire the dot + clear in `App.tsx`**

In `web/src/App.tsx`, near the top of the `App` component, add:

```ts
const [unseenCount, setUnseenCount] = useState<number>(0);
useEffect(() => {
  const read = () => {
    try {
      const v = JSON.parse(window.localStorage.getItem('hon.unseenLoanIds') ?? '[]');
      setUnseenCount(Array.isArray(v) ? v.length : 0);
    } catch { setUnseenCount(0); }
  };
  read();
  window.addEventListener('hon.loan-ids-changed', read);
  window.addEventListener('storage', read);
  return () => {
    window.removeEventListener('hon.loan-ids-changed', read);
    window.removeEventListener('storage', read);
  };
}, []);
```

In the `TABS.map((t) => (` render, change the button to include `data-unseen` when the tab is `loans` and unseenCount > 0:

```tsx
<button
  key={t.id}
  type="button"
  role="tab"
  aria-selected={tab === t.id}
  className={`nav-btn${tab === t.id ? ' active' : ''}`}
  data-unseen={t.id === 'loans' && unseenCount > 0 ? 'true' : undefined}
  onClick={() => setTab(t.id)}
>
  {/* …existing icon + label… */}
</button>
```

In `web/src/loans/LoansView.tsx`, add a clear-on-mount effect at the top of the component:

```ts
useEffect(() => {
  window.localStorage.setItem('hon.unseenLoanIds', JSON.stringify([]));
  window.dispatchEvent(new Event('hon.loan-ids-changed'));
}, []);
```

- [ ] **Step 8: Run tests to confirm both pass**

```bash
cd web && npm test -- --run src/App src/loans src/accounts
```

Expected: PASS.

- [ ] **Step 9: Add CSS for banner + dot**

Append to `web/src/styles.css`:

```css
/* New-loan banner — sits above the connections list on the Assets tab. */
.new-loan-banner {
  display: flex; align-items: center; gap: 10px;
  margin: 10px 0 14px; padding: 11px 14px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--hairline));
  border-radius: 12px;
  animation: fade-up .3s cubic-bezier(.2,.8,.2,1) both;
}
.new-loan-banner-emoji { font-size: 18px; }
.new-loan-banner-link {
  background: transparent; border: 0; padding: 0;
  color: var(--accent); font-weight: 700; cursor: pointer;
  text-decoration: underline;
}
.new-loan-banner-dismiss {
  background: transparent; border: 0; padding: 4px 8px; cursor: pointer;
  color: var(--muted); font-size: 13px; border-radius: 8px;
}
.new-loan-banner-dismiss:hover { background: var(--card-hi); color: var(--text); }

/* Loans nav-button unseen dot — small amber pulse in the top-right. */
.app-nav .nav-btn[data-unseen]::after {
  content: ''; position: absolute; top: 6px; right: 6px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 rgba(245,159,36,0.6);
  animation: hon-unseen-pulse 1.6s ease-out infinite;
}
@keyframes hon-unseen-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(245,159,36,0.6); }
  70%  { box-shadow: 0 0 0 8px rgba(245,159,36,0); }
  100% { box-shadow: 0 0 0 0 rgba(245,159,36,0); }
}
```

- [ ] **Step 10: Run the whole web suite + typecheck**

```bash
cd web && npm test -- --run && npm run typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx \
          web/src/loans/LoansView.tsx web/src/loans/LoansView.test.tsx \
          web/src/App.tsx web/src/App.test.tsx web/src/styles.css && \
  git commit -m "$(cat <<'EOF'
web: post-sync new-loan banner + Loans nav dot

Two localStorage keys back the detector — hon.knownLoanIds (the
acknowledged set) and hon.unseenLoanIds (the queue). After every
/loans load, AccountsView diffs current ids against known and
appends fresh ones to unseen. A non-empty unseen renders an inline
banner at the top of the Assets tab ("Found N new loans from
<bank> — View in Loans · ✕") and surfaces an amber pulse dot on
the Loans nav button via data-unseen. Clicking either banner CTA
moves unseen → known and clears the dot. LoansView mount clears
unseen too, so navigating directly also drops the indicator.

Same-tab listeners use a custom 'hon.loan-ids-changed' event since
the browser's built-in `storage` only fires across tabs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Web — Activity sidebar gains a Loans section

**Files:**
- Modify: `web/src/activity/ActivityView.tsx` — add Loans section to the move sidebar, with a Radix-dialog loan picker.
- Modify: `web/src/activity/ActivityView.test.tsx` — link + unlink tests.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/activity/ActivityView.test.tsx`:

```ts
describe('Activity sidebar — Loans section', () => {
  const LOANS = {
    loans: [{
      id: 'L1', name: 'Mortgage', principal: 100_000, startDate: '2024-01-01',
      termMonths: 120, isPrime: false, isCpiLinked: false, rateValue: 0.04,
      cpiStart: null, currency: 'ILS', excluded: false, notes: null,
      connectionId: 'C1', externalId: '12345678', nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2025-01-01',
      payments: [],
    }],
    rates: { prime: 6, cpiNow: 1 },
  };

  it('renders a "Link to a loan" CTA in the sidebar', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL_REFUND, 'GET /api/loans': () => LOANS });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    expect(within(sidebar).getByRole('button', { name: /link to a loan/i }))
      .toBeInTheDocument();
  });

  it('picking a loan PATCHes /transactions/:id/loan with that loanId', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ ok: true, loanId: 'L1' }));
    installFetchMock({
      ...FULL_REFUND,
      'GET /api/loans': () => LOANS,
      'PATCH /api/transactions/t-1/loan': patch,
    });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    await user.click(within(sidebar).getByRole('button', { name: /link to a loan/i }));
    const dialog = await screen.findByRole('dialog', { name: /pick a loan/i });
    await user.click(within(dialog).getByRole('button', { name: /mortgage/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect((patch.mock.calls[0]?.[0] as Record<string, unknown>).loanId).toBe('L1');
  });

  it('an already-linked transaction shows the link + an Unlink button', async () => {
    const linked = {
      transactions: REFUND_TXNS.transactions.map((t) =>
        t.id === 't-1' ? { ...t, loanId: 'L1' } : t,
      ),
    };
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ ok: true, loanId: null }));
    installFetchMock({
      ...FULL_REFUND,
      'GET /api/transactions': () => linked,
      'GET /api/loans': () => LOANS,
      'PATCH /api/transactions/t-1/loan': patch,
    });
    renderView();
    await user.click(await screen.findByText('Aroma Coffee'));
    const sidebar = screen.getByRole('dialog', { name: /move to category/i });
    expect(within(sidebar).getByText(/linked to mortgage/i)).toBeInTheDocument();
    await user.click(within(sidebar).getByRole('button', { name: /unlink/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect((patch.mock.calls[0]?.[0] as Record<string, unknown>).loanId).toBe(null);
  });
});
```

This requires `Transaction` to carry an optional `loanId`. If `web/src/activity/types.ts`'s `Transaction` interface doesn't already include it, add:

```ts
loanId?: string | null;
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd web && npm test -- --run src/activity
```

Expected: FAIL — "Link to a loan" not in document.

- [ ] **Step 3: Add Loans section + LoanPicker in ActivityView**

In `web/src/activity/ActivityView.tsx`, inside `CategoryPickerSidebar`, after the existing `RefundSection` block, insert:

```tsx
<LoansSection
  transaction={transaction}
  loans={loans}
  onChange={refresh}
/>
```

`loans` should be a new prop pulled from a parallel fetch — load `/loans` alongside the existing `/transactions`, `/accounts`, `/categories` in the `useEffect`. Add a `loans: Loan[]` to the state shape and pass it through.

Then add the section component:

```tsx
function LoansSection({
  transaction, loans, onChange,
}: {
  transaction: Transaction;
  loans: Loan[];
  onChange: () => void | Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const linkedLoan = transaction.loanId
    ? loans.find((l) => l.id === transaction.loanId) ?? null
    : null;
  const unlink = async () => {
    setBusy(true);
    try {
      await api(`/transactions/${encodeURIComponent(transaction.id)}/loan`,
        'PATCH', { loanId: null });
      await onChange();
    } finally { setBusy(false); }
  };
  const link = async (loanId: string) => {
    setBusy(true);
    try {
      await api(`/transactions/${encodeURIComponent(transaction.id)}/loan`,
        'PATCH', { loanId });
      setPicking(false);
      await onChange();
    } finally { setBusy(false); }
  };

  return (
    <div className="txn-sidebar-section">
      <div className="label">Loans</div>
      {linkedLoan ? (
        <div className="rf-linked">
          <div className="rf-linked-name">Linked to {linkedLoan.name}</div>
          <button
            type="button" className="rf-unlink" aria-label="Unlink loan"
            disabled={busy} onClick={unlink}
          >Unlink</button>
        </div>
      ) : (
        <button
          type="button" className="txn-sidebar-action"
          onClick={() => setPicking(true)}
        >+ Link to a loan</button>
      )}
      <Dialog.Root open={picking} onOpenChange={(o) => { if (!o) setPicking(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="rx-overlay" />
          <Dialog.Content className="rx-dialog rx-dialog-sm" aria-label="Pick a loan">
            <Dialog.Title>Pick a loan</Dialog.Title>
            <Dialog.Description className="rx-dialog-desc">
              The transaction will be attached to the selected loan and
              appear in its payment history. Auto-matched links can be
              overridden here too.
            </Dialog.Description>
            <ul className="loan-pick-list">
              {loans.map((l) => (
                <li key={l.id}>
                  <button
                    type="button" className="loan-pick-row"
                    disabled={busy}
                    onClick={() => void link(l.id)}
                  >
                    <span className="loan-pick-name">{l.name}</span>
                    <span className="loan-pick-meta">
                      {l.connectionId ? 'Bank loan' : 'Manual'}
                    </span>
                  </button>
                </li>
              ))}
              {loans.length === 0 && (
                <li className="loan-pick-empty">
                  No loans yet. Add one from the Loans tab first.
                </li>
              )}
            </ul>
            <div className="form-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn-ghost">Cancel</button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
```

Add CSS:

```css
.loan-pick-list { list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow-y: auto; }
.loan-pick-row { width: 100%; display: flex; justify-content: space-between;
  align-items: baseline; padding: 10px 12px; border-radius: 10px;
  background: var(--card-hi); border: 1px solid var(--hairline);
  color: var(--text); text-align: left; cursor: pointer;
  transition: border-color .15s ease; }
.loan-pick-row:hover { border-color: var(--accent); }
.loan-pick-row:disabled { opacity: .6; cursor: not-allowed; }
.loan-pick-name { font-size: 13px; font-weight: 600; }
.loan-pick-meta { font-size: 11px; color: var(--muted); }
.loan-pick-empty { font-size: 12px; color: var(--muted); padding: 12px 8px;
  text-align: center; }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npm test -- --run src/activity
```

Expected: PASS.

- [ ] **Step 5: Run the whole web suite + typecheck**

```bash
cd web && npm test -- --run && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add web/src/activity/ActivityView.tsx web/src/activity/ActivityView.test.tsx \
          web/src/activity/types.ts web/src/styles.css && \
  git commit -m "$(cat <<'EOF'
web: Activity sidebar — Loans section for manual link/unlink

The transaction-move sidebar gains a third action section after
Category and Reimbursement (and before Splitwise). When a
transaction has no loan link, "+ Link to a loan" opens a Radix
Dialog picker showing every loan; tapping one PATCHes
/transactions/:id/loan and refetches. When the transaction is
already linked, the section shows "Linked to <loan-name>" with an
Unlink pill that PATCHes loanId: null.

This is the manual override the loanMatcher's heuristic relies on
for misses + wrong matches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Final verification + HANDOFF refresh

**Files:**
- Modify: `HANDOFF.md` — mention the new loan-detection feature in the deferred-items list (and note it as completed).

- [ ] **Step 1: Run full engine + web suites**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  cd sidecar && npm test && cd .. && \
  cd web && npm test -- --run && npm run typecheck
```

Expected: PASS on both. Note the totals — backend ~53, web ~292 + however many tests Tasks 7-10 added (rough total ~300).

- [ ] **Step 2: Edit `HANDOFF.md`**

Move "loan-detection" out of any "what's left" list and into the per-tab notes. In the Loans tab note, append:

```markdown
   - **Bank-scraped loans auto-link payment transactions** (loanMatcher).
     Loans card shows a "Last payment" badge + collapsible history; manual
     link/unlink lives in the Activity move sidebar.
   - **New-loan banner** on Assets + Loans nav-dot once a sync detects a
     bank loan that wasn't there before.
```

In the Assets tab note, append:

```markdown
   - Loans no longer rendered here — they live exclusively in the Loans tab.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon && \
  git add HANDOFF.md && \
  git commit -m "$(cat <<'EOF'
docs: HANDOFF — loan auto-link + new-loan banner are now live

Moves the loan-detection bullet out of the deferred polish list
and into the per-tab notes for Loans (last-payment badge,
payment history, manual link/unlink) and Assets (loans removed
from this surface; live only in the Loans tab).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push everything**

```bash
git push origin main
```

---

## Self-review

After writing the complete plan, looked at the spec with fresh eyes:

**1. Spec coverage** — every spec section maps to a task:
- §Architecture 1 (column + matcher) → Tasks 1, 2, 3, 4
- §Architecture 2 (/loans payments) → Task 5
- §Architecture 3 (PATCH txn loan) → Task 5
- §Architecture 4 (Assets drops loans) → Task 8
- §Architecture 5 (LoansView card) → Task 7
- §Architecture 6 (Activity sidebar Loans section) → Task 10
- §Architecture 7 (banner + nav-dot) → Task 9
- §Migration notes (v33 ALTER) → Task 1
- §Testing (engine + web buckets) → embedded in every task

**2. Placeholder scan** — none. Every code step has full code. No TBDs.

**3. Type consistency** — `Loan.payments?: LoanPayment[]` defined in Task 6 is used in Tasks 7, 9, 10. The matcher's `MatchableTxn` shape stays internal to `loanMatcher.ts`. `transaction.loanId?: string | null` added in Task 10 step 1 is consumed in the same task. Endpoint paths are consistent: `PATCH /transactions/:id/loan` in Tasks 5 + 10. localStorage keys (`hon.knownLoanIds`, `hon.unseenLoanIds`) and the custom event (`hon.loan-ids-changed`) are consistent across Task 9.

No issues found.
