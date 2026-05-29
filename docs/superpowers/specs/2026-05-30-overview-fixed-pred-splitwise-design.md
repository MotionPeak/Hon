# Overview projection — predicted-fixed + Splitwise owed

**Date:** 2026-05-30
**Status:** Approved (brainstorming) → ready for writing-plans
**Topic:** Make the Overview's "Expected fixed + essentials" actually predicted (not posted-so-far), and surface Splitwise money-owed-to-you in the end-of-cycle projection.

## Problem

Two issues in `web/src/overview/OverviewView.tsx`:

1. **The label lies.** "Expected fixed + essentials" displays `variable.committed = fixedSpent + essentialSpent` — the amount **already posted** this cycle ([OverviewView.tsx:137, 173](web/src/overview/OverviewView.tsx#L137)). The Fixed bills tab, by contrast, runs `detectMerchants` and predicts each bill's full charge for the cycle (incl. bimonthly off-cycle = ₪0). So Overview and Fixed bills disagree, and the Overview understates expected outflow early in a cycle (before card-bill posting).
2. **Splitwise owed isn't in the projection.** `OwedToYouCard` shows what friends owe you, but the projected end-of-cycle bank balance ignores it — even though that money is incoming.

## Goal

- The Overview's **"Expected fixed + essentials"** line (and the bank projection's "Fixed + essentials this cycle") uses **the same predicted-this-cycle fixed total as the Fixed bills tab**, not posted-so-far.
- The **projected end-of-cycle bank balance** adds a "**+ Owed to you (Splitwise)**" line summing ILS-currency balances where friends owe the user.

Essentials, variable, piggies, and the bar-chart projection's mental model stay as they are.

## Decisions (locked during brainstorming)

1. **Expected fixed = due-this-cycle full predicted.** A bimonthly bill counts in full the cycle it's due, ₪0 when off-cycle. Yearly counts in full only in its month. Monthly always counts. Mirrors the legacy `expectedFixedThisCycle`.
2. **Splitwise owed = its own projection line.** Not folded into income, not netted against per-transaction spend. Added as `+ Owed to you (Splitwise)` directly to the projected end-of-cycle bank balance. Hidden when ₪0 or Splitwise disconnected.
3. **Currency.** The projection is single-currency (`budget.currency`, ILS). Only owed balances whose `currency === budget.currency` are summed. Non-ILS owed is ignored by the projection (still visible in `OwedToYouCard`).
4. **Client-side computation.** Detection is lifted from `RecurringView.tsx` to `recurring/helpers.ts`; Overview fetches the same five endpoints and runs it. The engine `/budget` route is unchanged. (It already accepts an `expectedFixed` query param that the *display* doesn't surface, so plumbing it through wouldn't help the headline anyway — and would risk drift with the Fixed bills tab.)
5. **Graceful degrade.** Any of the five new fetches failing → fall back to `fixedSpent` for the headline (current behavior). Overview never goes blank.

## Architecture

Three small units with clear seams:

### 1. `web/src/recurring/helpers.ts` — lift detection + add the predictor

Move two things from `RecurringView.tsx` into `helpers.ts` (already the shared
recurring module):

- Types `RecurringData`, `MerchantRow`, `FreqOrIgnore`.
- `detectMerchants(data: RecurringData): { rows: MerchantRow[]; categoryGroups: Record<string, Category['catGroup']> }` — verbatim lift, no logic change. RecurringView re-imports it instead of declaring locally.
- New helper `cyclesBetween(fromKey, toKey)` — lifted alongside (already a sibling in RecurringView).

Then **add** a new pure export:

```ts
/**
 * Sum of the full per-row charges due this cycle, mirroring statusFor()'s
 * "due this cycle vs off-cycle" classification. Bimonthly counts full when on-
 * cycle, 0 when last cycle billed (gap === 1). Yearly counts full only in its
 * cycle (gap >= 12 or never billed). Monthly always counts.
 * Per-row contribution: lastChargeAbs / split.
 */
export function expectedFixedThisCycle(
  rows: MerchantRow[],
  monthStartDay: number,
): number;
```

Implementation references `currentCycleKey(monthStartDay)` and the same gap
rules `statusFor()` uses, so the headline number is consistent with the per-row
"Off-cycle"/"Up next" badges in the Fixed bills tab.

### 2. `web/src/overview/OverviewView.tsx` — consume the predictor

- Add five fetches (same as RecurringView): `/transactions`, `/categories`,
  `/merchant-frequencies`, `/category-splits`, `/subscriptions/cancelled`.
- Read `monthStartDay` from `useSettings()`.
- Compute `const { rows } = detectMerchants(recurringData); const predictedFixed = expectedFixedThisCycle(rows, monthStartDay);`
- Derive `committedDisplay = predictedFixed + (variable.essentialSpent ?? 0)`.
- Pass `committedDisplay` (instead of `variable.committed`) into the "Expected
  fixed + essentials" line in `BalanceCard` AND into the `BankProjection`'s
  "Fixed + essentials this cycle" line.
- Net = `income − committedDisplay − spent`. (Spent stays `variable.spent`.)

If any of the five new fetches fail (any rejected Promise), fall back to
`variable.committed` for `committedDisplay` (silent — log to console only). The
overview should never go blank because of recurring data.

### 3. Splitwise owed line — inside `BankProjection`

```tsx
const sw = useSplitwise();
const owed = sw.connected
  ? sw.friends
      .flatMap((f) => f.balances)
      .filter((b) => b.currency === currency && b.amount > 0)
      .reduce((s, b) => s + b.amount, 0)
  : 0;
```

- Render `<Detail label="Owed to you (Splitwise)" amount={owed} tone="good" />`
  between the income line and the end-balance, ONLY when `owed > 0`.
- End-balance math: `endBalance = bankNow + income − committedDisplay − cycleVariable − cyclePiggy + owed;`.
- The end-balance Detail's existing label/copy stays the same.
- `useSplitwise()` already cache-shares across mounts (`hon.splitwise-changed`
  event), so this adds no extra fetch beyond what `OwedToYouCard` already does.

## Data flow

```
/transactions + /categories + /merchant-frequencies +
/category-splits + /subscriptions/cancelled
        │  (parallel fetch alongside the existing 4)
        ▼
detectMerchants(data)            → MerchantRow[]
expectedFixedThisCycle(rows, monthStartDay) → predictedFixed
        │
        ▼
committedDisplay = predictedFixed + essentialSpent
        │
        ├─► "Expected fixed + essentials" line
        ├─► "This month" net  (= income − committedDisplay − spent)
        └─► BankProjection "Fixed + essentials this cycle" line

useSplitwise() → friends[].balances (currency=ILS, amount>0) → owed
        ▼
BankProjection: + "Owed to you (Splitwise)"  line (when owed > 0)
                end-balance += owed
```

## Behavior changes summary

| Surface | Before | After |
|---|---|---|
| Header "Expected fixed + essentials" | fixedSpent + essentialSpent (posted) | expectedFixedThisCycle + essentialSpent (predicted + posted essentials) |
| "This month" net | income − posted − variable | income − (predicted+essentialSpent) − variable |
| BankProjection "Fixed + essentials this cycle" | same as header (posted) | same as new header (predicted) |
| BankProjection end-balance | bankNow + income − fixed − var − piggy | + owed (when Splitwise connected & ILS owed > 0) |
| BankProjection new line | — | "+ Owed to you (Splitwise)" between income & end-balance |
| Fixed bills tab | unchanged | unchanged (same source of truth now drives Overview too) |
| Engine `/budget` | unchanged | unchanged |
| `OwedToYouCard` | unchanged | unchanged |

## Error / edge handling

- **Any new fetch fails** → `committedDisplay = variable.committed` (current
  behavior). The owed line is independent and still shows if Splitwise is up.
- **No detected fixed merchants** (new account, no history) → `predictedFixed
  = 0`, so `committedDisplay = essentialSpent`. Display drops below current.
  Accepted regression for empty-history accounts; user explicitly chose
  "predicted" over "greater of predicted vs posted" during brainstorming.
- **Splitwise not connected / 0 owed / non-ILS-only** → no `+ Owed to you`
  line, no end-balance adjustment.
- **Currency mismatch** → Only ILS balances (`b.currency === currency`) feed
  the projection. Non-ILS owed remains visible in `OwedToYouCard`.
- **Already-billed-this-cycle fixed bill (e.g., rent posted)** → the row's
  `lastChargeAbs / split` is included in `predictedFixed` (it's "billed this
  cycle", not off-cycle). This double-deducts vs `bankNow` for bills that have
  already posted, but matches the legacy "bankProjectionBlock" mental model:
  Israeli card bills lag, so deducting the full cycle commitment is correct in
  aggregate. Documented in CLAUDE.md (§ "The projected-bank-balance card").

## Testing (TDD order)

1. **`recurring/helpers.test.ts`** — new `expectedFixedThisCycle` cases:
   - Single monthly row: contributes `lastChargeAbs / split`.
   - Single bimonthly row: full charge when gap !== 1 ("on-cycle"); ₪0 when gap === 1 ("Off-cycle").
   - Single yearly row: full charge only when gap >= 12 or never billed; ₪0 otherwise.
   - Split divisor: ₪600 / 2 = ₪300.
   - Multi-row sum.
   - Empty rows array → 0.
2. **`recurring/RecurringView.test.tsx`** — confirm Recurring still renders identically after the lift (regression check; uses the same exported `detectMerchants`).
3. **`overview/OverviewView.test.tsx`** — integration:
   - Default mock fixtures: header shows `predictedFixed + essentialSpent`, not posted-fixed.
   - Bimonthly off-cycle bill: predictedFixed excludes it.
   - All five new fetches fail: header falls back to `variable.committed`.
   - Splitwise connected, ILS owed > 0: BankProjection renders the new line, end-balance includes it.
   - Splitwise disconnected: no owed line, no end-balance change.
   - Splitwise USD-only owed: no owed line (currency filter).

## Out of scope

- Changing the engine `/budget` route (already accepts `expectedFixed`; not used here).
- Per-transaction Splitwise netting (would require linking each shared expense to its split — separate feature).
- "Essentials" predicted (only fixed is changing; essentials stay budget-vs-spent).
- Subscriptions tab's projection (Subscriptions is its own thing; not in scope).
- Cycle-aware piggy adjustments.
