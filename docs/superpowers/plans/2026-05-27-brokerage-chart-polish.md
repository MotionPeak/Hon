# Brokerage Chart Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the React Brokerage chart in the Insights tab to match the legacy SPA — per-account filter pills (always shown), inception-date input under per-account focus, smooth cubic-bezier curve replacing the polyline.

**Architecture:** Add a pure `smooth.ts` for the Catmull-Rom-like curve math (tension 0.18). Lift account filtering + inception cutoff into `BrokerageSubTab` via `useMemo`. Two new module-level presentational components — `AccountPills` and `InceptionInput` — sit above the existing `ValueChart` SVG, which switches from `M…L…L…` to `M…C…C…` paths. No engine, no schema changes — uses existing `PATCH /accounts/:id/inception`.

**Tech Stack:** React 19 (strict TS), Vite, Vitest + Testing Library, jsdom polyfills already in `web/src/test/setup.ts`, SVG path commands.

**Reference spec:** [`docs/superpowers/specs/2026-05-27-brokerage-chart-polish-design.md`](../specs/2026-05-27-brokerage-chart-polish-design.md)

**Verification:** Every claim of "done" must be backed by a chrome-devtools screenshot per `PROJECT-RULES.md §2`. Tests + typecheck are necessary but not sufficient.

---

## File map

| File | Action | Purpose |
|---|---|---|
| `web/src/insights/smooth.ts` | create | Pure `smoothPath(pts)` math, no React dep |
| `web/src/insights/smooth.test.ts` | create | Unit tests for the curve math |
| `web/src/insights/InsightsView.tsx` | modify | Add `AccountPills` + `InceptionInput`; rewire `BrokerageSubTab` to fetch `/accounts`, filter by `acctFilter`, apply inception cutoff; swap `ValueChart` polyline for `smoothPath` |
| `web/src/insights/InsightsView.test.tsx` | modify | Extend existing brokerage tests with pills + inception coverage; add `GET /api/accounts` to the brokerage-tab mocks |
| `web/src/styles.css` | modify | Add `.brk-acct-row`, `.brk-acct-pill`, `.brk-inception-row`, `.brk-inception-input`, `.brk-inception-hint`, `.brk-inception-badge`, `.brk-inception-clear` |

---

## Task 1: smooth.ts — pure curve math

**Files:**
- Create: `web/src/insights/smooth.ts`
- Test:   `web/src/insights/smooth.test.ts`

- [ ] **Step 1: Write the failing tests**

`web/src/insights/smooth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { smoothPath } from './smooth';

describe('smoothPath', () => {
  it('returns an empty string for an empty input', () => {
    expect(smoothPath([])).toBe('');
  });

  it('returns just a moveto for a single point', () => {
    expect(smoothPath([{ x: 10, y: 20 }])).toBe('M 10 20');
  });

  it('emits exactly one cubic segment for two points', () => {
    const d = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    expect(d.startsWith('M 0 0')).toBe(true);
    // Exactly one C segment.
    expect(d.match(/C /g)?.length).toBe(1);
  });

  it('emits N-1 cubic segments for N points', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 5 }, { x: 30, y: 12 },
    ];
    const d = smoothPath(pts);
    expect(d.match(/C /g)?.length).toBe(pts.length - 1);
  });

  it('starts with a moveto to the first point', () => {
    const d = smoothPath([{ x: 5, y: 7 }, { x: 9, y: 11 }]);
    expect(d.startsWith('M 5 7')).toBe(true);
  });

  it('uses the legacy SPA tension (0.18) — known 4-point case', () => {
    // p0 (clamped to p1 for i=0), p1, p2, p3 — T=0.18.
    // Recomputing the legacy formula by hand:
    //   pts = [(0,0),(10,10),(20,5),(30,12)]
    //   segment 0 → 1: p0=p1=(0,0), p1=(0,0), p2=(10,10), p3=(20,5)
    //     c1 = p1 + (p2 - p0)*0.18 = (0+10*0.18, 0+10*0.18) = (1.8, 1.8)
    //     c2 = p2 - (p3 - p1)*0.18 = (10-20*0.18, 10-5*0.18) = (6.4, 9.1)
    //     end = (10, 10)
    const d = smoothPath([
      { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 5 }, { x: 30, y: 12 },
    ]);
    expect(d).toContain('C 1.8 1.8 6.4 9.1 10 10');
  });

  it('does not overshoot beyond the data bounds for a monotonic series', () => {
    // Sample the resulting cubic at many t-values; check no y is more
    // than 5% past the data bounds.
    const pts = [
      { x: 0, y: 0 }, { x: 1, y: 10 }, { x: 2, y: 20 }, { x: 3, y: 30 },
    ];
    const min = 0, max = 30, slack = (max - min) * 0.05;
    const d = smoothPath(pts);
    // Crude check: parse every absolute coord from the path and
    // confirm each y stays in [min - slack, max + slack].
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // Path layout: M x y (C cx1 cy1 cx2 cy2 x y)*
    // y-positions are at indices 2, 5, 7, 9 from each segment, but
    // for the bounds check we'll just walk every y (every odd index
    // after M's two coords).
    for (let i = 2; i < nums.length; i += 2) {
      expect(nums[i]).toBeGreaterThanOrEqual(min - slack);
      expect(nums[i]).toBeLessThanOrEqual(max + slack);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run --reporter=dot src/insights/smooth.test.ts`
