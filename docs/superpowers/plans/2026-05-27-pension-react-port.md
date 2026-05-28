# Pension flow → React port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pension tile in `web/src/accounts/AccountsView.tsx` functional with feature parity to the legacy `sidecar/public/app.html` pension flow — scraped funds, interactive (visible-window) funds, and custom (manual-entry) pensions.

**Architecture:** New `{ kind: 'pension' }` variant on the existing `PickerStep` discriminated union, backed by a dedicated `PensionPickerStep` component. Custom-pension path adds a `'manual-pension'` literal to the existing `AddFlow` union, rendering the existing `AddManualAssetForm` with a new `initialKind` prop. Interactive-fund UI is a lazy-loaded `InteractiveSignInModal` mounted by `AccountsView` whenever a `running` sync is observed on a `company.interactive === true` connection. Engine code untouched.

**Tech Stack:** React 19 + TypeScript strict (web/), Vitest + Testing Library, `installFetchMock` in `web/src/test/mockFetch.ts`, Radix UI primitives, lazy-load pattern matching the existing `SnapTradeLinkFlow` import in `AccountsView.tsx:11`.

**Source spec:** [`docs/superpowers/specs/2026-05-27-pension-react-port-design.md`](../specs/2026-05-27-pension-react-port-design.md) (committed `6cf0547`, amended `47711ee`, `68b9736`).

**Worktree:** `.claude/worktrees/pension-react-port-2026-05-27` on branch `session/pension-react-port-2026-05-27`. All commands assume cwd is the worktree root.

---

## File structure

| Path | Purpose | Status |
|---|---|---|
| `web/src/accounts/AccountsView.tsx` | Add `'manual-pension'` to `AddFlow`; render `AddManualAssetForm` with preset; drop `comingSoon` from pension tile; add pension click branch; wire `PensionPickerStep` step variant; render `InteractiveSignInModal` when running-and-interactive | MODIFIED |
| `web/src/accounts/PensionPickerStep.tsx` | Dedicated pension picker — list providers w/ auto vs browser-window tags + custom row. Export `PensionProviderRow` sub-component (customization seam). | NEW |
| `web/src/accounts/PensionPickerStep.test.tsx` | Unit tests — filtering, tags, callbacks, empty state | NEW |
| `web/src/accounts/InteractiveSignInModal.tsx` | Modal shown during interactive-fund sync. Lazy-loadable; `hints?` slot for per-provider tips. | NEW |
| `web/src/accounts/InteractiveSignInModal.test.tsx` | Unit tests — render gating, close callback, hints slot | NEW |
| `web/src/accounts/AccountsView.test.tsx` | Replace disabled-tile test with enabled-flow tests; add interactive-modal lifecycle test; add custom-pension end-to-end test | MODIFIED |
| `web/src/styles.css` | (Possibly) add `.pension-tag`, `.pension-tag--auto`, `.pension-tag--manual`, `.custom-pension-row` for the picker — only if existing `.pick-row` family is insufficient. | MAYBE MODIFIED |

**Engine + sidecar code: untouched.**

---

## Task ordering rationale

Tasks ordered for **long-run customization, look, and scaling**:

1. **Innermost units first.** `AddManualAssetForm` extension (smallest, no UI flow logic) → `PensionPickerStep` (pure render + callbacks) → `InteractiveSignInModal` (pure render + dismiss).
2. **Then wire** each into `AccountsView` one at a time, with the e2e test as the failing target.
3. **Visual verification** as a separate, non-commit checklist before declaring done.
4. **HANDOFF.md** update is the final commit, so it reflects everything that actually shipped.

Each task is independently revertable. No bundled commits.

---

### Task 1: Extend `AddManualAssetForm` with an `initialKind` prop

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` (the `AddManualAssetForm` component, ~lines 1480-1547, and its props interface ~lines 1482-1485)
- Test: `web/src/accounts/AccountsView.test.tsx` (new test in the existing "Add an asset" describe block)

- [ ] **Step 1: Add a failing test for the `initialKind` prop**

Append to `web/src/accounts/AccountsView.test.tsx` inside the most relevant `describe` (look for the existing `describe('AccountsView — add asset picker', …)` — if absent, create a new sibling `describe('AddManualAssetForm — initialKind prop', …)`):

```tsx
import { AddManualAssetForm } from './AccountsView';

describe('AddManualAssetForm — initialKind prop', () => {
  it('defaults the Kind dropdown to "cash" when no initialKind is given', () => {
    installFetchMock({});
    render(<AddManualAssetForm onClose={() => {}} onSaved={async () => {}} />);
    const kind = screen.getByLabelText(/kind/i) as HTMLSelectElement;
    expect(kind.value).toBe('cash');
  });

  it('preselects the Kind dropdown to the provided initialKind', () => {
    installFetchMock({});
    render(
      <AddManualAssetForm
        initialKind="pension"
        onClose={() => {}}
        onSaved={async () => {}}
      />,
    );
    const kind = screen.getByLabelText(/kind/i) as HTMLSelectElement;
    expect(kind.value).toBe('pension');
  });
});
```

(If `AddManualAssetForm` is not exported, add `export` to its `function` declaration in `AccountsView.tsx` — see Step 3. The test will fail to compile until then.)

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd web && npm run test -- --run AccountsView.test
```

