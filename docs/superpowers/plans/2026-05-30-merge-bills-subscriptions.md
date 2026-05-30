# Merge Subscriptions into Fixed bills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the Subscriptions tab into the Fixed bills page as a dedicated section, sharing one data fetch, and remove the Subscriptions nav tab.

**Architecture:** Extract the subscription detection + rendering from `SubscriptionsView` into a presentational `SubscriptionsSection` (props in, no fetch). `RecurringView` already fetches a superset of the needed data; it renders the fixed-bills sections (excluding the Subscriptions category) then `<SubscriptionsSection/>`. Delete `SubscriptionsView`; remove the `subscriptions` tab from `App.tsx`.

**Tech Stack:** React 19 + TS strict + Vitest/Testing-Library; `web/src/styles.css`.

**Spec:** `docs/superpowers/specs/2026-05-30-merge-bills-subscriptions-design.md`

---

## File Structure

- **Create** `web/src/subscriptions/SubscriptionsSection.tsx` — presentational subscriptions area (detect/bucket/SubRowCard + summary + 4 buckets), props `{ transactions, frequencies, cancelled }`.
- **Create** `web/src/subscriptions/SubscriptionsSection.test.tsx` — migrated from `SubscriptionsView.test.tsx`, props-driven (no fetch mock).
- **Modify** `web/src/recurring/helpers.ts` — `RecurringData.cancelled` type `Record<string,boolean>` → `Record<string,string>`.
- **Modify** `web/src/recurring/RecurringView.tsx` — fetch cancelled as timestamps; exclude Subscriptions category from rows; fold the empty case into the main return; render `<SubscriptionsSection/>`.
- **Modify** `web/src/recurring/RecurringView.test.tsx` — subs no longer a fixed section; subs area present.
- **Modify** `web/src/App.tsx` — remove the `subscriptions` tab (import, Tab union, TABS entry, render branch).
- **Modify** `web/src/App.test.tsx` — if it asserts the tab list, drop Subscriptions.
- **Delete** `web/src/subscriptions/SubscriptionsView.tsx` + `web/src/subscriptions/SubscriptionsView.test.tsx`.
- **Modify** `web/src/styles.css` — add `.subs-section` / `.subs-section-title`.

Test commands: `cd web && npm test` ; `cd web && npm run typecheck`.

---

## Task 1: Extract `SubscriptionsSection` (props-driven) + migrate tests

**Files:** Create `web/src/subscriptions/SubscriptionsSection.tsx`, `web/src/subscriptions/SubscriptionsSection.test.tsx`.

- [ ] **Step 1: Write the migrated test (RED)**

Create `web/src/subscriptions/SubscriptionsSection.test.tsx` — the 7 specs from `SubscriptionsView.test.tsx`, rewritten to render the component with **props** (no fetch):

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SubscriptionsSection } from './SubscriptionsSection';