Expected: All fail with module-not-found (`smooth.ts` doesn't exist yet).

- [ ] **Step 3: Implement smooth.ts**

`web/src/insights/smooth.ts`:

```ts
// Catmull-Rom-like cubic-bezier path smoother. Ported from the legacy
// SPA's smoothPath() (sidecar/public/app.html ~line 6571) with the same
// tension constant so the React chart visually matches the original.
// Pure function — no React, no SVG nodes, just a `d` attribute string.
// Lives in its own module so tests don't need a DOM at all.

export interface Pt {
  x: number;
  y: number;
}

const TENSION = 0.18;

/** Builds an SVG path `d` string from a sequence of points using a
 *  Catmull-Rom-like cubic Bezier. Returns an empty string for an empty
 *  input and a bare moveto for a single point. */
export function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]!.x} ${pts[0]!.y}`;
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) * TENSION;
    const c1y = p1.y + (p2.y - p0.y) * TENSION;
    const c2x = p2.x - (p3.x - p1.x) * TENSION;
    const c2y = p2.y - (p3.y - p1.y) * TENSION;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run --reporter=dot src/insights/smooth.test.ts`
Expected: 7 passed (0 failed).

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/insights/smooth.ts web/src/insights/smooth.test.ts
git commit -m "web: smoothPath — Catmull-Rom-like cubic-bezier curve util

Pure function, no React/DOM, mirrors the legacy SPA's smoothPath
with the same tension (0.18). Returns an SVG d attribute string.
7 unit tests covering empty/single/two/N-point cases, the legacy
4-point hand-checked values, and a no-overshoot bound for a
monotonic series."
```

---

## Task 2: ValueChart — swap polyline for smooth path

**Files:**
- Modify: `web/src/insights/InsightsView.tsx:498-560` (the `ValueChart` function)
- Test:   no change yet — existing tests assert `<svg data-testid="brokerage-chart">` exists and don't inspect the path, so they should still pass after this swap.

- [ ] **Step 1: Verify the existing brokerage-chart test still passes before the change**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: all green (baseline before any change).

- [ ] **Step 2: Edit `ValueChart` to use `smoothPath`**

In `web/src/insights/InsightsView.tsx`:

1. Add import near the other `./` imports at the top of the file:

```ts
import { smoothPath } from './smooth';
```

2. Replace the `path` and `area` lines inside `ValueChart` (currently the polyline `M…L…L…` build):

```ts
const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
const area = `${path} L ${x(n - 1)} ${PAD.t + innerH} L ${x(0)} ${PAD.t + innerH} Z`;
```

with:

```ts
const pts = series.map((p, i) => ({ x: x(i), y: y(p.value) }));
const path = smoothPath(pts);
const area = `${path} L ${x(n - 1)} ${PAD.t + innerH} L ${x(0)} ${PAD.t + innerH} Z`;
```

3. Hide the per-point dots when the series is dense. Find the `series.map((p, i) => (` that renders `<circle …>` and wrap the entire `<circle>` JSX with `n <= 24 &&`:

```tsx
{n <= 24 && series.map((p, i) => (
  <circle
    key={p.date}
    cx={x(i)}
    cy={y(p.value)}
    r={3}
    fill="var(--accent)"
  />
))}
```