Expected: at least one of the two new tests fails — either with a TS/import error (if not yet exported) or a value mismatch (if exported but the prop isn't wired).

- [ ] **Step 3: Implement — export `AddManualAssetForm` and add the prop**

In `web/src/accounts/AccountsView.tsx`:

1. Add `export` to the function:
   ```ts
   export function AddManualAssetForm({ onClose, onSaved, initialKind }: AddManualAssetFormProps) {
   ```
2. Extend the props interface:
   ```ts
   interface AddManualAssetFormProps {
     onClose: () => void;
     onSaved: () => void | Promise<void>;
     /** Preselects the Kind dropdown. Defaults to 'cash'. Used by the pension
      *  picker's "Custom pension account" row to land on the right kind. */
     initialKind?: string;
   }
   ```
3. Use it in the `useState`:
   ```ts
   const [kind, setKind] = useState(initialKind ?? 'cash');
   ```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd web && npm run test -- --run AccountsView.test
```

Expected: both new tests pass. No other tests regress.

- [ ] **Step 5: Run typecheck**

```bash
cd web && npm run typecheck
```

Expected: clean (no new errors).

- [ ] **Step 6: Commit**

```bash
git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx
git commit -m "$(cat <<'EOF'
web: AddManualAssetForm accepts initialKind prop

Lets callers preselect the Kind dropdown. Default behavior
unchanged ('cash'). Pension picker's "Custom pension account"
row will pass 'pension' so the user lands on the right kind.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create `PensionPickerStep` component and tests

**Files:**
- Create: `web/src/accounts/PensionPickerStep.tsx`
- Create: `web/src/accounts/PensionPickerStep.test.tsx`

- [ ] **Step 1: Write the failing test file**

Create `web/src/accounts/PensionPickerStep.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PensionPickerStep } from './PensionPickerStep';
import type { Company } from './types';

const companies: Company[] = [
  { id: 'hapoalim', name: 'Bank Hapoalim', loginFields: ['id', 'password'], type: 'bank' },
  { id: 'migdal',  name: 'Migdal',  loginFields: ['id'], type: 'pension' },
  { id: 'harel',   name: 'Harel',   loginFields: ['id'], type: 'pension' },
  { id: 'meitav',  name: 'Meitav',  loginFields: ['id', 'phone'], type: 'pension', interactive: true },
];

describe('PensionPickerStep', () => {
  it('renders one row per pension company; non-pension companies excluded', () => {
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /migdal/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /harel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /meitav/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bank hapoalim/i })).not.toBeInTheDocument();
  });

  it('tags non-interactive providers as Automatic', () => {
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    const migdalRow = screen.getByRole('button', { name: /migdal/i });
    expect(within(migdalRow).getByText(/automatic/i)).toBeInTheDocument();
  });

  it('tags interactive providers as needing a browser window', () => {
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    const meitavRow = screen.getByRole('button', { name: /meitav/i });
    expect(within(meitavRow).getByText(/browser window/i)).toBeInTheDocument();
  });

  it('renders a trailing "Custom pension account" row', () => {
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /custom pension account/i })).toBeInTheDocument();
  });

  it('calls onPickCompany with the picked provider', async () => {
    const user = userEvent.setup();
    const onPickCompany = vi.fn();
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={onPickCompany}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /harel/i }));
    expect(onPickCompany).toHaveBeenCalledTimes(1);
    const harel = companies.find((c) => c.id === 'harel')!;
    expect(onPickCompany).toHaveBeenCalledWith(harel);
  });

  it('calls onPickCustom when the custom row is clicked', async () => {
    const user = userEvent.setup();
    const onPickCustom = vi.fn();
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={onPickCustom}
        onBack={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /custom pension account/i }));
    expect(onPickCustom).toHaveBeenCalledTimes(1);
  });

  it('calls onBack when the back button is clicked', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <PensionPickerStep
        companies={companies}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={onBack}
      />,
    );
    await user.click(screen.getByRole('button', { name: /all categories/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders only the custom row + a hint when no pension companies exist', () => {
    render(
      <PensionPickerStep
        companies={companies.filter((c) => c.type !== 'pension')}
        onPickCompany={() => {}}
        onPickCustom={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /custom pension account/i })).toBeInTheDocument();
    expect(screen.getByText(/no scraped providers/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd web && npm run test -- --run PensionPickerStep.test
```

Expected: every test fails to import `PensionPickerStep` (file doesn't exist yet).

- [ ] **Step 3: Implement `PensionPickerStep.tsx`**

Create `web/src/accounts/PensionPickerStep.tsx`:

```tsx
import type { Company } from './types';

interface PensionPickerStepProps {
  /** All companies known to the engine. The component filters internally to
   *  type==='pension' so callers don't have to. */
  companies: Company[];
  /** Picked a scraped fund → caller closes the picker and opens the existing
   *  AddConnectionForm with this company (same as the bank/card flow). */
  onPickCompany: (company: Company) => void;
  /** Picked "Custom pension account" → caller closes the picker and opens
   *  AddManualAssetForm with initialKind='pension'. */
  onPickCustom: () => void;
  /** Back to the category picker. */
  onBack: () => void;
}

/**
 * Dedicated pension picker. Lists scraped providers with an auto vs
 * browser-window tag, and a trailing "Custom pension account" row for
 * providers Hon can't scrape (e.g. Altshuler, or any future fund the
 * engine hasn't been taught to read).
 *
 * The row markup is delegated to `PensionProviderRow` so future
 * per-provider variants (e.g. a Migdal row that previews retirement
 * projection) can be swapped in without rewriting the picker itself.
 */
export function PensionPickerStep(
  { companies, onPickCompany, onPickCustom, onBack }: PensionPickerStepProps,
) {
  const pensionCompanies = companies.filter((c) => c.type === 'pension');
  return (
    <>
      <h2>Pension &amp; savings</h2>
      <button
        type="button"
        className="back-btn"
        onClick={onBack}
      >‹ All categories</button>
      <p className="hint">
        Connect a provider once — Hon pulls every retirement product you
        hold there together: pension (<bdi>פנסיה</bdi>), gemel / provident
        fund (<bdi>קופת גמל</bdi>) and study fund / keren hishtalmut
        (<bdi>קרן השתלמות</bdi>). Or add a custom account and enter the
        balance yourself.
      </p>
      <ul className="add-picker">
        {pensionCompanies.length === 0 && (
          <li className="hint">No scraped providers available.</li>
        )}
        {pensionCompanies.map((c) => (
          <PensionProviderRow
            key={c.id}
            company={c}
            onPick={() => onPickCompany(c)}
          />
        ))}
        <li>
          <button
            type="button"
            className="add-picker-item add-picker-item--custom"
            onClick={onPickCustom}
          >
            <span className="add-picker-emoji" aria-hidden="true">✍️</span>
            <span className="add-picker-name">Custom pension account</span>
            <span className="add-picker-sub">
              Type the provider and balance yourself — for any fund Hon
              can't sync
            </span>
          </button>
        </li>
      </ul>
    </>
  );
}

interface PensionProviderRowProps {
  company: Company;
  onPick: () => void;
}

/**
 * One row in the pension picker. Exported so future variants can swap it
 * in per provider (e.g. richer Migdal preview) without forking
 * `PensionPickerStep` itself.
 */
export function PensionProviderRow(
  { company, onPick }: PensionProviderRowProps,
) {
  const interactive = Boolean(company.interactive);
  return (
    <li>
      <button
        type="button"
        className="add-picker-item"
        onClick={onPick}
      >
        <span className="add-picker-name">{company.name}</span>
        <span className="add-picker-sub">
          {interactive
            ? 'A browser window opens on each sync to clear a security check'
            : 'Synced automatically in the background'}
        </span>
        <span
          className={
            interactive
              ? 'pension-tag pension-tag--manual'
              : 'pension-tag pension-tag--auto'
          }
        >
          {interactive ? 'Browser window' : 'Automatic'}
        </span>
      </button>
    </li>
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd web && npm run test -- --run PensionPickerStep.test
```

Expected: all 8 tests pass.

- [ ] **Step 5: Run typecheck**

```bash
cd web && npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/accounts/PensionPickerStep.tsx web/src/accounts/PensionPickerStep.test.tsx
git commit -m "$(cat <<'EOF'
web: PensionPickerStep — dedicated picker for pension flow

Renders pension companies as scraped-provider rows (with Automatic
vs Browser-window tags) plus a trailing Custom pension account row.
Delegates the row markup to an exported PensionProviderRow so future
per-provider variants can swap in without forking the picker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire `PensionPickerStep` into `AddConnectionPicker` and enable the pension tile

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` — `PickerStep` union (~line 1170), `PICKER_TILES` (~line 1192), `AddConnectionPickerProps` (~line 1160), `renderCategoryStep` onClick (~line 1230), `renderStep` switch (~line 1303), `AccountsView` parent's `<AddConnectionPicker>` props (~line 434)
- Modify: `web/src/accounts/AccountsView.test.tsx` — replace the existing disabled-pension-tile assertion

- [ ] **Step 1: Update the test that asserts the pension tile is disabled**

In `web/src/accounts/AccountsView.test.tsx`, find:

```ts
it('the brokerage drilldown shows SnapTrade; Pension and Car tiles render disabled (flows live in legacy)', async () => {
```

Split it into two — Car stays disabled, Pension becomes enabled. Replace the existing test body and add a new sibling test:

```ts
it('the brokerage drilldown shows SnapTrade; Car tile renders disabled (flow lives in legacy)', async () => {
  const user = userEvent.setup();
  installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
  render(<AccountsView />);
  await user.click(await screen.findByRole('button', { name: /add asset/i }));
  const dialog = screen.getByRole('dialog', { name: /add an asset/i });
  // Car tile is visible but disabled until its flow is ported.
  const car = within(dialog).getByRole('button', { name: /car/i });
  expect(car).toBeDisabled();
  // Brokerages tile leads to the SnapTrade drilldown — sanity check left intact.
  await user.click(within(dialog).getByRole('button', { name: /brokerages/i }));
  expect(within(dialog).getByText(/SnapTrade/i)).toBeInTheDocument();
});

it('clicking the Pension tile opens the PensionPickerStep with providers and a custom row', async () => {
  const user = userEvent.setup();
  installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
  render(<AccountsView />);
  await user.click(await screen.findByRole('button', { name: /add asset/i }));
  const dialog = screen.getByRole('dialog', { name: /add an asset/i });
  const pension = within(dialog).getByRole('button', { name: /pension/i });
  expect(pension).not.toBeDisabled();
  await user.click(pension);
  // Expect the PensionPickerStep to render — Harel + custom row + back button.
  expect(within(dialog).getByRole('button', { name: /harel/i })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: /custom pension account/i })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: /all categories/i })).toBeInTheDocument();
});
```

Also confirm `COMPANIES_FULL` includes a pension entry (the existing `harel` entry should already be there from the Pension-section grouping test — verify it has `type: 'pension'`). If not, ensure it does.

- [ ] **Step 2: Run the tests to confirm the new one fails**

```bash
cd web && npm run test -- --run AccountsView.test
```

Expected: the new "clicking the Pension tile opens…" test fails because the tile is still disabled (or, if you've already started edits, the wiring is incomplete).

- [ ] **Step 3: Update `PickerStep` union**

In `AccountsView.tsx`, around line 1170:

```ts
type PickerStep =
  | { kind: 'category' }
  | { kind: 'institution'; category: 'bank' | 'card' }
  | { kind: 'pension' }
  | { kind: 'snaptrade-credentials' }
  | { kind: 'snaptrade-brokerages'; connectionId: string };
```

- [ ] **Step 4: Drop `comingSoon` from the pension tile + wire its click**

In `PICKER_TILES` (~line 1192):

```ts
{ key: 'pension', label: 'Pension & savings', emoji: '🪺',
  subOverride: 'pension, gemel & study fund' },
```

In `renderCategoryStep`'s `onClick` (~line 1235), add the pension branch:

```ts
if (tile.key === 'pension') {
  setStep({ kind: 'pension' });
  return;
}
```

(Place it next to the bank/card branch so the routing is grouped.)

- [ ] **Step 5: Render `PensionPickerStep` from `renderStep`**

Add the import at the top of `AccountsView.tsx`:

```ts
import { PensionPickerStep } from './PensionPickerStep';
```

In the `renderStep` switch (~line 1303), add:

```ts
if (step.kind === 'pension') {
  return (
    <PensionPickerStep
      companies={companies}
      onPickCompany={(c) => onPickCompany(c)}
      onPickCustom={() => onPickManualPension()}
      onBack={() => setStep({ kind: 'category' })}
    />
  );
}
```

- [ ] **Step 6: Extend `AddConnectionPickerProps` with `onPickManualPension`**

In `AccountsView.tsx` (~line 1160):

```ts
interface AddConnectionPickerProps {
  companies: Company[];
  connections: Connection[];
  onPickCompany: (company: Company) => void;
  onPickManualAsset: () => void;
  onPickManualLoan: () => void;
  /** Picker's "Custom pension account" row routes here. Parent maps it to
   *  setAddFlow('manual-pension'), which renders <AddManualAssetForm
   *  initialKind='pension' …/>. */
  onPickManualPension: () => void;
  onPickBrokerage: (connectionId: string, brokerSlug: string, brokerName: string) => void;
  onClose: () => void;
}
```

And destructure `onPickManualPension` in the function signature (~line 1207).

- [ ] **Step 7: Update parent's `<AddConnectionPicker>` to pass `onPickManualPension`**

In `AccountsView.tsx` (~line 434), add the prop:

```ts
<AddConnectionPicker
  companies={data.companies}
  connections={data.connections}
  onPickCompany={(c) => setAddFlow(c)}
  onPickManualAsset={() => setAddFlow('manual-asset')}
  onPickManualLoan={() => setAddFlow('manual-loan')}
  onPickManualPension={() => setAddFlow('manual-pension')}
  onPickBrokerage={(connectionId, brokerSlug, brokerName) => {
    setAddFlow(null);
    setLinkSnapTradeFor({ connectionId, brokerSlug, brokerName });
  }}
  onClose={() => setAddFlow(null)}
/>
```

(Note: `setAddFlow('manual-pension')` won't type-check yet — that's the next task. For now, expect a TS error.)

- [ ] **Step 8: Extend `AddFlow` union**

Find the `AddFlow` type (line 137):

```ts
type AddFlow = null | 'picker' | 'manual-asset' | 'manual-loan' | 'manual-pension' | Company;
```

- [ ] **Step 9: Render `AddManualAssetForm` with `initialKind='pension'` for the new branch**

After the existing `addFlow === 'manual-asset'` branch (~line 444):

```tsx
{addFlow === 'manual-pension' && (
  <AddManualAssetForm
    initialKind="pension"
    onClose={() => setAddFlow(null)}
    onSaved={async () => { setAddFlow(null); await refresh(); }}
  />
)}
```

- [ ] **Step 10: Run tests + typecheck**

```bash
cd web && npm run typecheck && npm run test -- --run AccountsView.test
```

Expected: typecheck clean; both new "Car tile disabled" and "Pension tile opens picker" tests pass; no existing test regresses.

- [ ] **Step 11: Add an end-to-end test for the custom-pension path**

Append in the same describe block:

```ts
it('the "Custom pension account" row routes to AddManualAssetForm with kind=pension preselected', async () => {
  const user = userEvent.setup();
  installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
  render(<AccountsView />);
  await user.click(await screen.findByRole('button', { name: /add asset/i }));
  const dialog = screen.getByRole('dialog', { name: /add an asset/i });
  await user.click(within(dialog).getByRole('button', { name: /pension/i }));
  await user.click(within(dialog).getByRole('button', { name: /custom pension account/i }));
  // The picker should close and AddManualAssetForm should open with kind=pension.
  const assetDialog = await screen.findByRole('dialog', { name: /add a manual asset/i });
  const kind = within(assetDialog).getByLabelText(/kind/i) as HTMLSelectElement;
  expect(kind.value).toBe('pension');
});
```

- [ ] **Step 12: Run the new e2e test**

```bash
cd web && npm run test -- --run AccountsView.test
```

Expected: passes.

- [ ] **Step 13: Commit**

```bash
git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx
git commit -m "$(cat <<'EOF'
web: enable Pension tile, route to dedicated PensionPickerStep

Drops the comingSoon flag from the Pension picker tile, adds a
{ kind: 'pension' } PickerStep variant routed to PensionPickerStep,
and a 'manual-pension' AddFlow literal that renders AddManualAssetForm
preset to kind='pension'.

The Car tile stays disabled (its flow ports separately).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Create `InteractiveSignInModal` component and tests

**Files:**
- Create: `web/src/accounts/InteractiveSignInModal.tsx`
- Create: `web/src/accounts/InteractiveSignInModal.test.tsx`

- [ ] **Step 1: Write the failing test file**

Create `web/src/accounts/InteractiveSignInModal.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InteractiveSignInModal } from './InteractiveSignInModal';
import type { Company } from './types';

const meitav: Company = {
  id: 'meitav', name: 'Meitav', loginFields: ['id', 'phone'],
  type: 'pension', interactive: true,
};

describe('InteractiveSignInModal', () => {
  it('renders the company name in the header', () => {
    render(<InteractiveSignInModal company={meitav} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: /sign in.*meitav/i })).toBeInTheDocument();
  });

  it('renders the sign-in-in-browser-window copy', () => {
    render(<InteractiveSignInModal company={meitav} onClose={() => {}} />);
    expect(screen.getByText(/browser window has opened/i)).toBeInTheDocument();
  });

  it('renders the hints slot when provided', () => {
    render(
      <InteractiveSignInModal
        company={meitav}
        onClose={() => {}}
        hints={<p data-testid="hint">Meitav-specific tip</p>}
      />,
    );
    expect(screen.getByTestId('hint')).toBeInTheDocument();
  });

  it('calls onClose when the Close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<InteractiveSignInModal company={meitav} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd web && npm run test -- --run InteractiveSignInModal.test
```

Expected: every test fails — file doesn't exist yet.

- [ ] **Step 3: Implement `InteractiveSignInModal.tsx`**

Create `web/src/accounts/InteractiveSignInModal.tsx`:

```tsx
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { Company } from './types';

interface InteractiveSignInModalProps {
  /** The pension fund being synced. Used for the modal header. */
  company: Company;
  /** Hides the modal locally without cancelling the engine-side scrape.
   *  The scrape continues until it terminates (success / error /
   *  engine interactive-timeout) on the next poll tick. */
  onClose: () => void;
  /** Optional per-provider hint slot — e.g. Meitav-specific captcha tips.
   *  Customization seam; not currently used by any caller. */
  hints?: ReactNode;
}

/**
 * Shown while a sync is running against an interactive pension fund
 * (Meitav/Menora). The engine pops a visible OS Chromium window the user
 * signs into directly; this modal explains what's happening and gives
 * the user a way to dismiss it without cancelling the scrape.
 *
 * Mount/unmount is fully owned by the parent (AccountsView). The modal
 * does not manage any sync state of its own.
 */
export function InteractiveSignInModal(
  { company, onClose, hints }: InteractiveSignInModalProps,
) {
  return createPortal(
    <div className="overlay">
      <div
        role="dialog"
        aria-label={`Sign in to ${company.name}`}
        className="modal"
      >
        <h2>Signing in to {company.name}</h2>
        <p>
          A browser window has opened — sign in there. Hon will grab your
          balances once you're in.
        </p>
        {hints}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
cd web && npm run test -- --run InteractiveSignInModal.test
```

Expected: all 4 tests pass.

- [ ] **Step 5: Run typecheck**

```bash
cd web && npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/accounts/InteractiveSignInModal.tsx web/src/accounts/InteractiveSignInModal.test.tsx
git commit -m "$(cat <<'EOF'
web: InteractiveSignInModal — UI for visible-window pension sync

Shown while a sync is running against an interactive pension fund
(Meitav/Menora). The engine pops a visible OS Chromium window; this
modal explains what's happening and exposes a Close button that
hides the modal locally without cancelling the engine-side scrape.

hints slot reserved for per-provider tips later (customization seam).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire `InteractiveSignInModal` into `AccountsView` (lifecycle + dismissed-set)

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` — add lazy import, `dismissedInteractiveRunIds` state, second IIFE block next to the existing OtpModal IIFE
- Modify: `web/src/accounts/AccountsView.test.tsx` — add lifecycle test for the modal

- [ ] **Step 1: Write the failing lifecycle test**

In `AccountsView.test.tsx`, find the existing `describe` that covers sync flows (look for the OTP test added earlier, around line 470-540), and append a new test alongside it. The test simulates a running scrape on an interactive pension connection, asserts the modal mounts, then flips the poll to `success` and asserts it unmounts:

```ts
it('mounts InteractiveSignInModal while a scrape runs on an interactive pension connection', async () => {
  const user = userEvent.setup();

  // A poll-side state machine: first GET returns running; once we set
  // `done = true`, GETs return success. POST starts the scrape.
  let done = false;
  installFetchMock({
    ...FULL,
    'GET /api/companies': () => ({
      companies: [
        { id: 'meitav', name: 'Meitav', loginFields: ['id', 'phone'],
          type: 'pension', interactive: true },
      ],
    }),
    'GET /api/connections': () => ({
      connections: [{ id: 'c-meitav-1', companyId: 'meitav',
        displayName: 'Meitav', createdAt: '2026-01-01',
        lastScrapeAt: null, lastStatus: null, hasCredentials: true }],
    }),
    'GET /api/accounts': () => ({ accounts: [] }),
    'POST /api/connections/c-meitav-1/scrape': () => ({ runId: 'r-meitav' }),
    'GET /api/scrape/r-meitav': () =>
      done
        ? ({ run: { status: 'success', message: 'ok' } })
        : ({ run: { status: 'running', message: 'signing in' } }),
  });

  render(<AccountsView />);
  await screen.findByText('Meitav');

  // Trigger sync via the connection card's Sync action.
  // (Adjust selector to match the real test pattern for sync buttons —
  // existing OTP tests in this file show the right one.)
  await user.click(screen.getByRole('button', { name: /sync.*meitav/i }));

  // Modal mounts as soon as the poll observes status=running.
  expect(await screen.findByRole('dialog', { name: /sign in.*meitav/i }))
    .toBeInTheDocument();

  // Flip the poll. Modal should unmount.
  done = true;
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: /sign in.*meitav/i }))
      .not.toBeInTheDocument();
  });
});