const today = new Date();
function daysAgo(n: number): string {
  const d = new Date(today.getTime() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
function txn(over: Partial<{ id: string; date: string; description: string; amount: number; category: string | null }>) {
  return {
    id: over.id ?? 't', accountId: 'a', externalId: 'x',
    date: over.date ?? daysAgo(10), processedDate: null,
    amount: over.amount ?? -50, currency: 'ILS',
    description: over.description ?? 'Netflix', memo: null,
    kind: null, status: null,
    category: over.category ?? 'Subscriptions', createdAt: '2025-01-01',
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render_ = (transactions: any[], frequencies: Record<string, string> = {}, cancelled: Record<string, string> = {}) =>
  render(<SubscriptionsSection transactions={transactions as any} frequencies={frequencies as any} cancelled={cancelled} />);

describe('SubscriptionsSection', () => {
  it('shows the empty state when no Subscriptions txns exist', () => {
    render_([]);
    expect(screen.getByText(/no subscription charges/i)).toBeInTheDocument();
  });

  it('groups active subs (recent charge) under the Active section', () => {
    render_([txn({ id: 't1', description: 'Netflix', date: daysAgo(5), amount: -55 })]);
    const active = screen.getByRole('heading', { name: /^active$/i }).closest('section')!;
    expect(within(active as HTMLElement).getByText('Netflix')).toBeInTheDocument();
  });

  it('separates "Probably cancelled" subs with last charge > 40 days old', () => {
    render_([txn({ id: 't1', description: 'OldGym', date: daysAgo(120), amount: -200 })]);
    const lapsed = screen.getByRole('heading', { name: /probably cancelled/i }).closest('section')!;
    expect(within(lapsed as HTMLElement).getByText('OldGym')).toBeInTheDocument();
  });

  it('treats yearly-frequency subs as active for ~13 months', () => {
    render_([txn({ id: 't1', description: 'Domain Renewal', date: daysAgo(200), amount: -120 })],
      { 'domain renewal': 'yearly' });
    const active = screen.getByRole('heading', { name: /^active$/i }).closest('section')!;
    expect(within(active as HTMLElement).getByText('Domain Renewal')).toBeInTheDocument();
  });

  it('puts user-cancelled subs in the Cancelled section', () => {
    render_([txn({ id: 't1', description: 'Spotify', date: daysAgo(120), amount: -20 })],
      {}, { spotify: daysAgo(60) });
    const cancelled = screen.getByRole('heading', { name: /^cancelled$/i }).closest('section')!;
    expect(within(cancelled as HTMLElement).getByText('Spotify')).toBeInTheDocument();
  });

  it('flags subs charged AFTER the user marked cancelled', () => {
    render_([txn({ id: 't1', description: 'YouTube Premium', date: daysAgo(5), amount: -45 })],
      {}, { 'youtube premium': daysAgo(20) });
    expect(screen.getByRole('heading', { name: /charged after/i })).toBeInTheDocument();
    expect(screen.getByText('YouTube Premium')).toBeInTheDocument();
  });

  it('renders the monthly total of active subs', () => {
    render_([
      txn({ id: 't1', description: 'Netflix', date: daysAgo(5), amount: -55 }),
      txn({ id: 't2', description: 'Disney Plus', date: daysAgo(10), amount: -45 }),
    ]);
    const summary = screen.getByTestId('sub-summary');
    expect(within(summary).getByText(/100/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it (RED)** — `cd web && npx vitest run src/subscriptions/SubscriptionsSection.test.tsx` — Expected: FAIL (module missing).

- [ ] **Step 3: Create the component** — Create `web/src/subscriptions/SubscriptionsSection.tsx`. This is `SubscriptionsView.tsx` with the fetch/loader/`<h1>`/`.subscriptions-view` wrapper removed and data taken as props; the `detect`/`bucket`/`fmtDate`/`SubRowCard` move verbatim:

```tsx
import { money } from '../format';
import {
  merchantKey, merchantName, monthlyEquivalent,
  RECURRENCE_ACTIVE_DAYS, type Frequency,
} from '../recurring/helpers';
import type { Transaction } from '../activity/types';

/** Fallback active window for merchants without an explicit frequency. */
const SUB_ACTIVE_DAYS = 40;

type FreqOrIgnore = Frequency | 'ignore';

interface SubRow {
  key: string;
  desc: string;
  last: Transaction;
  daysSinceLast: number;
  count: number;
  charge: number;
  freq: Frequency;
  currency: string;
  monthly: number;
  active: boolean;
}

interface SubInput {
  transactions: Transaction[];
  frequencies: Record<string, FreqOrIgnore>;
}

function detect(data: SubInput): SubRow[] {
  const subs = data.transactions.filter(
    (t) => t.category === 'Subscriptions' && t.amount < 0,
  );
  const byKey = new Map<string, Transaction[]>();
  for (const t of subs) {
    const k = merchantKey(t.description);
    const list = byKey.get(k) ?? [];
    list.push(t);
    byKey.set(k, list);
  }
  const now = Date.now();
  const rows: SubRow[] = [];
  for (const [key, list] of byKey) {
    const userFreq = data.frequencies[key];
    if (userFreq === 'ignore') continue;
    const sorted = list.slice().sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
    const last = sorted[0];
    if (!last) continue;
    const lastTs = new Date(last.date).getTime();
    const daysSinceLast = Math.floor((now - lastTs) / 86400000);
    const freq: Frequency =
      userFreq === 'monthly' || userFreq === 'bimonthly' || userFreq === 'yearly'
        ? userFreq
        : 'monthly';
    const charge = Math.abs(last.amount);
    const activeWindow = RECURRENCE_ACTIVE_DAYS[freq] || SUB_ACTIVE_DAYS;
    rows.push({
      key,
      desc: merchantName(last.description),
      last,
      daysSinceLast,
      count: list.length,
      charge,
      freq,
      currency: last.currency,
      monthly: monthlyEquivalent(charge, freq),
      active: daysSinceLast <= activeWindow,
    });
  }
  return rows;
}

interface Buckets {
  flagged: SubRow[];
  active: SubRow[];
  userCancelled: SubRow[];
  autoLapsed: SubRow[];
}

function bucket(rows: SubRow[], cancelled: Record<string, string>): Buckets {
  const flagged: SubRow[] = [];
  const active: SubRow[] = [];
  const userCancelled: SubRow[] = [];
  const autoLapsed: SubRow[] = [];
  for (const r of rows) {
    const cancelledAt = cancelled[r.key];
    if (cancelledAt) {
      const lastTs = new Date(r.last.date).getTime();
      const cancelledTs = new Date(cancelledAt).getTime();
      if (lastTs > cancelledTs) flagged.push(r);
      else userCancelled.push(r);
      continue;
    }
    if (r.active) active.push(r);
    else autoLapsed.push(r);
  }
  active.sort((a, b) => b.monthly - a.monthly);
  userCancelled.sort((a, b) => a.daysSinceLast - b.daysSinceLast);
  autoLapsed.sort((a, b) => a.daysSinceLast - b.daysSinceLast);
  flagged.sort((a, b) =>
    new Date(b.last.date).getTime() - new Date(a.last.date).getTime(),
  );
  return { flagged, active, userCancelled, autoLapsed };
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

interface SubscriptionsSectionProps {
  transactions: Transaction[];
  frequencies: Record<string, FreqOrIgnore>;
  /** merchantKey → ISO cancellation timestamp. */
  cancelled: Record<string, string>;
}

/**
 * The Subscriptions area of the Fixed bills page. Detects 'Subscriptions'-
 * category charges, groups them into active / cancelled / flagged / lapsed
 * buckets. Presentational — fed by RecurringView's existing data fetch.
 */
export function SubscriptionsSection({ transactions, frequencies, cancelled }: SubscriptionsSectionProps) {
  const rows = detect({ transactions, frequencies });

  if (rows.length === 0) {
    return (
      <section className="subs-section">
        <h2 className="subs-section-title">🔁 Subscriptions</h2>
        <p className="blank">
          🔁 No subscription charges found yet — categorize transactions as
          Subscriptions in Activity to track them here.
        </p>
      </section>
    );
  }

  const { flagged, active, userCancelled, autoLapsed } = bucket(rows, cancelled);
  const monthly = active.reduce((s, r) => s + r.monthly, 0);
  const currency = rows[0]?.currency ?? 'ILS';

  return (
    <section className="subs-section">
      <h2 className="subs-section-title">🔁 Subscriptions</h2>
      <div data-testid="sub-summary" className="sub-summary">
        <div className="sub-big">
          {money(monthly, currency)}<span className="sub-per"> / month</span>
        </div>
        <div className="sub-meta">
          {active.length} active subscription{active.length === 1 ? '' : 's'}
          {userCancelled.length > 0 && <> · {userCancelled.length} cancelled</>}
          {autoLapsed.length > 0 && <> · {autoLapsed.length} likely cancelled</>}
        </div>
      </div>

      {flagged.length > 0 && (
        <section className="sub-section sub-section-warn">
          <h3>⚠ Charged after you marked them cancelled</h3>
          <p className="sub-section-hint">
            A new charge arrived after you marked these cancelled — the
            cancellation may not have gone through. Reconfirm with the merchant.
          </p>
          {flagged.map((r) => <SubRowCard key={r.key} row={r} />)}
        </section>
      )}

      <section className="sub-section">
        <h3>Active</h3>
        {active.length === 0
          ? <p className="blank">No active subscriptions in the last month.</p>
          : active.map((r) => <SubRowCard key={r.key} row={r} />)}
      </section>

      {userCancelled.length > 0 && (
        <section className="sub-section">
          <h3>Cancelled</h3>
          <p className="sub-section-hint">
            You marked these cancelled — Hon flags any new charge.
          </p>
          {userCancelled.map((r) => <SubRowCard key={r.key} row={r} faded />)}
        </section>
      )}

      {autoLapsed.length > 0 && (
        <section className="sub-section">
          <h3>Probably cancelled</h3>
          <p className="sub-section-hint">
            No charge in over a month — likely cancelled.
          </p>
          {autoLapsed.map((r) => <SubRowCard key={r.key} row={r} faded />)}
        </section>
      )}
    </section>
  );
}

function SubRowCard({ row, faded }: { row: SubRow; faded?: boolean }) {
  const subNote = row.freq !== 'monthly'
    ? ` · billed ${row.freq} · ${money(row.charge, row.currency)}`
    : '';
  return (
    <div className={`sub-row${faded ? ' faded' : ''}`}>
      <span className="sub-row-icon">🔁</span>
      <div className="sub-row-main">
        <div className="sub-row-name">{row.desc}</div>
        <div className="sub-row-sub">
          Last charged {fmtDate(row.last.date)}
          {faded && <> · {row.daysSinceLast} days ago</>}
          {!faded && row.count > 1 && <> · {row.count} charges</>}
          {subNote}
        </div>
      </div>
      <div className="sub-amt">
        {money(row.monthly, row.currency)}
        <span className="sub-per">/mo</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it (GREEN)** — `cd web && npx vitest run src/subscriptions/SubscriptionsSection.test.tsx` — Expected: PASS (7).

- [ ] **Step 5: Add CSS** — In `web/src/styles.css`, append:

```css
/* Subscriptions area within the Fixed bills page */
.subs-section { margin-top: 30px; }
.subs-section-title {
  font: 800 18px/1 ui-rounded, "SF Pro Rounded", system-ui;
  color: var(--text); letter-spacing: -.2px; margin-bottom: 10px;
}
```

- [ ] **Step 6: Commit**
```bash
git add web/src/subscriptions/SubscriptionsSection.tsx web/src/subscriptions/SubscriptionsSection.test.tsx web/src/styles.css
git commit -m "feat(recurring): extract presentational SubscriptionsSection"
```
(End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`)

---

## Task 2: Wire SubscriptionsSection into RecurringView (dedup + always-render + fetch shape)

**Files:** Modify `web/src/recurring/helpers.ts`, `web/src/recurring/RecurringView.tsx`, `web/src/recurring/RecurringView.test.tsx`.

- [ ] **Step 1: Update the RecurringView test (RED)**

In `web/src/recurring/RecurringView.test.tsx`: the fixture (line ~18) defines a `Subscriptions` category and (lines ~115/119) creates Subscriptions transactions. Read the file. Then:
- Remove/adjust any assertion that expects a **"Subscriptions" category section** in the fixed list (those merchants now live in the subs area).
- Add this spec inside the main describe block (mock fixtures already provide `/transactions`, `/categories`, `/merchant-frequencies`, `/category-splits`, `/subscriptions/cancelled`):

```tsx
  it('shows subscriptions in the Subscriptions area, not as a fixed category section', async () => {
    installFetchMock({
      ...FULL_MOCKS, // the file's shared mock builder; include a Housing txn + a Subscriptions txn
      'GET /api/transactions': () => ({ transactions: [
        { id: 'h1', accountId: 'a', externalId: 'x', date: '2026-05-10', processedDate: null,
          amount: -3000, currency: 'ILS', description: 'Rent', memo: null, kind: null, status: null,
          category: 'Housing', createdAt: '2025-01-01' },
        { id: 'h2', accountId: 'a', externalId: 'x', date: '2026-04-10', processedDate: null,
          amount: -3000, currency: 'ILS', description: 'Rent', memo: null, kind: null, status: null,
          category: 'Housing', createdAt: '2025-01-01' },
        { id: 's1', accountId: 'a', externalId: 'x', date: '2026-05-05', processedDate: null,
          amount: -55, currency: 'ILS', description: 'Netflix', memo: null, kind: null, status: null,
          category: 'Subscriptions', createdAt: '2025-01-01' },
      ] }),
    });
    render(<RecurringView />);
    // Subscriptions render in the subs area…
    const subsArea = (await screen.findByRole('heading', { name: /🔁 Subscriptions/i })).closest('section')!;
    expect(within(subsArea as HTMLElement).getByText('Netflix')).toBeInTheDocument();
    // …and there is no "Subscriptions" category section header in the fixed list.
    expect(screen.queryByRole('heading', { name: /^Subscriptions$/ })).not.toBeInTheDocument();
  });
```

(Match the file's existing fixture/`installFetchMock` helper names — replace `FULL_MOCKS` with whatever the file uses. If the file's transaction mock already includes a Housing recurring pair, reuse it.)

- [ ] **Step 2: Run it (RED)** — `cd web && npx vitest run src/recurring/RecurringView.test.tsx` — Expected: the new spec FAILS (no subs area heading yet); any old "Subscriptions category section" assertions also reflect the change.

- [ ] **Step 3: Change the `cancelled` type in helpers**

In `web/src/recurring/helpers.ts`, the `RecurringData` interface (line ~83) currently has `cancelled: Record<string, boolean>;` (line ~88). Change it to:

```ts
  cancelled: Record<string, string>;
```

(The only consumer, `detectMerchants` line ~137 `if (data.cancelled[r.key]) continue;`, is a truthy check — non-empty timestamp strings stay truthy, so behaviour is unchanged.)

- [ ] **Step 4: Update RecurringView**

In `web/src/recurring/RecurringView.tsx`:

(a) **Import** the section (add after the helpers import block, ~line 13):
```tsx
import { SubscriptionsSection } from '../subscriptions/SubscriptionsSection';
```

(b) **Fetch cancelled as timestamps** — change lines 56-57:
```tsx
        api<{ cancelled: Record<string, boolean> }>('/subscriptions/cancelled')
          .catch(() => ({ cancelled: {} as Record<string, boolean> })),
```
to:
```tsx
        api<{ cancelled: Record<string, string> }>('/subscriptions/cancelled')
          .catch(() => ({ cancelled: {} as Record<string, string> })),
```

(c) **Exclude the Subscriptions category from the fixed rows** — change line ~92:
```tsx
  const { rows } = detected;
```
to:
```tsx
  // Subscriptions render in the dedicated area below, not as a fixed section.
  const rows = detected.rows.filter((r) => r.category !== 'Subscriptions');
```

(d) **Remove the fixed-bills empty early-return** (lines ~93-104, the `if (rows.length === 0) { return (<div className="recurring-view"><h1>Fixed bills</h1><p className="blank">No recurring fixed bills detected yet. …</p></div>); }` block) — delete the whole `if` block. (The subs area must render even when there are no non-subscription fixed bills.)

(e) **Fold the empty case into the main return + render the section.** The main `return (` block (line ~132) renders `<h1>`, intro, `.recurring-totals`, `.recurring-sections`, then `<SplitEditorDialog/>`. Change it so the totals + sections only show when there are rows, and the subs area always renders. Replace from `<p className="set-intro">…</p>` through the closing of `.recurring-sections` (the `</div>` at line ~221) — wrap the totals+sections in `{rows.length === 0 ? <hint> : <>…</>}` — then add the section before `<SplitEditorDialog/>`:

Concretely:
- Right after the intro `<p className="set-intro">…</p>`, insert:
  ```tsx
        {rows.length === 0 ? (
          <p className="blank">
            No recurring fixed bills detected yet. They appear here once a
            fixed-category charge (Housing · Utilities · Insurance · Education ·
            Fees) is seen in two or more billing cycles — or once you set a
            frequency on a charge by hand.
          </p>
        ) : (
          <>
  ```
- Then the existing `<div className="recurring-totals">…</div>` and `<div className="recurring-sections">…</div>` stay as-is.
- After the `.recurring-sections` closing `</div>` (line ~221), close the fragment + ternary and add the section:
  ```tsx
          </>
        )}

        <SubscriptionsSection
          transactions={data.transactions}
          frequencies={data.frequencies}
          cancelled={data.cancelled}
        />
  ```
  (This sits before `<SplitEditorDialog … />`.)

Note: `byCat`, `catOrder`, `grandMonthly`, `dueThisCycle` (lines ~106-130) all derive from the filtered `rows`; with an empty `rows` they compute to empty/0 harmlessly, so they may stay above the `return` unchanged.

- [ ] **Step 5: Run the RecurringView suite (GREEN)** — `cd web && npx vitest run src/recurring/RecurringView.test.tsx` — Expected: PASS (including the new spec). Fix any remaining assertions that referenced a Subscriptions fixed section.

- [ ] **Step 6: Commit**
```bash
git add web/src/recurring/helpers.ts web/src/recurring/RecurringView.tsx web/src/recurring/RecurringView.test.tsx
git commit -m "feat(recurring): render Subscriptions area in Fixed bills; drop dup category"
```

---

## Task 3: Remove the Subscriptions tab + delete SubscriptionsView

**Files:** Modify `web/src/App.tsx`, `web/src/App.test.tsx`; delete `web/src/subscriptions/SubscriptionsView.tsx` + `web/src/subscriptions/SubscriptionsView.test.tsx`.

- [ ] **Step 1: Edit App.tsx** — four edits:

Remove the import (line ~12): delete
```tsx
import { SubscriptionsView } from './subscriptions/SubscriptionsView';
```

In the `Tab` union (lines 15-17), remove `'subscriptions'`:
```tsx
type Tab =
  | 'overview' | 'accounts' | 'activity' | 'recurring'
  | 'piggy' | 'vouchers' | 'loans' | 'insights' | 'settings';
```

In `TABS`, delete the entry:
```tsx
  { id: 'subscriptions', label: 'Subscriptions', emoji: '🔁' },
```

In the render switch, delete line ~203:
```tsx
              {tab === 'subscriptions' && <SubscriptionsView />}
```

- [ ] **Step 2: Delete the old view + its test**
```bash
git rm web/src/subscriptions/SubscriptionsView.tsx web/src/subscriptions/SubscriptionsView.test.tsx
```

- [ ] **Step 3: Update App.test.tsx if needed** — Read `web/src/App.test.tsx`. If it asserts the tab list or renders the Subscriptions tab, update it to expect the 9-tab list without Subscriptions (and remove any Subscriptions-tab navigation assertion). If it makes no such assertion, no change.

- [ ] **Step 4: Full suite + typecheck**
Run: `cd web && npm test` — Expected: all pass (no orphaned references to `SubscriptionsView`).
Run: `cd web && npm run typecheck` — Expected: clean.

- [ ] **Step 5: Commit**
```bash
git add web/src/App.tsx web/src/App.test.tsx
git commit -m "feat(recurring): remove Subscriptions nav tab (merged into Fixed bills)"
```

---

## Task 4: Live verification (PROJECT-RULES §2 — required gate, not a code task)

> No commit. Do NOT call `preview_start`. Run a worktree vite (`<worktree>/web`, free port) against the live engine on `:4000` (which has real Subscriptions + fixed-bill data), verify via chrome-devtools, read screenshots back.

- [ ] **Step 1:** Symlink node_modules if missing; `npx vite --port <free> --strictPort` from `<worktree>/web`. Read token from `<dataDir>/dev-token`. Connect chrome-devtools (CDP 9222).
- [ ] **Step 2:** Open the app, go to **Fixed bills**. Screenshot: fixed-bills summaries + non-subscription category sections on top, then the "🔁 Subscriptions" area with its buckets below. Confirm **no** "Subscriptions" category section appears in the fixed list (subs only in the area).
- [ ] **Step 3:** Confirm the sidebar has **no** Subscriptions tab.
- [ ] **Step 4:** Stop the worktree vite; close the throwaway page.

---

## Self-Review

**1. Spec coverage:** SubscriptionsSection extraction (Task 1); RecurringView renders it from shared fetch + drops the dup category + summaries exclude subs (Task 2); cancelled timestamp shape (Task 2 Step 3); always-render section even with no fixed bills (Task 2 Step 4d/e); remove tab + delete view + migrate tests (Tasks 1 & 3); verification (Task 4). All covered.

**2. Placeholder scan:** Full component + full migrated test are inline. The two "match the file's existing mock helper / read App.test" steps are concrete edits bounded by exact expected outcomes (no Subscriptions section; 9-tab list), not TBDs.

**3. Type consistency:** `SubscriptionsSection` props `{ transactions: Transaction[]; frequencies: Record<string, FreqOrIgnore>; cancelled: Record<string, string> }` — used identically in the component (Task 1), its test (Task 1), and the RecurringView call site (Task 2 Step 4e). `RecurringData.cancelled: Record<string,string>` (Task 2 Step 3) matches the fetch (Step 4b) and the prop passed (Step 4e). `detect` takes `{ transactions, frequencies }` (`SubInput`) — called with that exact shape. `Tab` union loses `'subscriptions'` consistently across type, TABS, and render branch (Task 3).