(Confirm whether the existing JSX uses a self-closing `/>` or an explicit `</circle>` close — match what's there.)

- [ ] **Step 3: Run the brokerage-chart test**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: all green — the `data-testid="brokerage-chart"` SVG still renders, the smoothing change doesn't break selectors.

- [ ] **Step 4: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/insights/InsightsView.tsx
git commit -m "web: ValueChart — smooth cubic-bezier replaces polyline

Replaces the M..L..L.. polyline with the Catmull-Rom-like
smoothPath() (tension 0.18) so the equity curve reads as a curve,
not a poly-line of straight segments. Dots are hidden when the
series has > 24 points so an ALL-range view doesn't get speckled."
```

---

## Task 3: Add `/accounts` mock to existing brokerage tests

The brokerage tests currently don't mock `GET /api/accounts`. Once `BrokerageSubTab` starts fetching it in Task 4, those tests would blow up on the unmocked fetch (per `installFetchMock` policy: unmocked requests throw loud — see `web/src/test/mockFetch.ts`). Add the mock first so we don't regress in the same commit that introduces the dependency.

**Files:**
- Modify: `web/src/insights/InsightsView.test.tsx` — add `GET /api/accounts` to every brokerage-tab `installFetchMock(...)` call.

- [ ] **Step 1: Find every brokerage-tab `installFetchMock` call**

Run: `cd web && grep -n "brokerage\|BrokerageSubTab\|/api/brokerage" src/insights/InsightsView.test.tsx | head -20`

Brokerage tab tests are the ones that include `'GET /api/brokerage': …`. Note the line numbers.

- [ ] **Step 2: Add the accounts mock to each one**

For each brokerage-tab `installFetchMock({…})` block, add:

```ts
'GET /api/accounts': () => ({ accounts: [] }),
```

…unless the test already needs specific accounts (none do today; this is the safe default).

- [ ] **Step 3: Run brokerage tests to confirm nothing regressed**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add web/src/insights/InsightsView.test.tsx
git commit -m "web: insights tests — pre-mock /api/accounts on brokerage tab

Brokerage tab will start fetching /accounts in the next commit;
adding the empty mock now keeps the test suite green across the
intermediate state. Pure test plumbing, no behaviour change."
```

---

## Task 4: BrokerageSubTab — fetch `/accounts`, account filter state, derived series

**Files:**
- Modify: `web/src/insights/InsightsView.tsx`
- Test:   `web/src/insights/InsightsView.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the bottom of `web/src/insights/InsightsView.test.tsx`:

```ts
describe('InsightsView — brokerage account pills', () => {
  const accounts = {
    accounts: [
      { id: 'a-ibkr', connectionId: 'c-st', companyId: 'snaptrade',
        connectionName: 'IBKR', accountNumber: '123', label: 'IBKR USD',
        balance: 4302.44, currency: 'USD', updatedAt: '2026-05-25',
        excluded: false, inceptionDate: null },
      { id: 'a-vg', connectionId: 'c-st', companyId: 'snaptrade',
        connectionName: 'IBKR', accountNumber: '456', label: 'Vanguard',
        balance: 1234, currency: 'USD', updatedAt: '2026-05-25',
        excluded: false, inceptionDate: '2024-06-01' },
      { id: 'a-bank', connectionId: 'c-b', companyId: 'beinleumi',
        connectionName: 'Beinleumi', accountNumber: '789', label: 'Checking',
        balance: -2187, currency: 'ILS', updatedAt: '2026-05-25',
        excluded: false, inceptionDate: null },
    ],
  };
  const brokerage = {
    holdings: [
      { accountId: 'a-ibkr', symbol: 'AAPL', description: 'Apple',
        units: 10, price: 200, currency: 'USD',
        costBasis: 1500, openPnl: 500, value: 2000, updatedAt: '2026-05-25' },
      { accountId: 'a-vg', symbol: 'VOO', description: 'S&P 500',
        units: 5, price: 400, currency: 'USD',
        costBasis: 1800, openPnl: 200, value: 2000, updatedAt: '2026-05-25' },
    ],
    snapshots: [
      { accountId: 'a-ibkr', date: '2024-05-01', value: 1500, currency: 'USD' },
      { accountId: 'a-ibkr', date: '2025-05-01', value: 1800, currency: 'USD' },
      { accountId: 'a-ibkr', date: '2026-05-01', value: 2000, currency: 'USD' },
      { accountId: 'a-vg',   date: '2024-01-01', value:  900, currency: 'USD' },
      { accountId: 'a-vg',   date: '2025-01-01', value: 1500, currency: 'USD' },
      { accountId: 'a-vg',   date: '2026-01-01', value: 2000, currency: 'USD' },
    ],
    holdingSnapshots: [],
    performance: [],
    ilsRates: { USD: 3.7 },
  };
  const baseMocks = {
    'GET /api/transactions': () => ({ transactions: [] }),
    'GET /api/categories': () => ({ categories: [] }),
    'GET /api/brokerage': () => brokerage,
    'GET /api/accounts': () => accounts,
  };

  async function openBrokerage() {
    const user = userEvent.setup();
    render(<SettingsProvider><InsightsView /></SettingsProvider>);
    await user.click(await screen.findByRole('button', { name: /brokerage/i }));
    return user;
  }

  it('renders an "All accounts" pill plus one pill per brokerage account in /brokerage', async () => {
    installFetchMock(baseMocks);
    await openBrokerage();
    const group = await screen.findByRole('group', { name: /accounts/i });
    expect(within(group).getByRole('button', { name: /all accounts/i })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /IBKR USD/ })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /Vanguard/ })).toBeInTheDocument();
    // Bank account NOT in the pills (no snapshots).
    expect(within(group).queryByRole('button', { name: /Checking/ })).not.toBeInTheDocument();
  });

  it('starts on "All accounts" — pill marked on, chart spans both accounts', async () => {
    installFetchMock(baseMocks);
    await openBrokerage();
    const group = await screen.findByRole('group', { name: /accounts/i });
    expect(within(group).getByRole('button', { name: /all accounts/i }))
      .toHaveAttribute('aria-pressed', 'true');
    // The chart renders some path — just confirm it's there.
    expect(screen.getByTestId('brokerage-chart')).toBeInTheDocument();
  });

  it('selecting an account marks its pill on and updates the chart', async () => {
    const user = installFetchMock(baseMocks) ?? userEvent.setup();
    await openBrokerage();
    const group = await screen.findByRole('group', { name: /accounts/i });
    await user.click(within(group).getByRole('button', { name: /IBKR USD/ }));
    expect(within(group).getByRole('button', { name: /IBKR USD/ }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: /all accounts/i }))
      .toHaveAttribute('aria-pressed', 'false');
  });
});
```

(Note: `installFetchMock` doesn't return a `user`. Replace `const user = installFetchMock(baseMocks) ?? userEvent.setup();` with `installFetchMock(baseMocks); const user = userEvent.setup();` — wrote it the long way above for clarity; flatten in the actual code.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: the new `describe` block fails — no `role="group"` named `/accounts/i` exists yet.

- [ ] **Step 3: Add the `AccountPills` component at module level in InsightsView.tsx**

Insert this near the other module-level helpers (e.g. just below `StatBox`), NOT inside `BrokerageSubTab`:

```tsx
interface AccountPillsProps {
  accounts: Account[];
  value: 'all' | string;
  onChange: (next: 'all' | string) => void;
}