it('Close button hides InteractiveSignInModal without cancelling the scrape', async () => {
  const user = userEvent.setup();
  installFetchMock({
    ...FULL,
    'GET /api/companies': () => ({
      companies: [
        { id: 'meitav', name: 'Meitav', loginFields: ['id', 'phone'],
          type: 'pension', interactive: true },
      ],
    }),
    'GET /api/connections': () => ({
      connections: [{ id: 'c-meitav-1', companyId: 'meitav',
        displayName: 'Meitav', createdAt: '2026-01-01',
        lastScrapeAt: null, lastStatus: null, hasCredentials: true }],
    }),
    'GET /api/accounts': () => ({ accounts: [] }),
    'POST /api/connections/c-meitav-1/scrape': () => ({ runId: 'r-meitav' }),
    'GET /api/scrape/r-meitav': () =>
      ({ run: { status: 'running', message: 'signing in' } }),
  });

  render(<AccountsView />);
  await screen.findByText('Meitav');
  await user.click(screen.getByRole('button', { name: /sync.*meitav/i }));
  const dialog = await screen.findByRole('dialog', { name: /sign in.*meitav/i });
  await user.click(within(dialog).getByRole('button', { name: /close/i }));

  // Modal unmounts immediately.
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: /sign in.*meitav/i }))
      .not.toBeInTheDocument();
  });

  // And does NOT re-mount on the next poll tick (still running).
  // Wait a couple of poll intervals (SCRAPE_POLL_INTERVAL_MS=200) to be sure.
  await new Promise((r) => setTimeout(r, 500));
  expect(screen.queryByRole('dialog', { name: /sign in.*meitav/i }))
    .not.toBeInTheDocument();
});
```

(Match the exact Sync-button selector to the convention already used by the existing OTP test for banks — see the file around line 470-510 for the pattern.)

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd web && npm run test -- --run AccountsView.test
```

