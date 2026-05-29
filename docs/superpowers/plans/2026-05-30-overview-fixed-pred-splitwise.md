# Overview projection — predicted-fixed + Splitwise owed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Overview's "Expected fixed + essentials" line show the *predicted* fixed total for this cycle (matching the Fixed bills tab) instead of posted-so-far, and add a "+ Owed to you (Splitwise)" line to the end-of-cycle bank projection.

**Architecture:** Lift the recurring-bill detector out of `RecurringView.tsx` into the shared `recurring/helpers.ts`, add a pure `expectedFixedThisCycle()` predictor there, then have `OverviewView` fetch the same five endpoints `RecurringView` uses, run the detector, and feed the predicted number into both the headline net and the bank projection. The Splitwise owed sum comes from the already-cached `useSplitwise()` hook.

**Tech Stack:** React 19 + TS strict, Vitest + Testing Library, `installFetchMock` (keyed `"METHOD /api/path"`, query string ignored).

**Spec:** `docs/superpowers/specs/2026-05-30-overview-fixed-pred-splitwise-design.md`

**Baseline note:** This branch already contains the card-bill double-count fix (`OverviewView` passes `?cardProvider=` and uses `useSettings()`). Build on that — do NOT remove it.

---

## File Structure

- `web/src/recurring/helpers.ts` — gains the lifted types (`FreqOrIgnore`, `MerchantRow`, `RecurringData`), `detectMerchants`, `cyclesBetween`, plus new `cycleStatus()` and `expectedFixedThisCycle()`. Single home for recurring math.
- `web/src/recurring/RecurringView.tsx` — drops the local copies, imports them from `helpers.ts`; `statusFor()` delegates the due/off-cycle decision to the shared `cycleStatus()`. Behaviour identical.
- `web/src/overview/OverviewView.tsx` — fetches the five recurring endpoints, computes `predictedFixed`, derives `committedDisplay`, threads it through `BalanceCard` + `BankProjection`; adds the Splitwise owed line.
- Tests: `web/src/recurring/helpers.test.ts`, `web/src/recurring/RecurringView.test.tsx` (regression), `web/src/overview/OverviewView.test.tsx`.

---

## Task 1: Lift recurring detection + add `expectedFixedThisCycle`

**Files:**
- Modify: `web/src/recurring/helpers.ts`
- Modify: `web/src/recurring/RecurringView.tsx` (remove local defs, import from helpers)
- Test: `web/src/recurring/helpers.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `web/src/recurring/helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { expectedFixedThisCycle, type MerchantRow } from './helpers';
import { currentCycleKey, cycleKey } from '../cycle';

// Build a MerchantRow with only the fields expectedFixedThisCycle reads.
function row(over: Partial<MerchantRow>): MerchantRow {
  return {
    key: 'k', desc: 'd', category: 'Housing', count: 1,
    freq: 'monthly', cycles: new Set<string>(), lastTxnDate: null,
    lastChargeAbs: 0, monthly: 0, split: 1, monthlyShare: 0,
    ...over,
  };
}