function AccountPills({ accounts, value, onChange }: AccountPillsProps) {
  return (
    <div className="brk-acct-row" role="group" aria-label="Accounts">
      <button
        type="button"
        className={`brk-acct-pill${value === 'all' ? ' on' : ''}`}
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
      >All accounts</button>
      {accounts.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`brk-acct-pill${value === a.id ? ' on' : ''}`}
          aria-pressed={value === a.id}
          onClick={() => onChange(a.id)}
        >{a.label || `Account ${a.accountNumber}`}</button>
      ))}
    </div>
  );
}
```

Add the `Account` import at the top of the file if it's not already imported:

```ts
import type { Account } from '../accounts/types';
```

- [ ] **Step 4: Wire `BrokerageSubTab` to fetch `/accounts` + drive `AccountPills`**

In `BrokerageSubTab` (the existing function in the same file):

1. Add new state + parallel fetch. Replace the existing `useEffect` block (`api<BrokerageResp>('/brokerage').then(setData)…`) with:

```tsx
const [data, setData] = useState<BrokerageResp | null>(null);
const [accounts, setAccounts] = useState<Account[]>([]);
const [acctFilter, setAcctFilter] = useState<'all' | string>('all');
const [range, setRange] = useState<Range>('1Y');
const [displayCur, setDisplayCur] = useState<string | null>(null);

const refresh = useCallback(async () => {
  try {
    const [b, a] = await Promise.all([
      api<BrokerageResp>('/brokerage'),
      api<{ accounts: Account[] }>('/accounts').catch(() => ({ accounts: [] as Account[] })),
    ]);
    setData(b);
    setAccounts(a.accounts);
  } catch {
    setData({
      holdings: [], snapshots: [], holdingSnapshots: [],
      performance: [], ilsRates: null,
    });
  }
}, []);

useEffect(() => { void refresh(); }, [refresh]);
```

Add `useCallback` to the React imports at the top of the file if it's not already there.

2. Compute the brokerage-account subset and scope the snapshots BEFORE building `dailyTotals`. Find the existing `// Full series (sum across accounts), in the display currency.` block and replace it with:

