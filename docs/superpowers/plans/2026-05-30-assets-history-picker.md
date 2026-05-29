# Assets History Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the per-connection History control only on Banks + Credit-cards cards, and replace its native `<select>` with a custom dark Radix dropdown.

**Architecture:** Pure-UI change in `web/`. A new controlled `HistoryMonthsSelect` (built on `@radix-ui/react-dropdown-menu`, mirroring the existing PiggyView kebab menu) replaces the native `<select>` at `AccountsView.tsx:773`. A `showHistory` boolean threaded from `renderSectionItems` (which already knows each card's `AssetSectionKey`) gates the control to `bank`/`card` sections. The `historyMonths` field, `setHistoryMonths` optimistic-PATCH flow, and `PATCH /connections/:id/history-months` are untouched.

**Tech Stack:** React 19 + TS strict, `@radix-ui/react-dropdown-menu` (already a dependency), Vitest + Testing-Library + userEvent, global `web/src/styles.css`.

**Spec:** `docs/superpowers/specs/2026-05-30-assets-history-picker-design.md`

---

## File Structure

- **Create** `web/src/accounts/HistoryMonthsSelect.tsx` — the dropdown component + `HISTORY_MONTHS_OPTIONS` constant. One responsibility: render a styled month-window picker, call `onChange` on select.
- **Create** `web/src/accounts/HistoryMonthsSelect.test.tsx` — unit tests for the component.
- **Modify** `web/src/accounts/AccountsView.tsx` — import the component; add `showHistory` to `ConnectionCardProps`; thread it from `renderSectionItems`; swap the native `<select>` block for the component, gated.
- **Modify** `web/src/styles.css` — add `.history-trigger` + active-item styles; drop the now-dead `.conn-history-select.mini` rule.
- **Modify** `web/src/accounts/AccountsView.test.tsx` — rewrite the 3 `history months select` tests to drive the dropdown; add a present/absent-per-section test.

Reference facts (verified in the live tree):
- Radix menu pattern to mirror: `web/src/piggy/PiggyView.tsx:200-218`; proven test pattern: `web/src/piggy/PiggyView.test.tsx:163-165` (`user.click(trigger)` → `findByRole('menuitem')`).
- jsdom pointer polyfills already present: `web/src/test/setup.ts:10-20`.
- CSS vars available: `--accent` `#fcb932`, `--accent-soft` `rgba(252,185,50,0.16)`, `--card-hi`, `--hairline`, `--text`, `--muted`. Reusable menu CSS: `.menu-content` / `.menu-item` / `.menu-item[data-highlighted]` at `styles.css:1570-1583`. Base button + `button.mini` at `styles.css:190-205,632`.

---

## Task 1: HistoryMonthsSelect component

**Files:**
- Create: `web/src/accounts/HistoryMonthsSelect.tsx`
- Test: `web/src/accounts/HistoryMonthsSelect.test.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write the failing test**

Create `web/src/accounts/HistoryMonthsSelect.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HistoryMonthsSelect } from './HistoryMonthsSelect';