Expected: both new tests fail — modal isn't being mounted yet.

- [ ] **Step 3: Add the lazy import**

Near the top of `AccountsView.tsx`, alongside `const SnapTradeLinkFlow = lazy(...)`:

```ts
const InteractiveSignInModal = lazy(() =>
  import('./InteractiveSignInModal').then((m) => ({ default: m.InteractiveSignInModal })),
);
```

- [ ] **Step 4: Add the dismissed-runIds state**

In the main `AccountsView` component (alongside other useState declarations), add:

```ts
const [dismissedInteractiveRunIds, setDismissedInteractiveRunIds] =
  useState<Set<string>>(() => new Set());
```

- [ ] **Step 5: Add the modal-rendering IIFE**

Near the bottom of `AccountsView`'s JSX, **directly below the existing OtpModal IIFE** (around line 485-510), add a sibling block:

```tsx
{(() => {
  // Mount one InteractiveSignInModal at a time, for the first connection
  // observed running an interactive sync that the user hasn't dismissed.
  const entry = Object.entries(syncStates).find(([connectionId, s]) => {
    if (s.kind !== 'running') return false;
    if (dismissedInteractiveRunIds.has(s.runId)) return false;
    const conn = data.connections.find((c) => c.id === connectionId);
    if (!conn) return false;
    const company = data.companies.find((c) => c.id === conn.companyId);
    return Boolean(company?.interactive);
  });
  if (!entry) return null;
  const [connectionId, state] = entry;
  if (state.kind !== 'running') return null; // TS narrowing
  const conn = data.connections.find((c) => c.id === connectionId);
  const company = conn && data.companies.find((c) => c.id === conn.companyId);
  if (!conn || !company) return null;
  return (
    <Suspense fallback={null}>
      <InteractiveSignInModal
        company={company}
        onClose={() => {
          setDismissedInteractiveRunIds((prev) => {
            const next = new Set(prev);
            next.add(state.runId);
            return next;
          });
        }}
      />
    </Suspense>
  );
})()}
```