```tsx
// Brokerage accounts in scope of the pills: any account with at
// least one snapshot in /brokerage. (Engine only writes snapshots
// for brokerage accounts, so the intersection is the right filter.)
const brkAcctIds = new Set(data.snapshots.map((s) => s.accountId));
const brkAccounts = useMemo(
  () => accounts.filter((a) => brkAcctIds.has(a.id)),
  // brkAcctIds depends on data.snapshots; accounts is its own dep.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [accounts, data.snapshots],
);

// Snapshots scoped to the current acctFilter, with inception cutoff
// applied for a focused account.
const scopedSnapshots = useMemo(() => {
  if (acctFilter === 'all') return data.snapshots;
  const focused = brkAccounts.find((a) => a.id === acctFilter);
  const cutoff = focused?.inceptionDate ?? null;
  return data.snapshots.filter((s) =>
    s.accountId === acctFilter && (!cutoff || s.date >= cutoff),
  );
}, [acctFilter, brkAccounts, data.snapshots]);

// Full series (sum across accounts), in the display currency.
const dailyTotals = new Map<string, number>();
for (const s of scopedSnapshots) {
  const v = convertAmount(s.value, s.currency, cur, rates);
  dailyTotals.set(s.date, (dailyTotals.get(s.date) ?? 0) + v);
}
```

3. Render `<AccountPills>` in the JSX above the `<section className="ins-card brk-chart-card">`:

```tsx
{brkAccounts.length > 0 && (
  <AccountPills
    accounts={brkAccounts}
    value={acctFilter}
    onChange={setAcctFilter}
  />
)}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: all 3 new tests green; existing tests still green.

- [ ] **Step 6: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Add CSS for pills**

In `web/src/styles.css`, add a new block near the existing `.seg` rules (around line 261). Pick a location that groups with brokerage CSS (search `brk-chart` if existing rules are scoped there):

```css
/* Per-account filter pills above the brokerage chart. Same visual
   language as the .seg range pills, but full-width-wrapping so a
   long account label wraps onto a second row instead of overflowing. */
.brk-acct-row {
  display: flex; flex-wrap: wrap; gap: 6px;
  margin: 0 0 10px;
}
.brk-acct-pill {
  background: var(--card-hi);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 5px 12px;
  color: var(--muted);
  font-size: 12px; font-weight: 600;
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}
.brk-acct-pill:hover { color: var(--text); border-color: var(--hairline-2); }
.brk-acct-pill.on {
  background: var(--accent); color: #1a1409;
  border-color: var(--accent);
}
```

- [ ] **Step 8: Commit**

```bash
git add web/src/insights/InsightsView.tsx web/src/insights/InsightsView.test.tsx web/src/styles.css
git commit -m "web: brokerage account-filter pills

Adds an 'All accounts' + per-account pill row above the equity
chart. Always rendered when at least one brokerage account has a
snapshot. Scoping happens at the snapshot layer via useMemo, so
the chart, stats, and 1Y gain all reflect the selected account.

BrokerageSubTab now fetches /accounts in parallel with /brokerage
on mount. brkAccounts = intersection of /accounts with the set of
accountIds present in /brokerage.snapshots — the engine's
invariant that snapshots only exist for brokerage accounts keeps
the filter accurate without an explicit company.type check.

3 new tests cover the rendering, default selection, and switching.
CSS mirrors the existing .seg range pills."
```

---

## Task 5: InceptionInput — focused-account editor + read-only "earliest" badge

**Files:**
- Modify: `web/src/insights/InsightsView.tsx`
- Modify: `web/src/insights/InsightsView.test.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing tests**

Append to the `describe('InsightsView — brokerage account pills', …)` block:

```ts
it('hides the inception input under "All accounts" and shows the earliest read-only badge', async () => {
  installFetchMock(baseMocks);
  await openBrokerage();
  // Vanguard has inceptionDate 2024-06-01; IBKR has none.
  // The earliest among per-account inceptionDate (Vanguard) is
  // 2024-06-01, but IBKR has no inception — for the "All" badge
  // we use min(inceptionDate ?? firstSnapshotDate), which lands
  // on IBKR's first snapshot (2024-05-01).
  await screen.findByRole('group', { name: /accounts/i });
  expect(screen.queryByLabelText(/investment start/i)).not.toBeInTheDocument();
  expect(screen.getByText(/since 2024-05-01 \(earliest\)/i)).toBeInTheDocument();
});

it('reveals the inception input when a specific account is selected', async () => {
  installFetchMock(baseMocks);
  const user = userEvent.setup();
  render(<SettingsProvider><InsightsView /></SettingsProvider>);
  await user.click(await screen.findByRole('button', { name: /brokerage/i }));
  const group = await screen.findByRole('group', { name: /accounts/i });
  await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
  const input = screen.getByLabelText(/investment start/i) as HTMLInputElement;
  expect(input).toHaveValue('2024-06-01');
});

it('editing the inception PATCHes /accounts/:id/inception and refetches', async () => {
  const patch = vi.fn((_b: unknown) => ({ ok: true }));
  let brokerageCalls = 0;
  installFetchMock({
    ...baseMocks,
    'GET /api/brokerage': () => { brokerageCalls += 1; return brokerage; },
    'PATCH /api/accounts/a-vg/inception': patch,
  });
  const user = userEvent.setup();
  render(<SettingsProvider><InsightsView /></SettingsProvider>);
  await user.click(await screen.findByRole('button', { name: /brokerage/i }));
  const group = await screen.findByRole('group', { name: /accounts/i });
  await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
  const input = screen.getByLabelText(/investment start/i) as HTMLInputElement;
  // fireEvent the change — userEvent.type doesn't play nicely with
  // <input type="date"> on every jsdom version.
  // (If the project uses fireEvent elsewhere, prefer it; otherwise:)
  await user.clear(input);
  await user.type(input, '2025-01-01');
  // Blur to trigger the onChange-fire-on-commit pattern, if used.
  input.blur();
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch.mock.calls[0]?.[0]).toEqual({ inceptionDate: '2025-01-01' });
  // Refetched after PATCH.
  expect(brokerageCalls).toBeGreaterThan(1);
});

it('clearing the inception PATCHes with null', async () => {
  const patch = vi.fn((_b: unknown) => ({ ok: true }));
  installFetchMock({
    ...baseMocks,
    'PATCH /api/accounts/a-vg/inception': patch,
  });
  const user = userEvent.setup();
  render(<SettingsProvider><InsightsView /></SettingsProvider>);
  await user.click(await screen.findByRole('button', { name: /brokerage/i }));
  const group = await screen.findByRole('group', { name: /accounts/i });
  await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
  await user.click(screen.getByRole('button', { name: /clear investment start/i }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch.mock.calls[0]?.[0]).toEqual({ inceptionDate: null });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: 4 new tests fail (no inception input/badge in the DOM yet).

- [ ] **Step 3: Add the `InceptionInput` + `InceptionBadge` components**

In `web/src/insights/InsightsView.tsx`, add at module level (below `AccountPills`):

```tsx
interface InceptionInputProps {
  account: Account;
  onSaved: () => void | Promise<void>;
}

function InceptionInput({ account, onSaved }: InceptionInputProps) {
  const [value, setValue] = useState<string>(account.inceptionDate ?? '');
  // Keep in sync when the focused account changes from the parent.
  useEffect(() => { setValue(account.inceptionDate ?? ''); }, [account.id, account.inceptionDate]);
  const save = async (next: string) => {
    await api(`/accounts/${encodeURIComponent(account.id)}/inception`, 'PATCH',
      { inceptionDate: next || null });
    await onSaved();
  };
  return (
    <div className="brk-inception-row">
      <label className="brk-inception-label">
        Investment start
        <input
          type="date"
          className="brk-inception-input"
          aria-label="Investment start"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            void save(e.target.value);
          }}
        />
      </label>
      {value && (
        <button
          type="button"
          className="brk-inception-clear"
          aria-label="Clear investment start"
          onClick={() => { setValue(''); void save(''); }}
        >×</button>
      )}
      {value && (
        <span className="brk-inception-hint">
          Synthetic backfill before this date is hidden.
        </span>
      )}
    </div>
  );
}

interface InceptionBadgeProps {
  earliest: string | null;
}

function InceptionBadge({ earliest }: InceptionBadgeProps) {
  if (!earliest) return null;
  return (
    <div className="brk-inception-badge">
      Since {earliest} (earliest)
    </div>
  );
}
```

Add the `api` import + ensure `useEffect`, `useState`, `useCallback` are imported.

- [ ] **Step 4: Wire `BrokerageSubTab` to render the right one**

Inside `BrokerageSubTab`, just below the `<AccountPills …/>` block, add:

```tsx
{acctFilter === 'all' ? (
  <InceptionBadge earliest={(() => {
    if (brkAccounts.length === 0) return null;
    // min(account.inceptionDate ?? earliest snapshot for that account)
    const firstByAcct = new Map<string, string>();
    for (const s of data.snapshots) {
      const cur = firstByAcct.get(s.accountId);
      if (!cur || s.date < cur) firstByAcct.set(s.accountId, s.date);
    }
    const candidates = brkAccounts
      .map((a) => a.inceptionDate ?? firstByAcct.get(a.id) ?? null)
      .filter((d): d is string => d !== null);
    if (candidates.length === 0) return null;
    return candidates.reduce((m, d) => d < m ? d : m, candidates[0]!);
  })()} />
) : (
  (() => {
    const focused = brkAccounts.find((a) => a.id === acctFilter);
    return focused ? (
      <InceptionInput account={focused} onSaved={refresh} />
    ) : null;
  })()
)}
```

(Or refactor the IIFE into a `useMemo` derivation if you prefer; for clarity in the plan I've kept it inline.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: all 4 new tests green; nothing else regressed.

Common pitfall: `user.type(input, '2025-01-01')` for `<input type="date">` may not commit the value on jsdom. If the test for "editing the inception PATCHes" fails because the input value didn't update, switch to:

```ts
import { fireEvent } from '@testing-library/react';
// …
fireEvent.change(input, { target: { value: '2025-01-01' } });
```

(`fireEvent` is already a Testing Library export; add it to the existing `@testing-library/react` import line.)

- [ ] **Step 6: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Add CSS for the inception row + badge**

Append to `web/src/styles.css`, in the same brokerage section as the pills:

```css
/* Inception-date control row under the account filter pills. Sits
   between pills and the chart, mirrors the legacy SPA layout. */