describe('HistoryMonthsSelect', () => {
  it('renders the current value in the trigger', () => {
    render(<HistoryMonthsSelect value={12} onChange={() => {}} />);
    expect(screen.getByLabelText(/history months/i)).toHaveTextContent('12 mo');
  });

  it('opens a menu listing all five options', async () => {
    const user = userEvent.setup();
    render(<HistoryMonthsSelect value={12} onChange={() => {}} />);
    await user.click(screen.getByLabelText(/history months/i));
    for (const n of [3, 6, 12, 18, 24]) {
      expect(await screen.findByRole('menuitem', { name: `${n} mo` })).toBeInTheDocument();
    }
  });

  it('fires onChange with the chosen number of months', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HistoryMonthsSelect value={12} onChange={onChange} />);
    await user.click(screen.getByLabelText(/history months/i));
    await user.click(await screen.findByRole('menuitem', { name: '24 mo' }));
    expect(onChange).toHaveBeenCalledWith(24);
  });

  it('marks the active option', async () => {
    const user = userEvent.setup();
    render(<HistoryMonthsSelect value={6} onChange={() => {}} />);
    await user.click(screen.getByLabelText(/history months/i));
    expect(await screen.findByRole('menuitem', { name: '6 mo' })).toHaveAttribute('data-active', 'true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/accounts/HistoryMonthsSelect.test.tsx`
Expected: FAIL — `Failed to resolve import "./HistoryMonthsSelect"`.

- [ ] **Step 3: Write the component**

Create `web/src/accounts/HistoryMonthsSelect.tsx`:

```tsx
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

/** Sync-window presets, in months. Mirrors the legacy native <select>. */
export const HISTORY_MONTHS_OPTIONS = [3, 6, 12, 18, 24] as const;

interface HistoryMonthsSelectProps {
  value: number;
  onChange: (months: number) => void;
  disabled?: boolean;
}

/**
 * Per-connection sync-window picker. A custom Radix dropdown (not a native
 * <select>) so the open menu matches the dark theme. Controlled: the parent
 * owns `value` and persists `onChange` via PATCH /history-months.
 */
export function HistoryMonthsSelect({ value, onChange, disabled }: HistoryMonthsSelectProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="mini history-trigger"
          aria-label="History months"
          disabled={disabled}
        >
          {value} mo
          <span className="hist-chev" aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" sideOffset={4} align="end">
          {HISTORY_MONTHS_OPTIONS.map((n) => (
            <DropdownMenu.Item
              key={n}
              className="menu-item"
              data-active={n === value}
              onSelect={() => onChange(n)}
            >
              <span className="hist-check" aria-hidden="true">{n === value ? '✓' : ' '}</span>
              {n} mo
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
```

Note: the check/spacer span is `aria-hidden`, so each item's accessible name stays exactly `"<n> mo"` (the menuitem-name assertions depend on this).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/accounts/HistoryMonthsSelect.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Add styling, remove the dead select rule**

In `web/src/styles.css`, replace the `.conn-history-select.mini` rule (lines ~643-646):

```css
.conn-history-select.mini {
  padding: 2px 4px;
  font: inherit;
}
```

with:

```css
.conn-history-text { color: var(--muted); }
.history-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.history-trigger .hist-chev {
  font-size: 9px;
  color: var(--muted);
  transition: transform 0.15s ease;
}
.history-trigger[data-state="open"] .hist-chev { transform: rotate(180deg); }
.menu-item .hist-check { display: inline-block; width: 0.9em; }
.menu-item[data-active="true"] {
  background: var(--accent-soft);
  color: var(--accent);
}
@media (prefers-reduced-motion: reduce) {
  .history-trigger .hist-chev { transition: none; }
}
```

(The `.conn-history-label` rule above it stays as-is — it's still the wrapper. `.history-trigger` reuses `button.mini` for padding/border/radius/bg so it lines up with Sync/Remove.)

- [ ] **Step 6: Commit**

```bash
git add web/src/accounts/HistoryMonthsSelect.tsx web/src/accounts/HistoryMonthsSelect.test.tsx web/src/styles.css
git commit -m "feat(assets): HistoryMonthsSelect — custom dark dropdown for sync window"
```

---

## Task 2: Gate the control to Banks + Cards and wire in the dropdown

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` (import ~line 9; `ConnectionCardProps` ~719; `renderSectionItems` ~708; card render ~772)
- Modify: `web/src/accounts/AccountsView.test.tsx` (history-months describe ~1205; add present/absent test)

- [ ] **Step 1: Rewrite the failing tests**

In `web/src/accounts/AccountsView.test.tsx`, replace the entire `describe('connection card — history months select', …)` block (lines ~1205-1258) with:

```tsx
describe('connection card — history months picker', () => {
  const baseFixtureMocks = (historyMonths: number, patchSpy?: (body: unknown) => unknown) => ({
    'GET /api/companies': () => ({ companies: [{ id: 'hapoalim', name: 'Hapoalim', loginFields: ['username', 'password'], type: 'bank', interactive: true }] }),
    'GET /api/connections': () => ({ connections: [{
      id: 'c-bank-1', companyId: 'hapoalim', displayName: 'Hapoalim',
      createdAt: '2026-01-01T00:00:00Z', lastScrapeAt: null, lastStatus: null,
      hasCredentials: true, historyMonths,
    }] }),
    'GET /api/accounts': () => ({ accounts: [] }),
    'GET /api/assets': () => ({ assets: [] }),
    'GET /api/loans': () => ({ loans: [] }),
    'GET /api/brokerage': () => ({ holdings: [] }),
    ...(patchSpy ? { 'PATCH /api/connections/c-bank-1/history-months': patchSpy } : {}),
  });

  it('renders the history trigger with the current value', async () => {
    installFetchMock(baseFixtureMocks(18));
    render(<AccountsView />);
    const trigger = await screen.findByLabelText(/history months/i);
    expect(trigger).toHaveTextContent('18 mo');
  });

  it('selecting a value PATCHes /connections/:id/history-months', async () => {
    const user = userEvent.setup();
    const patchCalls: unknown[] = [];
    const patchSpy = (body: unknown): Promise<unknown> => {
      patchCalls.push(body);
      return Promise.resolve({
        connection: {
          id: 'c-bank-1', companyId: 'hapoalim', displayName: 'Hapoalim',
          createdAt: '2026-01-01T00:00:00Z', lastScrapeAt: null, lastStatus: null,
          hasCredentials: true, historyMonths: 6,
        },
      });
    };
    installFetchMock(baseFixtureMocks(12, patchSpy));
    render(<AccountsView />);
    await user.click(await screen.findByLabelText(/history months/i));
    await user.click(await screen.findByRole('menuitem', { name: '6 mo' }));
    await waitFor(() => expect(patchCalls.length).toBeGreaterThan(0));
    expect(patchCalls[0]).toEqual({ historyMonths: 6 });
  });

  it('reverts the trigger value when PATCH fails', async () => {
    const user = userEvent.setup();
    const patchSpy = (_body: unknown): Promise<unknown> =>
      Promise.reject(new ApiError('historyMonths must be an integer in [1, 24]', 400));
    installFetchMock(baseFixtureMocks(12, patchSpy));
    render(<AccountsView />);
    const trigger = await screen.findByLabelText(/history months/i);
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: '6 mo' }));
    // optimistic update flips to 6, PATCH rejects, value reverts to 12
    await waitFor(() => expect(trigger).toHaveTextContent('12 mo'));
  });

  it('shows the History control only on bank and card cards, not pension or brokerage', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    const bankCard = (await screen.findByText('Hapoalim main')).closest('article') as HTMLElement;
    const cardCard = screen.getByText('Max card').closest('article') as HTMLElement;
    const brkCard = screen.getByText('IBKR').closest('article') as HTMLElement;
    const penCard = screen.getByText('Harel pension').closest('article') as HTMLElement;
    expect(within(bankCard).getByLabelText(/history months/i)).toBeInTheDocument();
    expect(within(cardCard).getByLabelText(/history months/i)).toBeInTheDocument();
    expect(within(brkCard).queryByLabelText(/history months/i)).not.toBeInTheDocument();
    expect(within(penCard).queryByLabelText(/history months/i)).not.toBeInTheDocument();
  });
});
```

(`FULL`, `within`, `ApiError`, `userEvent`, `waitFor` are already imported/defined at the top of this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/accounts/AccountsView.test.tsx -t "history months picker"`
Expected: FAIL — the `menuitem` queries find nothing (still a native `<select>`), and the brokerage/pension card still renders the control so the present/absent test fails.