- [ ] **Step 6: Clean up the dismissed set on terminal status**

In `pollRun` (~line 200), in the `success` and `error` branches, drop the runId from the dismissed set. After the existing `setSyncForConnection(connectionId, { kind: 'idle' })` / `{ kind: 'error', ... }` calls:

```ts
setDismissedInteractiveRunIds((prev) => {
  if (!prev.has(runId)) return prev;
  const next = new Set(prev);
  next.delete(runId);
  return next;
});
```

(Add this in both terminal branches — `'success'` and the error path.)

- [ ] **Step 7: Run the tests to confirm they pass**

```bash
cd web && npm run test -- --run AccountsView.test
```

Expected: both new lifecycle tests pass; no regression.

- [ ] **Step 8: Full test pass + typecheck**

```bash
cd web && npm run typecheck && npm run test -- --run
```

Expected: full test suite clean.

- [ ] **Step 9: Commit**

```bash
git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx
git commit -m "$(cat <<'EOF'
web: AccountsView mounts InteractiveSignInModal during interactive sync

When a sync is running on a connection whose company has
interactive=true, AccountsView mounts (lazy-loaded) the modal that
explains the visible-window flow. Close hides the modal locally
via a dismissed-runIds set; the scrape continues engine-side.
Dismissed runIds are cleared when the run terminates (success/error).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Visual verification via chrome-devtools MCP

**This is not a commit step.** It's a verification checklist per PROJECT-RULES §2. Do not claim the feature is done until each path has been screenshotted and the rendering looked right.

- [ ] **Step 1: Start the dev server**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon/.claude/worktrees/pension-react-port-2026-05-27 && npm run dev
```