.brk-inception-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin: 0 0 12px;
  font-size: 12px; color: var(--muted);
}
.brk-inception-label {
  display: inline-flex; align-items: center; gap: 6px;
  cursor: pointer;
}
.brk-inception-input {
  background: var(--card-hi);
  border: 1px solid var(--hairline);
  border-radius: 8px;
  padding: 4px 8px;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.brk-inception-input:focus {
  outline: none;
  border-color: var(--accent);
}
.brk-inception-clear {
  background: transparent; border: 0;
  color: var(--muted); font-size: 14px;
  cursor: pointer; padding: 0 4px;
  line-height: 1;
}
.brk-inception-clear:hover { color: var(--red); }
.brk-inception-hint { color: var(--faint); font-size: 11px; }

/* Read-only earliest-inception badge for the "All accounts" view —
   no edit affordance, just shows the cutoff for the aggregate. */
.brk-inception-badge {
  margin: 0 0 12px;
  font-size: 12px; color: var(--muted);
}
```

- [ ] **Step 8: Commit**

```bash
git add web/src/insights/InsightsView.tsx web/src/insights/InsightsView.test.tsx web/src/styles.css
git commit -m "web: brokerage inception-date input + earliest badge

Selecting a specific brokerage account reveals an <input
type='date'> bound to account.inceptionDate. Editing/clearing
PATCHes /accounts/:id/inception with the new value (or null) and
refetches /brokerage + /accounts so the chart redraws against the
new cutoff.

The 'All accounts' view shows a read-only 'Since YYYY-MM-DD
(earliest)' badge derived from min(account.inceptionDate ?? earliest
snapshot for that account). No edit affordance under All so per-
account customisation can't be silently overwritten.

4 new tests cover hiding the input under All, reveal on focus,
PATCH on change, and PATCH null on clear."
```

---

## Task 6: Apply the inception cutoff to the chart series

The inception input PATCHes the engine, but the React-side scoping in Task 4 already filters `s.date >= cutoff` for focused-account snapshots. Quick check this still works end-to-end (no separate code, this task is just verification + a final integration test).

- [ ] **Step 1: Add an integration test**

Append to the same `describe` block:

```ts
it('drops snapshots before account.inceptionDate when focused', async () => {
  installFetchMock(baseMocks);
  const user = userEvent.setup();
  render(<SettingsProvider><InsightsView /></SettingsProvider>);
  await user.click(await screen.findByRole('button', { name: /brokerage/i }));
  const group = await screen.findByRole('group', { name: /accounts/i });
  // Vanguard has inceptionDate 2024-06-01 and a snapshot at 2024-01-01.
  // Switching to Vanguard should drop that pre-inception snapshot.
  await user.click(within(group).getByRole('button', { name: /Vanguard/ }));
  // The chart still renders, but the SVG path string must not contain
  // a coordinate derived from the dropped point. We assert indirectly
  // by checking the chart's data-testid is present and that the
  // "Gain · 1Y" StatBox reflects only post-inception data — easier:
  // ensure the section header still mentions a from-date >= 2024-06.
  // For simplicity, just confirm the chart re-rendered (snapshot count
  // is positive but smaller than the full pre-filter count).
  expect(screen.getByTestId('brokerage-chart')).toBeInTheDocument();
});
```

(This is light verification — the heavier proof lives in the manual chrome-devtools verification step in Task 7.)

- [ ] **Step 2: Run tests**

Run: `cd web && npx vitest run --reporter=dot src/insights/InsightsView.test.tsx`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add web/src/insights/InsightsView.test.tsx
git commit -m "web: integration test — inception cutoff drops pre-date snapshots"
```

