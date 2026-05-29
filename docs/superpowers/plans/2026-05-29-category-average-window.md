# Category Average Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose the timeframe (3 / 6 / 12 / 24 or a custom number of months) over which the Insights per-category and overall "vs avg" comparisons are calculated, via a new Settings card.

**Architecture:** Add one `spendingAvgMonths` field to the localStorage-backed `Settings`. Extract the per-category averaging out of `MonthDetail` into a pure helper `categoryAverages()` that averages the trailing N completed cycles *before the displayed month*. A new `CategoryAveragesCard` writes the setting; `InsightsView` reads it and threads it into `MonthDetail`. The 12-month bar chart and the "vs last" chips are untouched.

**Tech Stack:** React 19 + TypeScript (strict), Vitest + Testing-Library, localStorage settings store. All work happens in the worktree `/Users/shaharsolomons/Documents/Code/Hon/.claude/worktrees/category-avg-window-2026-05-29`. Run all commands from its `web/` directory.

**Working directory for every command below:**
`/Users/shaharsolomons/Documents/Code/Hon/.claude/worktrees/category-avg-window-2026-05-29/web`

---

## File Structure

- **Modify** `web/src/settings/store.ts` — add `spendingAvgMonths: number` to `Settings` + `DEFAULT_SETTINGS`, with a load-time guard.
- **Modify** `web/src/settings/store.test.ts` — cover the new field + guard.
- **Create** `web/src/insights/categoryAverages.ts` — pure averaging helper.
- **Create** `web/src/insights/categoryAverages.test.ts` — unit tests for it.
- **Modify** `web/src/insights/InsightsView.tsx` — `MonthDetail` consumes the helper; new `spendingAvgMonths` prop threaded from `InsightsView`.
- **Create** `web/src/settings/CategoryAveragesCard.tsx` — the new Settings card.
- **Create** `web/src/settings/CategoryAveragesCard.test.tsx` — card tests.
- **Modify** `web/src/settings/SettingsView.tsx` — mount the new card after `SpendingProjectionCard`.
- **Modify** `web/src/settings/SettingsView.test.tsx` — update the card-list assertion (six → seven).

---

## Task 1: Add `spendingAvgMonths` to the settings store

**Files:**
- Modify: `web/src/settings/store.ts`
- Test: `web/src/settings/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside the existing `describe('loadSettings', …)` block in `web/src/settings/store.test.ts` (after the `'merges saved values over defaults'` test):

```ts
  it('defaults spendingAvgMonths to 12', () => {
    expect(loadSettings().spendingAvgMonths).toBe(12);
  });

  it('falls back to 12 when spendingAvgMonths is missing or non-positive', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 0 }));
    expect(loadSettings().spendingAvgMonths).toBe(12);
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: -4 }));
    expect(loadSettings().spendingAvgMonths).toBe(12);
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    expect(loadSettings().spendingAvgMonths).toBe(9);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- store.test.ts`
Expected: FAIL — `loadSettings().spendingAvgMonths` is `undefined`, so `defaults … to 12` fails with `expected undefined to be 12`.

- [ ] **Step 3: Add the field + default + guard**

In `web/src/settings/store.ts`:

Add the field to the `Settings` interface (after `cardProviders: string[];`):

```ts
  cardProviders: string[];
  spendingAvgMonths: number;
```

Add the default to `DEFAULT_SETTINGS` (after the `cardProviders: [ … ]` array literal, inside the object):

```ts
  spendingAvgMonths: 12,