Confirm engine starts on its port and Vite on 5173. Don't break the user's already-running dev server — if one is already up on those ports, kill it first (`pkill -9 -f 'tsx.*server\.ts|node.*web\.mjs'`).

- [ ] **Step 2: Set up Chrome with CDP on 9222**

If `mcp__chrome-devtools__*` isn't already connected:

```bash
mkdir -p /tmp/chrome-cdp-profile
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-cdp-profile \
  --no-first-run --no-default-browser-check \
  >/tmp/chrome-cdp.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:9222/json/version
```

Expected: a JSON blob with `"Browser": "Chrome/…"`.

- [ ] **Step 3: Read the dev token and open the app**

```bash
cat "$HOME/Library/Application Support/Hon/dev-token"
```

Use the returned token with `mcp__chrome-devtools__new_page`:

```
url: http://localhost:5173/#token=<TOKEN>
```

Take a baseline snapshot: `mcp__chrome-devtools__take_snapshot`.

- [ ] **Step 4: Path A — scraped fund (auto)**

Walk:
1. Click "+ Add asset" → snapshot.
2. Click the **Pension & savings** tile → snapshot. Confirm `PensionPickerStep` rendered, with providers listed (Harel / Migdal / Clal / Meitav / Menora as available in dev DB) + a Custom row at the bottom.
3. Click **Migdal** (or another non-interactive fund) → snapshot. Confirm `AddConnectionForm` opened with the ID field.
4. `mcp__chrome-devtools__take_screenshot { filePath: "/tmp/pension-path-A.png" }`. `Read /tmp/pension-path-A.png`.