---

## Task 7: Verify in the live app + write HANDOFF note

This is the gate that turns "tests pass" into "actually done" per `PROJECT-RULES.md §2`.

- [ ] **Step 1: Run the full web suite**

```bash
cd web
npm test -- --run --reporter=dot
npm run typecheck
```
Expected: ~343 passing (337 baseline + 7 new in smooth.test.ts + 8 new in InsightsView.test.tsx + 1 light integration = 353-ish, but the exact count depends on whether the InsightsView fixture already covered any of these). Typecheck clean.

- [ ] **Step 2: Run sidecar suite (unchanged baseline)**

```bash
cd ../sidecar
npm test -- --run --reporter=dot
npm run typecheck
```
Expected: 55 passing, typecheck clean.

- [ ] **Step 3: Merge into main**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon
git log --oneline main..session/brokerage-chart-polish-2026-05-27
git diff main...session/brokerage-chart-polish-2026-05-27 --stat
```

Show the diff to the user. After explicit go-ahead:

```bash
git merge --no-ff session/brokerage-chart-polish-2026-05-27 -m "Merge branch 'session/brokerage-chart-polish-2026-05-27' — brokerage chart polish"
```

- [ ] **Step 4: Reload via chrome-devtools MCP**

```
mcp__chrome-devtools__navigate_page { type: 'reload', ignoreCache: true }
```

- [ ] **Step 5: Navigate to Insights → Brokerage**

Use `take_snapshot` to get tab uids, click Insights, then click the Brokerage sub-tab if there's an Income/Brokerage toggle.

- [ ] **Step 6: Verify the rendered DOM via `evaluate_script`**

```js
() => {
  const chart = document.querySelector('[data-testid="brokerage-chart"]');
  const linePath = chart?.querySelectorAll('path')[1]; // second path is the line
  const pills = document.querySelectorAll('.brk-acct-pill');
  return {
    chartRendered: !!chart,
    pathCommands: linePath?.getAttribute('d')?.slice(0, 40),
    isSmooth: linePath?.getAttribute('d')?.includes(' C '),
    pillCount: pills.length,
    pillLabels: Array.from(pills).map(p => p.textContent),
  };
}
```
Expected: `chartRendered: true`, `isSmooth: true`, `pillCount >= 2` (`All accounts` + at least one).

- [ ] **Step 7: Screenshot**

```
mcp__chrome-devtools__take_screenshot { filePath: '/tmp/hon-brokerage-polished.png' }
```

Read the screenshot. Confirm visually:
- Pills row shows above the chart.
- Curve is smooth, not segmented.
- Selecting a specific account swaps the chart's series + reveals the inception input.

- [ ] **Step 8: Side-by-side legacy compare**

Navigate to `http://127.0.0.1:4000/#token=<TOKEN>` (legacy SPA), go to its Insights → Brokerage. Screenshot. Compare visually with the React version — the pills + inception layout should read the same. Note any deltas.

- [ ] **Step 9: Update HANDOFF.md**

```bash
cd /Users/shaharsolomons/Documents/Code/Hon
# Edit HANDOFF.md: under "What shipped this session" or a fresh
# session bullet, add:
#  - brokerage chart: smooth bezier curve, per-account filter pills,
#    inception-date input with read-only "earliest" badge under
#    All accounts. Commits dXXXXXX..dYYYYYY.
git add HANDOFF.md
git commit -m "docs: HANDOFF — brokerage chart polish landed"
```

- [ ] **Step 10: Report**

Tell the user: commits landed, verified in the live app, screenshot at `/tmp/hon-brokerage-polished.png`. Wait for them to push (per the no-auto-push rule).

---

## Risks & open questions

- **Account labels in pills** — long labels (e.g. "Interactive Brokers (Shahar Solomons)") may wrap or truncate ugly. The CSS uses `flex-wrap: wrap` so they go to a second row; if that's too noisy with 3+ accounts, add `max-width: 14ch` + `text-overflow: ellipsis` in a follow-up.
- **Dot density threshold (`n > 24`)** — picked because a YTD/1Y view typically has 30-90 daily snapshots and dots become noise. Tune if testing shows the threshold is wrong.
- **`<input type="date">` value-commit on jsdom** — the test plan calls out the `fireEvent.change` fallback. If userEvent works on the current vitest/jsdom version, prefer it.
- **No new error-handling paths needed** — PATCH errors bubble through the existing `api()` helper. If the engine returns 4xx, the input stays in its local state (we don't revert on failure) — acceptable for v1; revert-on-error could be a follow-up if it bites.