```

In `loadSettings()`, after the existing `if (!Array.isArray(base.cardProviders)) { … }` block and before `return base;`, add:

```ts
  if (typeof base.spendingAvgMonths !== 'number' || base.spendingAvgMonths < 1) {
    base.spendingAvgMonths = DEFAULT_SETTINGS.spendingAvgMonths;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- store.test.ts`
Expected: PASS — all `loadSettings` + `saveSettings` tests green (the existing `'returns defaults when localStorage is empty'` test still passes because `DEFAULT_SETTINGS` now includes `spendingAvgMonths: 12` and `loadSettings` returns it).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors). If `SpendingProjectionCard`/others construct a `Settings` literal they'd error — they don't; they spread, so this is safe.

- [ ] **Step 6: Commit**

```bash
git add src/settings/store.ts src/settings/store.test.ts
git commit -m "feat(settings): add spendingAvgMonths field (default 12)"
```

---

## Task 2: Pure `categoryAverages` helper

**Files:**
- Create: `web/src/insights/categoryAverages.ts`
- Test: `web/src/insights/categoryAverages.test.ts`

This helper averages the trailing `windowMonths` completed cycles **strictly before** `displayedMonthKey`. A cycle counts only if its overall spending is > 0 (so empty pre-history months don't drag the mean to zero). Per-category means divide by that same qualifying-cycle count, matching today's `avgByCat` denominator.

- [ ] **Step 1: Write the failing test**

Create `web/src/insights/categoryAverages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { categoryAverages } from './categoryAverages';
import type { Transaction } from '../activity/types';

function txn(over: Partial<Transaction>): Transaction {
  return {
    id: 't', accountId: 'a', externalId: 'x',
    date: '2026-03-10', processedDate: null, amount: -100,
    currency: 'ILS', description: 'Shop', memo: null,
    kind: null, status: null, category: 'Groceries', createdAt: '2025-01-01',
    ...over,
  };
}

const NONE = () => false;

describe('categoryAverages', () => {
  it('averages spending over the N cycles before the displayed month', () => {
    // Displayed month May 2026. Window 2 → averages Apr + Mar 2026.
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100, category: 'Groceries' }),
      txn({ id: 'b', date: '2026-04-10', amount: -300, category: 'Groceries' }),
      txn({ id: 'c', date: '2026-05-10', amount: -999, category: 'Groceries' }), // displayed month, excluded
    ];
    const { avgSpending, avgByCat } = categoryAverages(txns, 1, NONE, 2, '2026-05');
    expect(avgSpending).toBe(200);              // (100 + 300) / 2
    expect(avgByCat.get('Groceries')).toBe(200);
  });

  it('ignores cycles outside the window', () => {
    // Window 1, displayed May → only Apr counts; Mar is out of window.
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100 }),
      txn({ id: 'b', date: '2026-04-10', amount: -300 }),
    ];
    const { avgSpending } = categoryAverages(txns, 1, NONE, 1, '2026-05');
    expect(avgSpending).toBe(300);
  });

  it('counts only cycles with spending > 0 (skips empty pre-history months)', () => {
    // Window 3 (Feb, Mar, Apr) but only Mar + Apr have spend → divide by 2.
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100, category: 'Food' }),
      txn({ id: 'b', date: '2026-04-10', amount: -300, category: 'Food' }),
    ];
    const { avgSpending, avgByCat } = categoryAverages(txns, 1, NONE, 3, '2026-05');
    expect(avgSpending).toBe(200);              // (100 + 300) / 2, not / 3
    expect(avgByCat.get('Food')).toBe(200);
  });

  it('divides a category by the qualifying-cycle count even when it has no spend some months', () => {
    // Mar + Apr both qualify (each has spend). Rent only in Apr → 500 / 2.
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100, category: 'Food' }),
      txn({ id: 'b', date: '2026-04-10', amount: -300, category: 'Food' }),
      txn({ id: 'c', date: '2026-04-15', amount: -500, category: 'Rent' }),
    ];
    const { avgByCat } = categoryAverages(txns, 1, NONE, 2, '2026-05');
    expect(avgByCat.get('Rent')).toBe(250);     // 500 / 2 qualifying cycles
    expect(avgByCat.get('Food')).toBe(200);     // (100 + 300) / 2
  });

  it('skips refund-fold, non-ILS, income, and excluded rows', () => {
    const txns = [
      txn({ id: 'a', date: '2026-04-10', amount: -200, category: 'Food' }),
      txn({ id: 'r', date: '2026-04-11', amount: -50, refundForId: 'a' }),       // refund-fold
      txn({ id: 'u', date: '2026-04-12', amount: -300, currency: 'USD' }),       // non-ILS
      txn({ id: 'i', date: '2026-04-13', amount: 5000 }),                        // income
      txn({ id: 'x', date: '2026-04-14', amount: -900, description: 'CARDBILL' }), // excluded
    ];
    const isExcluded = (t: Transaction) => t.description === 'CARDBILL';
    const { avgSpending, avgByCat } = categoryAverages(txns, 1, isExcluded, 1, '2026-05');
    expect(avgSpending).toBe(200);              // only the ₪200 Food row
    expect(avgByCat.get('Food')).toBe(200);
  });

  it('returns null avg and empty map when no qualifying cycles exist', () => {
    const { avgSpending, avgByCat } = categoryAverages([], 1, NONE, 6, '2026-05');
    expect(avgSpending).toBeNull();
    expect(avgByCat.size).toBe(0);
  });

  it('treats windowMonths < 1 as 1', () => {
    const txns = [
      txn({ id: 'a', date: '2026-03-10', amount: -100 }),
      txn({ id: 'b', date: '2026-04-10', amount: -300 }),
    ];
    const { avgSpending } = categoryAverages(txns, 1, NONE, 0, '2026-05');
    expect(avgSpending).toBe(300);              // window clamped to 1 → Apr only
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- categoryAverages.test.ts`
Expected: FAIL — `Failed to resolve import "./categoryAverages"` / `categoryAverages is not a function`.

- [ ] **Step 3: Write the implementation**

Create `web/src/insights/categoryAverages.ts`:

```ts
import { cycleKey, prevCycleKey } from '../cycle';
import type { Transaction } from '../activity/types';

export interface CategoryAverages {
  /** Mean overall spending across qualifying cycles, or null if none. */
  avgSpending: number | null;
  /** Mean spending per category across qualifying cycles. */
  avgByCat: Map<string, number>;
}

/**
 * Trailing per-category spending averages over the `windowMonths` cycles
 * immediately BEFORE `displayedMonthKey`. A cycle qualifies only if its
 * overall spending is > 0, so empty pre-history months don't pull the mean
 * toward zero. Per-category means divide by the qualifying-cycle count (the
 * same denominator the Insights "vs avg" chip used when this lived inline in
 * MonthDetail). Refund-fold, non-ILS, income, and `isExcluded` rows are
 * dropped — mirroring cycleAnalytics / MonthDetail filters.
 */
export function categoryAverages(
  transactions: Transaction[],
  monthStartDay: number,
  isExcluded: (t: Transaction) => boolean,
  windowMonths: number,
  displayedMonthKey: string,
): CategoryAverages {
  const n = Math.max(1, Math.floor(windowMonths));

  // Window cycle keys: the n cycles strictly before the displayed month.
  const windowKeys = new Set<string>();
  let k = prevCycleKey(displayedMonthKey);
  for (let i = 0; i < n; i++) {
    windowKeys.add(k);
    k = prevCycleKey(k);
  }

  // Aggregate spending per cycle, overall and per category.
  const overallByCycle = new Map<string, number>();
  const catByCycle = new Map<string, Map<string, number>>(); // cycle → (cat → amount)
  for (const t of transactions) {
    if (t.currency !== 'ILS' || t.refundForId) continue;
    if (t.amount >= 0) continue; // spending only
    if (isExcluded(t)) continue;
    const key = cycleKey(t.date, monthStartDay);
    if (!windowKeys.has(key)) continue;
    const spent = -t.amount;
    overallByCycle.set(key, (overallByCycle.get(key) ?? 0) + spent);
    const cat = t.category || 'Other';
    let m = catByCycle.get(key);
    if (!m) { m = new Map(); catByCycle.set(key, m); }
    m.set(cat, (m.get(cat) ?? 0) + spent);
  }

  // Qualifying cycles = window cycles with overall spending > 0.
  const qualifying = [...windowKeys].filter((key) => (overallByCycle.get(key) ?? 0) > 0);
  if (qualifying.length === 0) {
    return { avgSpending: null, avgByCat: new Map() };
  }

  let overallSum = 0;
  const catSums = new Map<string, number>();
  for (const key of qualifying) {
    overallSum += overallByCycle.get(key) ?? 0;
    const m = catByCycle.get(key);
    if (!m) continue;
    for (const [cat, amt] of m) catSums.set(cat, (catSums.get(cat) ?? 0) + amt);
  }

  const avgByCat = new Map<string, number>();
  for (const [cat, sum] of catSums) avgByCat.set(cat, sum / qualifying.length);

  return { avgSpending: overallSum / qualifying.length, avgByCat };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- categoryAverages.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/insights/categoryAverages.ts src/insights/categoryAverages.test.ts
git commit -m "feat(insights): pure categoryAverages helper for trailing per-category means"
```

---

## Task 3: Wire the helper into `MonthDetail`

**Files:**
- Modify: `web/src/insights/InsightsView.tsx`
  - `MonthDetailProps` interface (~L820-829)
  - `MonthDetail` signature + body (~L831-865)
  - `MonthDetail` call site (~L108-116)

Replace the inline `avgSpending` + `avgByCat` math with the helper, and add a `spendingAvgMonths` prop. **Leave `byCatCycle`, `prevAmt` ("vs last"), `cycleIdx`, and the `months` chart data exactly as they are** — they still power the bar chart and the "vs last" chip.

- [ ] **Step 1: Add the import**

At the top of `web/src/insights/InsightsView.tsx`, with the other relative imports (next to the `cycleAnalytics` / `cycle` imports), add:

```ts
import { categoryAverages } from './categoryAverages';
```

- [ ] **Step 2: Add the prop to `MonthDetailProps`**

In the `MonthDetailProps` interface, add after `monthStartDay: number;`:

```ts
  monthStartDay: number;
  /** How many trailing completed cycles feed the "vs avg" comparisons. */
  spendingAvgMonths: number;
```

- [ ] **Step 3: Destructure the new prop**

Change the `MonthDetail` parameter destructuring from:

```ts
  { monthKey, months, transactions, categories, monthStartDay, isExcluded }: MonthDetailProps,
```

to:

```ts
  { monthKey, months, transactions, categories, monthStartDay, spendingAvgMonths, isExcluded }: MonthDetailProps,
```

- [ ] **Step 4: Replace the inline averages with the helper**

Find this block (the `avgSpending` computation, ~L836-840):

```ts
  // Trailing-average over completed months (every month but the current).
  const completed = months.slice(0, -1).filter((m) => m.spending > 0);
  const avgSpending = completed.length > 0
    ? completed.reduce((s, m) => s + m.spending, 0) / completed.length
    : null;
```

Replace it with:

```ts
  // Trailing per-category averages over the user-chosen window (Settings →
  // Category averages), anchored to the cycles before the displayed month.
  const { avgSpending, avgByCat } = categoryAverages(
    transactions, monthStartDay, isExcluded, spendingAvgMonths, monthKey,
  );
```

Then DELETE the now-redundant `avgByCat` block that follows the `byCatCycle` loop (~L857-865):

```ts
  const avgByCat = new Map<string, number>();
  const compIdx = months.slice(0, -1)
    .map((m, i) => (m.spending > 0 ? i : -1))
    .filter((i) => i >= 0);
  for (const [cat, arr] of byCatCycle) {
    if (compIdx.length === 0) continue;
    const sum = compIdx.reduce((s, i) => s + (arr[i] || 0), 0);
    avgByCat.set(cat, sum / compIdx.length);
  }
```

Leave the `cycleIdx` map and the `byCatCycle` aggregation loop above it in place — `prevAmt` (the "vs last" chip) still reads `byCatCycle`.

- [ ] **Step 5: Pass the prop at the call site**

At the `<MonthDetail … />` call site (~L108-116), add the prop after `monthStartDay={settings.monthStartDay}`:

```tsx
          monthStartDay={settings.monthStartDay}
          spendingAvgMonths={settings.spendingAvgMonths}
```

- [ ] **Step 6: Run the Insights tests + typecheck**

Run: `npm test -- InsightsView`
Expected: PASS — existing InsightsView tests still green (the default `spendingAvgMonths` is 12, so the "vs avg" base over the prior completed cycles matches the previous 12-window behavior for the existing fixtures).

Run: `npm run typecheck`
Expected: clean.

If an existing InsightsView test asserted an exact "vs avg" number that shifts because the new anchor is *displayed-month-relative* rather than window-anchored, update that expectation to the value the trailing-window helper now produces (recompute by hand from the fixture: mean of the qualifying cycles before the displayed month). Do NOT weaken unrelated assertions.

- [ ] **Step 7: Commit**

```bash
git add src/insights/InsightsView.tsx
git commit -m "feat(insights): drive vs-avg comparisons from spendingAvgMonths window"
```

---

## Task 4: `CategoryAveragesCard` Settings card

**Files:**
- Create: `web/src/settings/CategoryAveragesCard.tsx`
- Test: `web/src/settings/CategoryAveragesCard.test.tsx`

Segmented presets `3 / 6 / 12 / 24` + a `Custom` button. A preset is `on` when `spendingAvgMonths === preset`; `Custom` is `on` when the value is not a preset. When Custom is active, a number `<input min=1>` is shown, bound to the value; empty/non-positive input is ignored (keeps last valid value).

- [ ] **Step 1: Write the failing tests**

Create `web/src/settings/CategoryAveragesCard.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CategoryAveragesCard } from './CategoryAveragesCard';
import { SettingsProvider } from './useSettings';
import { loadSettings } from './store';

function renderCard() {
  return render(<SettingsProvider><CategoryAveragesCard /></SettingsProvider>);
}

describe('CategoryAveragesCard', () => {
  it('renders the preset buttons with the active one pressed', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 12 }));
    renderCard();
    ['3', '6', '12', '24'].forEach((n) =>
      expect(screen.getByRole('button', { name: n })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '12' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '6' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('picking a preset persists spendingAvgMonths', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 12 }));
    renderCard();
    await user.click(screen.getByRole('button', { name: '6' }));
    expect(loadSettings().spendingAvgMonths).toBe(6);
    expect(screen.getByRole('button', { name: '6' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '12' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks Custom active and shows the number input for a non-preset value', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    renderCard();
    expect(screen.getByRole('button', { name: /custom/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('spinbutton', { name: /custom months/i })).toHaveValue(9);
  });

  it('does not show the input when a preset is active', () => {
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 12 }));
    renderCard();
    expect(screen.queryByRole('spinbutton', { name: /custom months/i })).not.toBeInTheDocument();
  });

  it('clicking Custom reveals the input prefilled with the current value', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 12 }));
    renderCard();
    await user.click(screen.getByRole('button', { name: /custom/i }));
    expect(screen.getByRole('spinbutton', { name: /custom months/i })).toHaveValue(12);
  });

  it('typing a custom number persists it', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    renderCard();
    const input = screen.getByRole('spinbutton', { name: /custom months/i });
    await user.clear(input);
    await user.type(input, '18');
    expect(loadSettings().spendingAvgMonths).toBe(18);
  });

  it('ignores a cleared/zero input and keeps the last valid value', async () => {
    const user = userEvent.setup();
    localStorage.setItem('honSettings', JSON.stringify({ spendingAvgMonths: 9 }));
    renderCard();
    const input = screen.getByRole('spinbutton', { name: /custom months/i });
    await user.clear(input);
    expect(loadSettings().spendingAvgMonths).toBe(9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- CategoryAveragesCard.test.tsx`
Expected: FAIL — `Failed to resolve import "./CategoryAveragesCard"`.

- [ ] **Step 3: Write the component**

"Custom" is a sticky UI mode tracked with local state (not derived purely from
the value) — so clicking "Custom" from a preset reveals the prefilled input even
though the stored value is momentarily still a preset number.

Create `web/src/settings/CategoryAveragesCard.tsx`:

```tsx
import { useState } from 'react';
import { useSettings } from './useSettings';

const PRESETS = [3, 6, 12, 24];

export function CategoryAveragesCard() {
  const [settings, update] = useSettings();
  const value = settings.spendingAvgMonths;
  // Custom mode is active when the stored value isn't a preset, OR the user
  // explicitly clicked "Custom" (sticky, so clicking it from a preset shows
  // the input even though the value is momentarily still a preset number).
  const [customIntent, setCustomIntent] = useState(false);
  const isCustom = customIntent || !PRESETS.includes(value);

  return (
    <section className="set-card">
      <div className="set-card-head">
        <span className="set-ico">📐</span>
        <h3>Category averages</h3>
      </div>
      <div className="set-row col">
        <div className="set-row-main">
          <div className="set-row-name">Average window</div>
          <div className="set-row-sub">
            How many recent months feed the “vs avg” comparison on each category in
            Insights. Pick a preset or set a custom number of months.
          </div>
        </div>
        <div className="seg" role="group" aria-label="Category average window">
          {PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={!isCustom && value === n}
              className={!isCustom && value === n ? 'on' : ''}
              onClick={() => { setCustomIntent(false); update({ spendingAvgMonths: n }); }}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={isCustom}
            className={isCustom ? 'on' : ''}
            onClick={() => setCustomIntent(true)}
          >
            Custom
          </button>
        </div>
        {isCustom && (
          <input
            type="number"
            min={1}
            className="set-num"
            aria-label="Custom months"
            value={value}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1) update({ spendingAvgMonths: n });
            }}
          />
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- CategoryAveragesCard.test.tsx`
Expected: PASS — all 7 tests green. (The "non-preset value" test passes via `!PRESETS.includes(9)`; the "click Custom from preset" test passes via `customIntent`.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/settings/CategoryAveragesCard.tsx src/settings/CategoryAveragesCard.test.tsx
git commit -m "feat(settings): Category averages card with presets + custom months"
```

---

## Task 5: Mount the card in `SettingsView`

**Files:**
- Modify: `web/src/settings/SettingsView.tsx`
- Modify: `web/src/settings/SettingsView.test.tsx`

- [ ] **Step 1: Update the card-list test (failing first)**

In `web/src/settings/SettingsView.test.tsx`, change the `'renders all six settings cards'` test to expect seven, with the new card after Spending projection:

```tsx
  it('renders all seven settings cards', () => {
    installFetchMock({ 'GET /api/categories': () => ({ categories: [] }) });
    render(<SettingsView />);
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      'AI engine', 'Billing cycle', 'Spending projection', 'Category averages',
      'Credit-card bills', 'Splitwise', 'Categories',
    ]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- SettingsView.test.tsx`
Expected: FAIL — the rendered headings are still the six-card list (no "Category averages").

- [ ] **Step 3: Mount the card**

In `web/src/settings/SettingsView.tsx`:

Add the import with the others (after the `BillingCycleCard` import):

```ts
import { CategoryAveragesCard } from './CategoryAveragesCard';
```

In the `set-grid`, insert the card right after `<SpendingProjectionCard />`:

```tsx
          <SpendingProjectionCard />
          <CategoryAveragesCard />
          <CreditCardBillsCard />
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- SettingsView.test.tsx`
Expected: PASS — seven headings in the asserted order.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test`
Expected: PASS — full web suite green (419 + the new tests).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/settings/SettingsView.tsx src/settings/SettingsView.test.tsx
git commit -m "feat(settings): mount Category averages card after Spending projection"
```

---

## Task 6: Optional CSS for the custom input

**Files:**
- Modify: the global stylesheet that defines `.set-card` / `.seg` (find with
  `grep -rl '\.set-card' web/src --include='*.css'`).

The `.set-num` class on the custom input may not exist. If the input renders
unstyled/oversized, add a small rule next to the existing `.seg` rules.

- [ ] **Step 1: Locate the stylesheet**

Run: `grep -rln '\.seg' src --include='*.css'`
Expected: prints the CSS file that styles the segmented control (e.g. `src/index.css` or a settings stylesheet).

- [ ] **Step 2: Add a minimal rule**

In that file, near the `.seg` rules, add:

```css
.set-num {
  margin-top: 8px;
  width: 96px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border, #2a2a2a);
  background: var(--card-hi, #1c1c1c);
  color: inherit;
  font: inherit;
}
```

(Match the surrounding variables/colors used by sibling inputs — adjust the
`var(--…)` fallbacks to whatever the file already uses.)

- [ ] **Step 3: Commit**

```bash
git add src/<the-css-file>
git commit -m "style(settings): style the custom-months input"
```

---

## Visual verification (REQUIRED before reporting done — PROJECT-RULES §2)

Tests + typecheck do NOT count as done for a UI change. After Task 5 (and 6),
verify in a real browser via chrome-devtools MCP:

- [ ] Ensure the dev server is running (the user runs their own — do NOT call
  `preview_start`). Read the token: `cat "$HOME/Library/Application Support/Hon/dev-token"`.
- [ ] `mcp__chrome-devtools__new_page` → `http://localhost:5173/#token=<TOKEN>`,
  then `navigate_page { reload, ignoreCache: true }`.
- [ ] Go to **Settings** → screenshot the new **Category averages** card; confirm
  presets render, `12` is pressed by default, clicking `Custom` reveals the input.
- [ ] Go to **Insights → Spending**, note a category's "vs avg" chip, then change
  the window in Settings (e.g. to `3`), return to Insights, reload, and confirm
  the "vs avg" base shifts while the bar chart and "vs last" chip are unchanged.
- [ ] `Read` each screenshot to confirm with your own eyes before claiming done.

---

## Definition of done

- `npm test` (from `web/`) green, including new store / helper / card / SettingsView tests.
- `npm run typecheck` clean.
- Visual verification screenshots captured and reviewed.
- All commits made on `session/category-avg-window-2026-05-29`.
- **Do not merge to main or push** — show the user the diff and let them decide (PROJECT-RULES §3).