- [ ] **Step 5: Path B — interactive fund**

1. Back to Add asset → Pension tile.
2. Click **Meitav** → snapshot. Confirm `AddConnectionForm` shows the interactive-flavour copy (the existing form already adapts on `company.interactive` for banks — verify it does the same for pension).
3. `take_screenshot { filePath: "/tmp/pension-path-B.png" }` → `Read`.

We cannot end-to-end verify the visible-window scrape here without real Meitav credentials. The modal mount/unmount is covered by unit tests.

- [ ] **Step 6: Path C — custom pension**

1. Pension tile → click **Custom pension account** → snapshot. Confirm `AddManualAssetForm` opened with the Kind dropdown showing "Pension".
2. `take_screenshot { filePath: "/tmp/pension-path-C.png" }` → `Read`.

- [ ] **Step 7: Look for regressions in adjacent flows**

- Bank picker still works: Add asset → Banks → pick Hapoalim → credentials form.
- Card picker still works.
- Brokerage drill-down still works.
- Manual asset still works: Add asset → Other asset → kind dropdown defaults to "Cash / savings".
- Loan still works: Add asset → Loan → manual loan form.
- Car tile still disabled.

`take_screenshot` at the picker top-level + 2 sample re-walks to confirm.

- [ ] **Step 8: If anything looks off**