// A "YYYY-MM" that is `n` whole months before the current cycle (monthStartDay=1).
function cyclesAgo(n: number): string {
  const [y, m] = currentCycleKey(1).split('-').map(Number);
  const d = new Date(y, (m - 1) - n, 1);
  return cycleKey(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`, 1);
}

describe('expectedFixedThisCycle', () => {
  const cur = currentCycleKey(1);

  it('counts a monthly bill at its full charge', () => {
    const rows = [row({ freq: 'monthly', lastChargeAbs: 500, lastTxnDate: `${cyclesAgo(1)}-15` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(500);
  });

  it('counts a bill already billed this cycle (full charge)', () => {
    const rows = [row({ freq: 'monthly', lastChargeAbs: 500, cycles: new Set([cur]), lastTxnDate: `${cur}-03` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(500);
  });

  it('excludes a bimonthly bill that billed last cycle (off-cycle)', () => {
    const rows = [row({ freq: 'bimonthly', lastChargeAbs: 600, lastTxnDate: `${cyclesAgo(1)}-10` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(0);
  });

  it('counts a bimonthly bill due this cycle at full charge', () => {
    const rows = [row({ freq: 'bimonthly', lastChargeAbs: 600, lastTxnDate: `${cyclesAgo(2)}-10` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(600);
  });

  it('excludes a yearly bill that is between charges', () => {
    const rows = [row({ freq: 'yearly', lastChargeAbs: 1200, lastTxnDate: `${cyclesAgo(3)}-10` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(0);
  });

  it('counts a yearly bill due this cycle (gap >= 12)', () => {
    const rows = [row({ freq: 'yearly', lastChargeAbs: 1200, lastTxnDate: `${cyclesAgo(12)}-10` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(1200);
  });

  it('divides each row by its split divisor', () => {
    const rows = [row({ freq: 'monthly', lastChargeAbs: 600, split: 2, lastTxnDate: `${cyclesAgo(1)}-15` })];
    expect(expectedFixedThisCycle(rows, 1)).toBe(300);
  });

  it('sums multiple rows', () => {
    const rows = [
      row({ key: 'a', freq: 'monthly', lastChargeAbs: 500, lastTxnDate: `${cyclesAgo(1)}-15` }),
      row({ key: 'b', freq: 'bimonthly', lastChargeAbs: 600, lastTxnDate: `${cyclesAgo(1)}-10` }), // off-cycle → 0
      row({ key: 'c', freq: 'monthly', lastChargeAbs: 200, split: 2, lastTxnDate: `${cyclesAgo(1)}-15` }), // 100
    ];
    expect(expectedFixedThisCycle(rows, 1)).toBe(600);
  });

  it('returns 0 for an empty list', () => {
    expect(expectedFixedThisCycle([], 1)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/recurring/helpers.test.ts`
Expected: FAIL — `expectedFixedThisCycle` / `MerchantRow` are not exported from `./helpers`.

- [ ] **Step 3: Move the detector into `helpers.ts` and add the predictor**

In `web/src/recurring/helpers.ts`, add these imports at the top (keep existing imports):

```ts
import { cycleKey, currentCycleKey } from '../cycle';
import type { Category } from '../settings/CategoriesPanel';
import type { Transaction } from '../activity/types';
```

Then append (verbatim moves of the current `RecurringView.tsx` definitions, made `export`, plus two new exports):

```ts
export type FreqOrIgnore = Frequency | 'ignore';

export interface MerchantRow {
  key: string;
  desc: string;
  category: string;
  count: number;
  freq: Frequency;
  cycles: Set<string>;
  lastTxnDate: string | null;
  lastChargeAbs: number;
  monthly: number;
  /** Split divisor — share among N people for the category. */
  split: number;
  /** This user's share of the monthly equivalent. */
  monthlyShare: number;
}

export interface RecurringData {
  transactions: Transaction[];
  categories: Category[];
  frequencies: Record<string, FreqOrIgnore>;
  splits: Record<string, number>;
  cancelled: Record<string, boolean>;
}

export function detectMerchants(
  data: RecurringData,
): { rows: MerchantRow[]; categoryGroups: Record<string, Category['catGroup']> } {
  const catGroupByName: Record<string, Category['catGroup']> = {};
  for (const c of data.categories) catGroupByName[c.name] = c.catGroup;
  const merch = new Map<string, {
    key: string; desc: string; category: string; count: number;
    cycles: Set<string>; lastTxnDate: string | null; lastTs: number;
    lastChargeAbs: number;
  }>();
  for (const t of data.transactions) {
    if (t.currency !== 'ILS') continue;
    if (t.refundForId) continue;
    if (!t.category) continue;
    if (catGroupByName[t.category] !== 'fixed') continue;
    if (t.amount >= 0) continue;
    const key = merchantKey(t.description);
    let r = merch.get(key);
    if (!r) {
      r = {
        key, desc: merchantName(t.description), category: t.category,
        count: 0, cycles: new Set(), lastTxnDate: null, lastTs: 0, lastChargeAbs: 0,
      };
      merch.set(key, r);
    }
    r.cycles.add(cycleKey(t.date, 1));
    r.count += 1;
    const ts = new Date(t.date).getTime();
    if (ts >= r.lastTs) {
      r.lastTs = ts;
      r.lastTxnDate = t.date;
      r.lastChargeAbs = -t.amount;
      r.desc = merchantName(t.description);
      r.category = t.category;
    }
  }
  const rows: MerchantRow[] = [];
  for (const r of merch.values()) {
    const userFreq = data.frequencies[r.key];
    if (userFreq === 'ignore') continue;
    if (data.cancelled[r.key]) continue;
    if (!userFreq && r.cycles.size < 2) continue;
    const freq: Frequency =
      userFreq === 'monthly' || userFreq === 'bimonthly' || userFreq === 'yearly'
        ? userFreq : 'monthly';
    const split = data.splits[r.category] || 1;
    const fullMonthly = monthlyEquivalent(r.lastChargeAbs, freq);
    rows.push({
      key: r.key, desc: r.desc, category: r.category, count: r.count, freq,
      cycles: r.cycles, lastTxnDate: r.lastTxnDate, lastChargeAbs: r.lastChargeAbs,
      monthly: fullMonthly, split, monthlyShare: fullMonthly / split,
    });
  }
  return { rows, categoryGroups: catGroupByName };
}

export function cyclesBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * Whether a recurring row is expected to bill in the current cycle. Shared by
 * statusFor() (badge) and expectedFixedThisCycle() (headline) so the per-row
 * "Off-cycle" badges and the Overview headline can never disagree.
 *  - 'billed'    — a charge already landed in the current cycle.
 *  - 'off-cycle' — bimonthly billed last cycle, or yearly between charges.
 *  - 'due'       — expected this cycle, not yet seen.
 */
export function cycleStatus(
  row: MerchantRow, monthStartDay: number,
): 'billed' | 'off-cycle' | 'due' {
  const cur = currentCycleKey(monthStartDay);
  if (row.cycles.has(cur)) return 'billed';
  const lastCycle = row.lastTxnDate ? cycleKey(row.lastTxnDate, monthStartDay) : null;
  const gap = lastCycle ? cyclesBetween(lastCycle, cur) : 999;
  if (row.freq === 'bimonthly' && gap === 1) return 'off-cycle';
  if (row.freq === 'yearly' && gap >= 1 && gap < 12) return 'off-cycle';
  return 'due';
}

/**
 * Sum of the full per-row charges due this cycle. A bill counts at its full
 * `lastChargeAbs / split` the cycle it is due (billed or expected) and ₪0 when
 * off-cycle — mirroring cycleStatus(). This is the same "due this cycle" total
 * the Fixed bills tab shows, NOT the smoothed monthly-equivalent.
 */
export function expectedFixedThisCycle(rows: MerchantRow[], monthStartDay: number): number {
  let total = 0;
  for (const row of rows) {
    if (cycleStatus(row, monthStartDay) !== 'off-cycle') {
      total += row.lastChargeAbs / row.split;
    }
  }
  return total;
}
```

Then in `web/src/recurring/RecurringView.tsx`:
- Delete the local `type FreqOrIgnore`, `interface MerchantRow`, `interface RecurringData`, `function detectMerchants`, `function cyclesBetween`.
- Extend the existing helpers import to:
  ```ts
  import {
    merchantKey, merchantName, monthlyEquivalent, type Frequency,
    detectMerchants, cyclesBetween, cycleStatus,
    type FreqOrIgnore, type MerchantRow, type RecurringData,
  } from './helpers';
  ```
  (Remove now-unused names if the linter flags them — e.g. `merchantKey`/`merchantName`/`monthlyEquivalent` are now only used inside helpers; keep only what RecurringView still references. `cyclesBetween` is only used by `cycleStatus`, so RecurringView may not need it directly — import only what it uses.)
- Replace the body of `statusFor` so it delegates the decision:
  ```ts
  interface StatusBadge { cls: string; label: string; hint: string }
  function statusFor(row: MerchantRow, monthStartDay: number): StatusBadge {
    const status = cycleStatus(row, monthStartDay);
    if (status === 'billed') {
      return { cls: 'good', label: '✓ Billed', hint: 'Already billed this cycle.' };
    }
    if (status === 'off-cycle') {
      if (row.freq === 'bimonthly') {
        return { cls: 'muted', label: 'Off-cycle',
          hint: 'Bimonthly — billed last cycle, not expected this one.' };
      }
      const cur = currentCycleKey(monthStartDay);
      const lastCycle = row.lastTxnDate ? cycleKey(row.lastTxnDate, monthStartDay) : null;
      const left = 12 - (lastCycle ? cyclesBetween(lastCycle, cur) : 0);
      return { cls: 'muted', label: 'Off-cycle',
        hint: `Yearly — next charge in ${left} cycle${left === 1 ? '' : 's'}.` };
    }
    return { cls: 'warn', label: 'Not yet billed',
      hint: 'Expected this cycle but no charge has arrived yet.' };
  }
  ```
  (Keep `cycleKey`, `currentCycleKey`, `cyclesBetween` imported where still referenced.)

- [ ] **Step 4: Run the helpers tests to verify they pass**

Run: `npx vitest run src/recurring/helpers.test.ts`
Expected: PASS (all new cases green).

- [ ] **Step 5: Run the recurring view regression + typecheck**

Run: `npx vitest run src/recurring/RecurringView.test.tsx && npm run typecheck`
Expected: PASS — RecurringView renders identically (it now consumes the lifted detector), no type errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/recurring/helpers.ts web/src/recurring/helpers.test.ts web/src/recurring/RecurringView.tsx
git commit -m "web: lift recurring detector to helpers + add expectedFixedThisCycle"
```

---

## Task 2: Overview headline uses predicted fixed

**Files:**
- Modify: `web/src/overview/OverviewView.tsx`
- Test: `web/src/overview/OverviewView.test.tsx`

- [ ] **Step 1: Write the failing test** — add to `web/src/overview/OverviewView.test.tsx`.

First extend the default `mocks()` with the five recurring endpoints (add inside the returned object, before `...overrides`):

```ts
    'GET /api/transactions': () => ({ transactions: [] }),
    'GET /api/categories': () => ({ categories: [] }),
    'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
    'GET /api/category-splits': () => ({ splits: {} }),
    'GET /api/subscriptions/cancelled': () => ({ cancelled: {} }),
```

Then add the test:

```ts
it('uses predicted fixed (not posted) for "Expected fixed + essentials"', async () => {
  // One detected monthly fixed bill of ₪3,000 seen in two prior cycles, plus
  // ₪2,100 essentialSpent. committedDisplay should be 3000 + 2100 = 5100,
  // regardless of the budget's posted fixedSpent (5400).
  const cur = new Date().toISOString().slice(0, 7); // YYYY-MM (monthStartDay=1)
  const [y, m] = cur.split('-').map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  const prev2 = `${m <= 2 ? y - 1 : y}-${String(((m - 3 + 12) % 12) + 1).padStart(2, '0')}`;
  installFetchMock(mocks({
    'GET /api/categories': () => ({
      categories: [{ name: 'Housing', catGroup: 'fixed' }],
    }),
    'GET /api/transactions': () => ({
      transactions: [
        { id: 't1', date: `${prev2}-10`, amount: -3000, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
        { id: 't2', date: `${prev}-10`, amount: -3000, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
      ],
    }),
  }));
  renderOverview();
  const card = await screen.findByTestId('balance-card');
  // headline net = income(12000) − committedDisplay(5100) − spent(1200) = 5700
  expect((card.querySelector('.balance-num') as HTMLElement).textContent).toMatch(/5,?700/);
  // the committed line shows 5,100 (predicted 3,000 + essential 2,100), not 7,500
  expect(within(card).getByText(/5,?100/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npx vitest run src/overview/OverviewView.test.tsx -t "uses predicted fixed"`
Expected: FAIL — headline still uses `variable.committed` (7500), net shows 3,300 not 5,700.

- [ ] **Step 3: Implement predicted-fixed in `OverviewView.tsx`**

Add imports:
```ts
import type { Transaction } from '../activity/types';
import type { Category } from '../settings/CategoriesPanel';
import {
  detectMerchants, expectedFixedThisCycle,
  type FreqOrIgnore, type RecurringData,
} from '../recurring/helpers';
```

Add state + fetch. Inside `OverviewView`, add another state object and fetch the five endpoints in the SAME effect (alongside the existing `Promise.all`). Replace the existing effect's `Promise.all` array and `.then` with:

```ts
  const [recurring, setRecurring] = useState<RecurringData | null>(null);

  useEffect(() => {
    Promise.all([
      api<Summary>('/summary'),
      api<BudgetResponse>(budgetPath),
      api<{ companies: Company[] }>('/companies').catch(() => ({ companies: [] })),
      api<{ accounts: Account[] }>('/accounts').catch(() => ({ accounts: [] })),
    ]).then(([s, b, c, a]) => {
      setSummary(s);
      setBudget(b);
      setCompanies(c.companies ?? []);
      setAccounts(a.accounts ?? []);
    }).catch(() => {
      setSummary({ byCurrency: [], accountCount: 0, connectionCount: 0, netWorthILS: 0 });
      setBudget(null);
    });

    // Recurring detection feeds the predicted-fixed headline. Independent of the
    // budget fetch — if any of these fail, predictedFixed falls back to null and
    // the headline reverts to the posted figure (variable.committed).
    Promise.all([
      api<{ transactions: Transaction[] }>('/transactions'),
      api<{ categories: Category[] }>('/categories'),
      api<{ frequencies: Record<string, FreqOrIgnore> }>('/merchant-frequencies'),
      api<{ splits: Record<string, number> }>('/category-splits'),
      api<{ cancelled: Record<string, boolean> }>('/subscriptions/cancelled')
        .catch(() => ({ cancelled: {} as Record<string, boolean> })),
    ]).then(([t, c, f, s, sub]) => {
      setRecurring({
        transactions: t.transactions, categories: c.categories,
        frequencies: f.frequencies ?? {}, splits: s.splits ?? {},
        cancelled: sub.cancelled ?? {},
      });
    }).catch(() => setRecurring(null));
  }, [budgetPath]);
```

After the `if (summary === null)` guard and `const v = budget?.variable;`, derive the display number:

```ts
  // Predicted fixed-this-cycle (same source the Fixed bills tab uses), summed
  // with posted essentials. Falls back to the posted committed total when the
  // recurring fetch failed or the engine returned no fixed history.
  const predictedFixed = recurring
    ? expectedFixedThisCycle(detectMerchants(recurring).rows, settings.monthStartDay)
    : null;
  const committedDisplay = (v && predictedFixed !== null)
    ? predictedFixed + (v.essentialSpent ?? 0)
    : (v?.committed ?? 0);
```

Pass `committedDisplay` into `BalanceCard`:
```tsx
        {v && (
          <BalanceCard
            variable={v}
            committedDisplay={committedDisplay}
            currency={budget!.currency}
            companies={companies}
            accounts={accounts}
          />
        )}
```

Update `BalanceCard` to accept and use it:
```tsx
function BalanceCard({
  variable, committedDisplay, currency, companies, accounts,
}: {
  variable: BudgetVariable;
  committedDisplay: number;
  currency: string;
  companies: Company[];
  accounts: Account[];
}) {
  const { income, spent } = variable;
  if (income <= 0 && committedDisplay <= 0 && spent <= 0) return null;
  const net = income - committedDisplay - spent;
```
…and in the committed line render `{money(committedDisplay, currency)}` instead of `money(committed, currency)`. Pass `committedDisplay` down to `BankProjection` too (replace its `variable.committed` usage — see Task 3 note):
```tsx
      <BankProjection
        variable={variable}
        committedDisplay={committedDisplay}
        currency={currency}
        companies={companies}
        accounts={accounts}
      />
```

In `BankProjection`, accept `committedDisplay` and use it for `fixedEss`:
```tsx
function BankProjection({
  variable, committedDisplay, currency, companies, accounts,
}: {
  variable: BudgetVariable;
  committedDisplay: number;
  currency: string;
  companies: Company[];
  accounts: Account[];
}) {
  // ...
  const fixedEss = committedDisplay; // predicted fixed + posted essentials
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/overview/OverviewView.test.tsx -t "uses predicted fixed"`
Expected: PASS — net shows 5,700; committed line shows 5,100.

- [ ] **Step 5: Add the fallback test, run full overview file**

Add:
```ts
it('falls back to posted committed when the recurring fetch fails', async () => {
  installFetchMock(mocks({
    'GET /api/transactions': () => new Response('boom', { status: 500 }),
  }));
  const card = (renderOverview(), await screen.findByTestId('balance-card'));
  // recurring failed → committedDisplay = variable.committed (7500);
  // net = 12000 − 7500 − 1200 = 3300
  expect((card.querySelector('.balance-num') as HTMLElement).textContent).toMatch(/3,?300/);
});
```

Run: `npx vitest run src/overview/OverviewView.test.tsx && npm run typecheck`
Expected: PASS (all overview tests green; existing projection tests still pass because their fixtures keep `committed === fixedSpent + essentialSpent` and supply empty recurring data → predictedFixed 0 → committedDisplay = essentialSpent… **NOTE:** verify the existing projection tests — if any asserts a number derived from `committed`, update its expectation to the predicted value or give it recurring fixtures. Adjust expectations to match the new predicted math, not the other way around).

- [ ] **Step 6: Commit**

```bash
git add web/src/overview/OverviewView.tsx web/src/overview/OverviewView.test.tsx
git commit -m "web: Overview headline uses predicted fixed-this-cycle, not posted"
```

---

## Task 3: Splitwise owed line in the bank projection

**Files:**
- Modify: `web/src/overview/OverviewView.tsx`
- Test: `web/src/overview/OverviewView.test.tsx`

- [ ] **Step 1: Write the failing test** — add to `OverviewView.test.tsx`. A connected-Splitwise mock with one ILS balance the user is owed:

```ts
it('adds an "Owed to you (Splitwise)" line to the projection and end balance', async () => {
  installFetchMock(mocks({
    'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1 } }),
    'POST /api/splitwise/refresh': () => ({
      friends: [{ name: 'Noga', balances: [{ amount: 800, currency: 'ILS' }] }],
      links: [],
    }),
  }));
  renderOverview();
  const card = await screen.findByTestId('bank-projection');
  // bankNow 16,000 + income 12,000 − committedDisplay − spent 1,200 − piggy 0 + owed 800
  expect(within(card).getByText(/Owed to you/i)).toBeInTheDocument();
  expect(within(card).getByText(/800/)).toBeInTheDocument();
});

it('omits the owed line when Splitwise has no ILS balance owed', async () => {
  installFetchMock(mocks({
    'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1 } }),
    'POST /api/splitwise/refresh': () => ({
      friends: [{ name: 'Noga', balances: [{ amount: 50, currency: 'USD' }] }],
      links: [],
    }),
  }));
  renderOverview();
  await screen.findByTestId('bank-projection');
  expect(screen.queryByText(/Owed to you \(Splitwise\)/i)).not.toBeInTheDocument();
});
```

> Verify the refresh endpoint method/path against `useSplitwise.ts` (it calls `api<{ friends; links }>('/splitwise/refresh', ...)`) and mirror the exact key in the mock. If `useSplitwise` posts to `/splitwise/refresh`, the mock key is `'POST /api/splitwise/refresh'`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/overview/OverviewView.test.tsx -t "Owed to you"`
Expected: FAIL — no owed line rendered, end balance excludes it.

- [ ] **Step 3: Implement the owed line in `BankProjection`**

Add import: `import { useSplitwise } from '../splitwise/useSplitwise';`

Inside `BankProjection`, after computing `change`/`endBalance`, compute owed and fold it in:
```tsx
  const sw = useSplitwise();
  const owed = sw.connected
    ? sw.friends
        .flatMap((f) => f.balances)
        .filter((b) => b.currency === currency && b.amount > 0)
        .reduce((s, b) => s + b.amount, 0)
    : 0;
  const change = expectedIncome - fixedEss - cycleVariable - cyclePiggy + owed;
  const endBalance = bankNow + change;
```
(Move the `change`/`endBalance` declarations below the `owed` calc; delete the earlier ones so they include `owed`.)

Render the owed detail between the income line and the set-asides line, only when `owed > 0`:
```tsx
        <Detail label="Income expected this cycle" amount={expectedIncome} tone="good" />
        {owed > 0 && (
          <Detail label="Owed to you (Splitwise)" amount={owed} tone="good" />
        )}
        <Detail label="Fixed + essentials this cycle" amount={fixedEss} tone="bad" />
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/overview/OverviewView.test.tsx -t "Owed to you"`
Expected: PASS — owed line renders, end balance includes +800; USD-only case omits it.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS — full web suite green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/overview/OverviewView.tsx web/src/overview/OverviewView.test.tsx
git commit -m "web: add Splitwise owed-to-you to Overview bank projection"
```

---

## Task 4: Visual verification (MANDATORY — PROJECT-RULES §2)

- [ ] **Step 1:** Ensure a worktree vite is running (e.g. `npx vite --port 5180 --strictPort` from this worktree's `web/`, proxying to the live engine on :4000) and a chrome-devtools CDP browser is up on :9222.
- [ ] **Step 2:** `new_page` → `http://localhost:5180/#token=<dev-token>`; `select_page` the :5180 tab (do NOT screenshot :5173 — that's the main checkout).
- [ ] **Step 3:** `take_snapshot` and confirm: "Expected fixed + essentials" shows the predicted figure (matches the Fixed bills tab's "Due this cycle"); if Splitwise is connected with ILS owed, the projection shows "Owed to you (Splitwise)" and the end balance includes it.
- [ ] **Step 4:** `take_screenshot` → `/tmp/overview-pred-splitwise.png`; `Read` it; confirm with your own eyes before claiming done.
- [ ] **Step 5:** Cross-check the headline against the Fixed bills tab "Due this cycle" number — they must match.

---

## Self-Review notes

- **Spec coverage:** Decision 1 (full predicted, off-cycle = 0) → Task 1 `expectedFixedThisCycle` + tests. Decision 2 (owed as its own line, hidden at 0/disconnected) → Task 3. Decision 3 (ILS-only) → Task 3 currency filter + USD test. Decision 4 (client-side, `/budget` unchanged) → Task 2 fetches client-side; engine untouched. Decision 5 (graceful degrade) → Task 2 fallback test.
- **Type consistency:** `MerchantRow`, `RecurringData`, `FreqOrIgnore`, `detectMerchants`, `cyclesBetween`, `cycleStatus`, `expectedFixedThisCycle` all defined in Task 1 and imported by name in Tasks 2–3. `committedDisplay: number` prop name is identical across `BalanceCard` and `BankProjection`.
- **Out of scope (do NOT touch):** engine `/budget` route, per-transaction Splitwise netting, predicted essentials, Subscriptions projection, cycle-aware piggies. (Also out of scope here: the Overview `/budget` cycle-range gap — separate follow-up.)