- [ ] **Step 3: Wire the component into AccountsView**

In `web/src/accounts/AccountsView.tsx`:

(a) Add the import near the other `./` accounts imports (after the `SnapTradeBrokeragePicker` import, ~line 9):

```tsx
import { HistoryMonthsSelect } from './HistoryMonthsSelect';
```

(b) Add `showHistory` to `ConnectionCardProps` (~line 719):

```tsx
interface ConnectionCardProps {
  connection: Connection;
  company?: Company;
  accounts: Account[];
  callbacks: RowCallbacks;
  showHistory: boolean;
}
```

(c) Thread it from `renderSectionItems` — in the `<ConnectionCard …/>` JSX (~line 708) add the prop:

```tsx
      <ConnectionCard
        key={c.id}
        connection={c}
        company={data.companies.find((x) => x.id === c.companyId)}
        accounts={data.accounts.filter((a) => a.connectionId === c.id)}
        callbacks={cb}
        showHistory={key === 'bank' || key === 'card'}
      />
```

(d) Destructure it in the component signature (~line 726):

```tsx
function ConnectionCard({ connection, company, accounts, callbacks, showHistory }: ConnectionCardProps) {
```

(e) Replace the native-select history block (~lines 772-788):

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

with:

```tsx
            {connection.hasCredentials && showHistory && (
              <span className="conn-history-label">
                <span className="conn-history-text">History</span>
                <HistoryMonthsSelect
                  value={connection.historyMonths}
                  onChange={(m) => callbacks.onSetHistoryMonths(connection, m)}
                />
              </span>
            )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/accounts/AccountsView.test.tsx`