- Don't guess at CSS. Use `mcp__chrome-devtools__evaluate_script` with `getComputedStyle` / DOM walks to inspect what the browser actually sees.
- Read source, fix, commit as a follow-up. Then re-screenshot.

---

### Task 7: HANDOFF.md update

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Read the existing HANDOFF.md**

```bash
sed -n '1,200p' HANDOFF.md
```

- [ ] **Step 2: Update the "What shipped this session" section**

Add a subsection or top-bullet describing this session's delivery. Include:
- The three paths now functional in React.
- The interactive-window modal behavior.
- The customization seams (PensionProviderRow, InteractiveSignInModal `hints` slot, `initialKind` prop on `AddManualAssetForm`).
- **Explicit hand-test required:** real Meitav/Menora end-to-end (visible-window sign-in) cannot be unit-tested; Shahar's credentials are needed.

- [ ] **Step 3: Update "Deferred items"**

- Mark the "Pension flow port to React" item under "Highest-value next steps" as done.
- Add a small follow-up: "Per-provider hints in `InteractiveSignInModal` (e.g. Meitav captcha tip) — seam exists, no real hint yet."
- Add a follow-up: "`AddManualAssetForm` per-kind label tweak ('Amount accumulated' for pension) — deferred from this PR for scope; trivial follow-up."

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md
git commit -m "$(cat <<'EOF'
docs: HANDOFF — pension React port shipped; note hand-test items

Marks the React pension port done in the highest-value-next-steps
list. Calls out the interactive-window flow can't be end-to-end
unit-tested — needs Shahar's real Meitav/Menora credentials. Adds
two small follow-ups (per-provider hints; "Amount accumulated"
label).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (verify before declaring plan done)

- **Spec coverage:**
  - PensionPickerStep with auto/browser-window tags + custom row → Task 2 ✓
  - Scraped-fund connect path uses existing `onPickCompany` → Task 3 ✓
  - Custom-pension path uses `AddManualAssetForm` with `initialKind='pension'` → Tasks 1 + 3 ✓
  - InteractiveSignInModal lazy-loaded via React.lazy → Task 5 ✓
  - Modal mount condition (`running` + `interactive` + not dismissed) → Task 5 ✓
  - Dismissed-runIds cleanup on terminal status → Task 5 ✓
  - Existing OtpSheet handles any pension `needs-otp` (no new code) → spec §"Sync-time errors (automatic funds)" — covered by existing path, no task needed ✓
  - Visual verification via chrome-devtools MCP → Task 6 ✓
  - HANDOFF.md update → Task 7 ✓
- **Type consistency:**
  - `PensionPickerStep` props match across Task 2 (definition), Task 3 (consumer in `AccountsView.tsx`), and Task 6 (visual paths). ✓
  - `InteractiveSignInModal` props match across Task 4 (definition) and Task 5 (lazy mount). ✓
  - `AddManualAssetForm`'s new `initialKind` prop used in Task 1 (def) and Task 3 (consumer). ✓
  - `AddConnectionPicker`'s new `onPickManualPension` callback declared in Task 3 step 6 and used in step 7. ✓
  - `AddFlow` union extension consistent across Task 3 (extend) and Task 3 step 9 (consume). ✓
- **Placeholder scan:** Search the file for `TBD|TODO|FIXME|fill in|details`. Should return only this checklist mention. ✓

## Non-goals (parked, not in this plan)

- Updates to the legacy `sidecar/public/app.html` pension flow.
- Engine-side pension changes (selectors, timeout, scrape-cancel endpoint).
- Pension-specific dashboard widgets (retirement projection, expected payout).
- Per-provider `PensionProviderRow` variants beyond the default.
- Per-kind "Amount accumulated" label tweak in `AddManualAssetForm`.
- A real engine-side scrape cancel endpoint.
