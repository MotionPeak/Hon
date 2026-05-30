# Merge Subscriptions into the Fixed bills page

**Date:** 2026-05-30
**Status:** Approved (design)
**Scope:** Frontend IA change in `web/`. Merge the Subscriptions tab into the
Fixed bills page as a dedicated area; remove the Subscriptions nav tab.

## Problem

Fixed bills and Subscriptions are separate tabs, but `Subscriptions` is a
category inside the `fixed` group — so subscription merchants render in **two**
places today: as a plain "Subscriptions" category section on the Fixed bills
page (`recurring/RecurringView.tsx`) and as the dedicated Subscriptions tab
(`subscriptions/SubscriptionsView.tsx`) with its richer flagged / active /
cancelled / probably-cancelled buckets. Both tabs also fetch the same
`/transactions`, `/merchant-frequencies`, and `/subscriptions/cancelled` — a
redundant fetch the codebase already carries.

## Goal & decisions (from brainstorming)

One page (the **Fixed bills** tab, id `recurring`, label/emoji unchanged):

1. Fixed-bills summaries + category sections on top, then a dedicated
   **"🔁 Subscriptions" area** (the rich 4-bucket view) below.
2. Drop the plain **Subscriptions category** from the fixed-bills sections so
   subscriptions appear **once** — in the rich area.
3. The fixed-bills summaries ("Due this cycle", "Expected monthly") count only
   the **non-subscription** fixed categories; the Subscriptions area keeps its
   own "₪X / month" total. Each total reconciles with what's shown beneath it.
4. **Remove the Subscriptions nav tab** (`subscriptions`) entirely.
5. Tab name stays **"Fixed bills"** (📆).

## Approach B — extract `SubscriptionsSection`, share one fetch

RecurringView already fetches a **superset** of what the subscriptions view
needs (`/transactions`, `/merchant-frequencies`, `/subscriptions/cancelled`).
Extract the subscription detection + rendering into a presentational
`SubscriptionsSection` that consumes data passed down from RecurringView — one
fetch, no duplication, proper heading hierarchy. The standalone
`SubscriptionsView` becomes unused and is removed.

## Components & changes

### New — `web/src/subscriptions/SubscriptionsSection.tsx`
Presentational. Holds the logic moved verbatim out of `SubscriptionsView`:
`detect()`, `bucket()`, `SubRowCard`, and the summary + 4-bucket JSX.

- **Props:** `{ transactions: Transaction[]; frequencies: Record<string, FreqOrIgnore>; cancelled: Record<string, string> }` (cancelled = merchantKey → ISO timestamp — the buckets compare last-charge vs cancellation time).
- Renders an `<h2>`-level section header (e.g. "🔁 Subscriptions") consistent
  with the page's section-heading style, then the existing summary
  (`₪X / month` + counts) and the conditional buckets. No own data fetch, no
  `<h1>`.
- Empty state: when no subscription rows, render the existing "no subscriptions"
  message inside the section.

### `web/src/recurring/RecurringView.tsx`
- **Cancelled fetch shape change:** fetch `/subscriptions/cancelled` as
  `Record<string, string>` (timestamps) instead of `Record<string, boolean>`,
  so `SubscriptionsSection` can bucket. If RecurringView's own fixed detection
  uses `cancelled` as a boolean, derive it (`key in cancelled`) — but since the
  Subscriptions category is dropped from the fixed sections, fixed detection no
  longer needs it.
- **Drop Subscriptions from the fixed sections + summaries:** exclude the
  `Subscriptions` category when rendering category sections AND when computing
  the "Due this cycle" / "Expected monthly" totals (filter it out of the rows
  feeding both).
- **Render the area:** below the fixed-bills sections, render
  `<SubscriptionsSection transactions={…} frequencies={…} cancelled={…} />`
  using the already-fetched data.

### `web/src/App.tsx`
- Remove `'subscriptions'` from the `Tab` union, the `TABS` list entry, and the
  `{tab === 'subscriptions' && <SubscriptionsView/>}` render branch + its import.

### Removed — `web/src/subscriptions/SubscriptionsView.tsx`
Now unused. Delete it; migrate its 7 tests onto `SubscriptionsSection`.

### CSS
Reuse the existing `.subscriptions-view` / `.sub-*` classes for the section
(the section nests inside `.recurring-view`); add a section wrapper class if
spacing needs it. No new visual language.

## Data flow

Single fetch in RecurringView (`/transactions`, `/categories`,
`/merchant-frequencies`, `/category-splits`, `/subscriptions/cancelled` as
timestamps) feeds both the fixed-bills sections and `SubscriptionsSection`.
Subscription cancel/flag mutations (if any in the current view) keep their
existing endpoints; `SubscriptionsSection` calls back to RecurringView's
`reload()` after a mutation (pass an `onChanged` prop) — or, if the current
subscriptions view has no mutations, none is needed (verify in plan).

## Testing

- **`SubscriptionsSection.test.tsx`** (migrated from `SubscriptionsView.test.tsx`,
  ~7 specs): render with props (no fetch mock needed, or a thin wrapper) —
  buckets, active/lapsed, flagged-after-cancel, summary totals, empty state.
- **`RecurringView.test.tsx`** (update): no "Subscriptions" category section
  renders; the Subscriptions area IS present (a subscription merchant shows in
  the area, not in the fixed list); "Expected monthly" excludes subscriptions.
- **`App.test.tsx`** (update if it asserts the tab list): no `subscriptions`
  tab; the Fixed bills tab still renders.
- `cd web && npm test` green; `cd web && npm run typecheck` clean.

## Verification (PROJECT-RULES §2)

chrome-devtools against a live engine: the Fixed bills page shows the fixed
summaries + non-subscription category sections, then the "🔁 Subscriptions"
area with its buckets; the sidebar has **no** Subscriptions tab; a subscription
merchant appears only in the area (not duplicated in the fixed list).

## Risks

- **`cancelled` shape change** (boolean → timestamp map) in RecurringView — make
  sure nothing else in RecurringView relied on the boolean shape.
- **Summary semantics shift** — "Expected monthly" drops the subscriptions
  amount (now in the area's own total). Intended; verify the number reconciles
  with the visible fixed rows.
- **Heading hierarchy** — page keeps one `<h1>` (Fixed bills); the area is an
  `<h2>` section (the old `<h1>Subscriptions</h1>` must not survive the move).