Expected: PASS (the full AccountsView suite, including the rewritten `history months picker` block).

- [ ] **Step 5: Full suite + typechecks**

Run: `cd web && npm test`
Expected: PASS (all web tests).
Run: `cd web && npm run typecheck`
Expected: clean.
Run: `cd sidecar && npm test && npm run typecheck`
Expected: PASS + clean (sidecar untouched — sanity only).

- [ ] **Step 6: Commit**

```bash
git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx
git commit -m "feat(assets): gate History picker to banks+cards; swap native select for HistoryMonthsSelect"
```

---

## Task 3: Visual verification (PROJECT-RULES §2 — required gate, not a code task)

> No commit. A UI change is NOT done until chrome-devtools has loaded the live app and a screenshot confirms the render. The dev server is Shahar's own (`cd Hon && npm run dev`) — do NOT call `preview_start`. If the worktree's vite isn't what's serving `:5173`, run vite from `<worktree>/web` (see HANDOFF "Vite root gotcha") or verify against the running instance once the branch is merged/checked out.

- [ ] **Step 1:** Ensure chrome-devtools MCP is connected (launch headed Chrome with CDP on 9222 per PROJECT-RULES §2 if needed). Read the dev token: `cat "$HOME/Library/Application Support/Hon/dev-token"`.
- [ ] **Step 2:** Navigate to `http://localhost:5173/#token=<TOKEN>`, open the Assets tab. `navigate_page { type: "reload", ignoreCache: true }`.
- [ ] **Step 3:** Screenshot a Banks (and Credit-cards) card — confirm the restyled trigger aligns with Sync/Remove. Click it; screenshot the open menu — confirm a dark custom menu (no OS-native list) with the active option in amber. `Read` the screenshots.
- [ ] **Step 4:** Screenshot a Pension card and the IBKR/Investments card — confirm the History control is gone.
- [ ] **Step 5:** Select a different value; confirm the trigger updates and (re-open) the new option is active. If anything's off, debug via `evaluate_script` (`getComputedStyle`) — don't guess at CSS.

---

## Self-Review

**1. Spec coverage** — Goal 1 (gate to bank/card) → Task 2 (showHistory + present/absent test). Goal 2 (custom dropdown) → Task 1 (component + CSS). Non-goal "mechanism stays" → no engine/endpoint/state edits; `onSetHistoryMonths` reused verbatim. Tests → Tasks 1 & 2. Verification → Task 3. All covered.

**2. Placeholder scan** — no TBD/TODO; every code step shows full code; commands have expected output. Clean.

**3. Type consistency** — `HistoryMonthsSelect` props `{ value: number; onChange: (months: number) => void; disabled?: boolean }` used identically in Task 1 and Task 2(e). `HISTORY_MONTHS_OPTIONS = [3,6,12,18,24]` matches the native `<option>`s being replaced and the menuitem-name assertions. `showHistory: boolean` declared (2b), passed (2c), consumed (2d). `onSetHistoryMonths(connection, m)` matches the existing `RowCallbacks` signature (`AccountsView.tsx:640`). Consistent.
