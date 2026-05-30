# Car flow → React port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the disabled `🚗 Car` tile in the React Add-asset picker live, opening a dedicated form that looks a car up by plate (autofill), always allows manual entry, stores the full vehicle spec + plate, and lets the value be re-checked later.

**Architecture:** A new pure helper module (`vehicle.ts`) holds plate/name/ownership/subline logic with no React, fully unit-tested. A new lazy-loaded `CarAssetForm` modal consumes those helpers, calls the existing `GET /vehicle/:plate` and `POST /assets` routes. `AccountsView` is edited to enable the tile, route to the form, and give the car `AssetCard` a spec sub-line + "Re-check value" button. **No engine changes.**

**Tech Stack:** React 19 + TypeScript strict, Vitest + Testing Library, `installFetchMock` test helper, existing `ModalPortal` / `api()` / CSS classes (`.modal`, `.field`, `.modal-err`, `.modal-actions`, `.mini`).

---

## Reference (existing code)

- **Engine route** `GET /vehicle/:plate` (`sidecar/src/server.ts` ~2011) → `{ found: true, vehicle: VehicleInfo }` | `{ found: false }` | HTTP 502.
- **`VehicleInfo`** (`sidecar/src/vehicle.ts:9-18`): `{ plate, make, model, trim, year, fuel, ownership, color }` — every field except `plate` nullable; `ownership` is the raw Hebrew `baalut` string.
- **Legacy `ownershipKey`** (`sidecar/public/app.html:7505`):
  ```js
  function ownershipKey(baalut) {
    const s = String(baalut || "");
    if (s.indexOf("פרטי") >= 0) return "private";
    if (s.indexOf("השכר") >= 0) return "rental";
    if (s.indexOf("ליסינג") >= 0 || s.indexOf("ליס") >= 0) return "lease";
    if (s.indexOf("חבר") >= 0) return "company";
    return "";
  }
  ```
- **Legacy save** (`app.html:7871-7903`): `POST /assets { kind:'car', name, value, currency:'ILS', details:{ plate, year, km, ownership } }`.
- **`AddManualAssetForm`** (`web/src/accounts/AddManualAssetForm.tsx`) — pattern for a modal: `ModalPortal` → `.overlay` → `.modal[role=dialog]` → `.field` labels → `.modal-err` → `.modal-actions`. Uses `api('/assets','POST',…)` and `ApiError`.
- **`AccountsView.tsx`** anchors:
  - lazy imports at top (lines 14-18: `SnapTradeLinkFlow`, `InteractiveSignInModal` via `lazy()`).
  - `AddFlow` union — `web/src/accounts/AccountsView.tsx:150`.
  - `AssetCard` — line 943 (renders `{asset.kind}` + value + Edit/Remove).
  - `AssetEditModal` — line 1091 (`PUT /assets/:id`), opened via `setEditingAsset` / `callbacks.onEditAsset`.
  - `AddConnectionPicker` props — line ~1323; tile list `PICKER_TILES` — line 1299; car tile (`comingSoon: true`) — lines 1306-1307; tile `onClick` — lines 1351-1359.
  - picker render block + `addFlow` render branches — lines 498-531.
- **Test helper** `installFetchMock` (`web/src/test/mockFetch.ts`) — keyed by `"METHOD /api/path"`; unmocked requests throw. Token-in-fragment handled by `api.ts`.

Run all web commands from `web/` (root double-passes `--run`):
- Test: `npm test -- <file>` · Typecheck: `npm run typecheck`

---

## File structure

- **Create** `web/src/accounts/vehicle.ts` — pure helpers + types (no React).
- **Create** `web/src/accounts/vehicle.test.ts` — unit tests for the helpers.
- **Create** `web/src/accounts/CarAssetForm.tsx` — the add-car modal.
- **Create** `web/src/accounts/CarAssetForm.test.tsx` — component tests.
- **Modify** `web/src/accounts/AccountsView.tsx` — enable tile, route, AssetCard car branch.
- **Modify** `web/src/accounts/AccountsView.test.tsx` (or the existing picker test) — integration: tile enabled + opens form.
- **Modify** `web/src/styles.css` — minimal car-specific classes.

---

## Task 1: Pure vehicle helpers (`vehicle.ts`)

**Files:**
- Create: `web/src/accounts/vehicle.ts`
- Test: `web/src/accounts/vehicle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/accounts/vehicle.test.ts
import { describe, it, expect } from 'vitest';
import {
  cleanPlate, isValidPlate, vehicleName, ownershipKey, carSubline,
} from './vehicle';

describe('cleanPlate', () => {
  it('strips non-digits', () => {
    expect(cleanPlate('12-345-67')).toBe('1234567');
    expect(cleanPlate(' 123 45 ')).toBe('12345');
    expect(cleanPlate('abc')).toBe('');
  });
});

describe('isValidPlate', () => {
  it('accepts 5–8 digits, rejects outside', () => {
    expect(isValidPlate('1234')).toBe(false);
    expect(isValidPlate('12345')).toBe(true);
    expect(isValidPlate('12345678')).toBe(true);
    expect(isValidPlate('123456789')).toBe(false);
  });
});

describe('vehicleName', () => {
  it('joins make and model, tolerating missing parts', () => {
    expect(vehicleName({ make: 'Toyota', model: 'Corolla' })).toBe('Toyota Corolla');
    expect(vehicleName({ make: 'Toyota', model: null })).toBe('Toyota');
    expect(vehicleName({ make: null, model: 'Corolla' })).toBe('Corolla');
    expect(vehicleName({ make: null, model: null })).toBe('');
  });
});

describe('ownershipKey', () => {
  it('maps Hebrew baalut to a form value', () => {
    expect(ownershipKey('פרטי')).toBe('private');
    expect(ownershipKey('השכרה')).toBe('rental');
    expect(ownershipKey('ליסינג')).toBe('lease');
    expect(ownershipKey('חברה')).toBe('company');
    expect(ownershipKey('')).toBe('');
    expect(ownershipKey(null)).toBe('');
    expect(ownershipKey('something else')).toBe('');
  });
});

describe('carSubline', () => {
  it('builds a year · km · color line, skipping absent fields', () => {
    expect(carSubline({ year: 2020, km: 60000, color: 'Blue' }))
      .toBe('2020 · 60,000 km · Blue');
    expect(carSubline({ year: 2020 })).toBe('2020');
    expect(carSubline({ km: 1500 })).toBe('1,500 km');
    expect(carSubline({})).toBe('');
    expect(carSubline(null)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/accounts/vehicle.test.ts`
Expected: FAIL — cannot resolve `./vehicle`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/accounts/vehicle.ts

/** Mirror of the engine's VehicleInfo (sidecar/src/vehicle.ts). All fields
 *  except plate are nullable; `ownership` is the raw Hebrew `baalut` string. */
export interface VehicleInfo {
  plate: string;
  make: string | null;
  model: string | null;
  trim: string | null;
  year: number | null;
  fuel: string | null;
  ownership: string | null;
  color: string | null;
}

export type Ownership = 'private' | 'company' | 'lease' | 'rental';

/** What we persist on a car asset's `details`. */
export interface CarDetails {
  plate: string | null;
  year: number | null;
  km: number | null;
  ownership: Ownership | '';
  make: string | null;
  model: string | null;
  trim: string | null;
  fuel: string | null;
  color: string | null;
}

/** Strip everything but digits from a raw plate input. */
export function cleanPlate(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Israeli plates are 5–8 digits. */
export function isValidPlate(digits: string): boolean {
  return digits.length >= 5 && digits.length <= 8;
}

/** "make model", tolerating either part being null/empty. */
export function vehicleName(v: Pick<VehicleInfo, 'make' | 'model'>): string {
  return [v.make, v.model].filter(Boolean).join(' ');
}

/** Map the gov registry's Hebrew `baalut` to a form ownership value.
 *  Ported verbatim from the legacy SPA (app.html:7505). */
export function ownershipKey(baalut: string | null): Ownership | '' {
  const s = String(baalut || '');
  if (s.indexOf('פרטי') >= 0) return 'private';
  if (s.indexOf('השכר') >= 0) return 'rental';
  if (s.indexOf('ליסינג') >= 0 || s.indexOf('ליס') >= 0) return 'lease';
  if (s.indexOf('חבר') >= 0) return 'company';
  return '';
}

/** Compact "2020 · 60,000 km · Blue" line for the asset card. Skips absent
 *  fields; returns '' when nothing is known. `details` is the loosely-typed
 *  bag stored on the asset, so read defensively. */
export function carSubline(details: Record<string, unknown> | null): string {
  if (!details) return '';
  const bits: string[] = [];
  const year = details.year;
  if (typeof year === 'number' && Number.isFinite(year)) bits.push(String(year));
  const km = details.km;
  if (typeof km === 'number' && Number.isFinite(km)) {
    bits.push(`${km.toLocaleString('en-US')} km`);
  }
  const color = details.color;
  if (typeof color === 'string' && color.trim()) bits.push(color.trim());
  return bits.join(' · ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/accounts/vehicle.test.ts`
Expected: PASS (all 5 describes green).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add web/src/accounts/vehicle.ts web/src/accounts/vehicle.test.ts
git commit -m "feat(accounts): pure vehicle helpers for car-asset port"
```

---

## Task 2: `CarAssetForm` modal component

**Files:**
- Create: `web/src/accounts/CarAssetForm.tsx`
- Test: `web/src/accounts/CarAssetForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/accounts/CarAssetForm.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { installFetchMock } from '../test/mockFetch';
import { CarAssetForm } from './CarAssetForm';

const VEHICLE = {
  plate: '12345678', make: 'Toyota', model: 'Corolla', trim: 'SE',
  year: 2020, fuel: 'Gasoline', ownership: 'פרטי', color: 'Blue',
};

describe('CarAssetForm', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('looks up a plate and autofills the spec card', async () => {
    installFetchMock({
      'GET /api/vehicle/12345678': { found: true, vehicle: VEHICLE },
    });
    render(<CarAssetForm onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByLabelText(/licence plate/i), {
      target: { value: '12-345-678' },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/make & model/i) as HTMLInputElement).value)
        .toBe('Toyota Corolla'));
    expect((screen.getByLabelText(/year/i) as HTMLInputElement).value).toBe('2020');
    expect((screen.getByLabelText(/ownership/i) as HTMLSelectElement).value)
      .toBe('private');
    // polished spec card surfaces trim/fuel/color
    expect(screen.getByText(/SE/)).toBeInTheDocument();
    expect(screen.getByText(/Blue/)).toBeInTheDocument();
  });

  it('shows a manual-entry hint when the plate is not found, fields stay editable', async () => {
    installFetchMock({ 'GET /api/vehicle/99999': { found: false } });
    render(<CarAssetForm onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByLabelText(/licence plate/i), {
      target: { value: '99999' },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() =>
      expect(screen.getByText(/enter the details by hand/i)).toBeInTheDocument());
    const name = screen.getByLabelText(/make & model/i) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Kawasaki Ninja' } });
    expect(name.value).toBe('Kawasaki Ninja');
  });

  it('requires a positive value before saving', async () => {
    installFetchMock({});
    render(<CarAssetForm onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByLabelText(/make & model/i), {
      target: { value: 'Toyota Corolla' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add car/i }));
    await waitFor(() =>
      expect(screen.getByText(/current value/i)).toBeInTheDocument());
    // no POST fired (mock has no /assets key — would throw if called)
  });

  it('POSTs the full spec payload and calls onSaved', async () => {
    const onSaved = vi.fn(async () => {});
    const calls: any[] = [];
    installFetchMock({
      'GET /api/vehicle/12345678': { found: true, vehicle: VEHICLE },
      'POST /api/assets': (body: any) => { calls.push(body); return { asset: { id: 'a1' } }; },
    });
    render(<CarAssetForm onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/licence plate/i), {
      target: { value: '12345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/make & model/i) as HTMLInputElement).value)
        .toBe('Toyota Corolla'));
    fireEvent.change(screen.getByLabelText(/current value/i), {
      target: { value: '55000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add car/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      kind: 'car', name: 'Toyota Corolla', value: 55000, currency: 'ILS',
      details: {
        plate: '12345678', year: 2020, ownership: 'private',
        make: 'Toyota', model: 'Corolla', trim: 'SE', fuel: 'Gasoline', color: 'Blue',
      },
    });
  });

  it('opens Yad2 in a new tab', () => {
    installFetchMock({});
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<CarAssetForm onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /yad2/i }));
    expect(open).toHaveBeenCalledWith('https://www.yad2.co.il/price-list', '_blank');
  });
});
```

> **Note on `installFetchMock`:** if the existing helper only accepts static
> response objects (not a function for capturing the POST body), check
> `web/src/test/mockFetch.ts`. If it lacks function-value support, either use an
> existing capture pattern from a sibling test (e.g. `AddManualAssetForm` /
> SnapTrade tests) or assert via a static response + a `fetch` spy. Match the
> codebase's established mocking style rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/accounts/CarAssetForm.test.tsx`
Expected: FAIL — cannot resolve `./CarAssetForm`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// web/src/accounts/CarAssetForm.tsx
import { useState } from 'react';
import { ModalPortal } from '../ui/ModalPortal';
import { api, ApiError } from '../api';
import {
  cleanPlate, isValidPlate, vehicleName, ownershipKey,
  type VehicleInfo, type Ownership,
} from './vehicle';

interface CarAssetFormProps {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const OWNERSHIP_OPTIONS: { value: Ownership; label: string }[] = [
  { value: 'private', label: 'Private' },
  { value: 'company', label: 'Company' },
  { value: 'lease', label: 'Lease' },
  { value: 'rental', label: 'Ex-rental' },
];

const YAD2_PRICE_LIST = 'https://www.yad2.co.il/price-list';

/**
 * Add-a-car modal. Plate lookup (GET /vehicle/:plate) autofills a polished
 * spec card; every field stays editable so a failed lookup is never a dead
 * end. Saves via POST /assets with the full vehicle spec in `details` so the
 * value can be re-checked later. No engine changes — both routes exist.
 */
export function CarAssetForm({ onClose, onSaved }: CarAssetFormProps) {
  const [plate, setPlate] = useState('');
  const [name, setName] = useState('');
  const [year, setYear] = useState('');
  const [km, setKm] = useState('');
  const [ownership, setOwnership] = useState<Ownership>('private');
  const [value, setValue] = useState('');
  // Spec details captured from a successful lookup, kept for the POST payload
  // and the polished spec card. Null until a lookup succeeds.
  const [spec, setSpec] = useState<VehicleInfo | null>(null);
  const [looking, setLooking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    const digits = cleanPlate(plate);
    setError(null);
    setHint(null);
    if (!isValidPlate(digits)) { setError('Enter a valid plate number.'); return; }
    setLooking(true);
    try {
      const r = await api<{ found: boolean; vehicle?: VehicleInfo }>(`/vehicle/${digits}`);
      if (r.found && r.vehicle) {
        const v = r.vehicle;
        setSpec(v);
        const nm = vehicleName(v);
        if (nm) setName(nm);
        if (v.year) setYear(String(v.year));
        const own = ownershipKey(v.ownership);
        if (own) setOwnership(own);
        setHint(`Found ${nm || 'vehicle'}${v.year ? ` · ${v.year}` : ''}.`);
      } else {
        setSpec(null);
        setHint('No car found for that plate — enter the details by hand.');
      }
    } catch {
      setSpec(null);
      setHint('Lookup failed — enter the details by hand.');
    } finally {
      setLooking(false);
    }
  };

  const openYad2 = () => { window.open(YAD2_PRICE_LIST, '_blank'); };

  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError("Enter the car's make and model."); return; }
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) { setError("Enter the car's current value."); return; }
    const details = {
      plate: cleanPlate(plate) || null,
      year: Number(year) || null,
      km: Number(km) || null,
      ownership,
      make: spec?.make ?? null,
      model: spec?.model ?? null,
      trim: spec?.trim ?? null,
      fuel: spec?.fuel ?? null,
      color: spec?.color ?? null,
    };
    try {
      await api('/assets', 'POST', {
        kind: 'car', name: name.trim(), value: v, currency: 'ILS', details,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Add a car" className="modal">
          <h2>Add a car</h2>
          <p>
            Look the car up by its plate, then check its market price on Yad2 —
            or set the value yourself.
          </p>

          <label className="field">
            <span>Licence plate</span>
            <div className="car-plate-row">
              <input
                type="text"
                inputMode="numeric"
                value={plate}
                onChange={(e) => setPlate(e.target.value)}
                placeholder="e.g. 12345678"
                autoComplete="off"
              />
              <button type="button" className="mini" onClick={lookup} disabled={looking}>
                {looking ? '…' : 'Look up'}
              </button>
            </div>
          </label>

          {spec && <CarSpecCard spec={spec} />}

          <label className="field">
            <span>Make &amp; model</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Toyota Corolla"
              autoComplete="off"
            />
          </label>

          <div className="car-grid2">
            <label className="field">
              <span>Year</span>
              <input
                type="number" min="1980" max="2030" placeholder="2020"
                value={year} onChange={(e) => setYear(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Mileage (km)</span>
              <input
                type="number" min="0" step="1000" placeholder="60000"
                value={km} onChange={(e) => setKm(e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>Ownership</span>
            <select
              value={ownership}
              onChange={(e) => setOwnership(e.target.value as Ownership)}
            >
              {OWNERSHIP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Current value (₪)</span>
            <input
              type="number" min="0" step="500" placeholder="0"
              value={value} onChange={(e) => setValue(e.target.value)}
            />
          </label>

          <button type="button" className="mini car-yad2" onClick={openYad2}>
            Look up the price on Yad2 ↗
          </button>

          {hint && <div className="est-note">{hint}</div>}
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={submit}>Add car</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

/** Polished read-only summary of a successful plate lookup. */
function CarSpecCard({ spec }: { spec: VehicleInfo }) {
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, v: string | number | null) => {
    if (v != null && String(v).trim()) rows.push({ label, value: String(v) });
  };
  push('Make', spec.make);
  push('Model', spec.model);
  push('Trim', spec.trim);
  push('Year', spec.year);
  push('Fuel', spec.fuel);
  push('Colour', spec.color);
  if (rows.length === 0) return null;
  return (
    <div className="car-spec-card">
      {rows.map((r) => (
        <div key={r.label} className="car-spec-row">
          <span className="car-spec-label">{r.label}</span>
          <span className="car-spec-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
```

> **Import-path check:** confirm `ModalPortal` is exported from `../ui/ModalPortal`
> and `api` / `ApiError` from `../api` (grep an existing modal, e.g.
> `AddManualAssetForm.tsx`, for the exact import lines and copy them). Adjust if
> the project re-exports them elsewhere.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/accounts/CarAssetForm.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add web/src/accounts/CarAssetForm.tsx web/src/accounts/CarAssetForm.test.tsx
git commit -m "feat(accounts): CarAssetForm — plate lookup + manual entry + Yad2 handoff"
```

---

## Task 3: Wire the car tile into `AccountsView`

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` (lazy import ~14; `AddFlow` ~150; `AddConnectionPicker` props/onClick ~1281-1359; picker render + addFlow branch ~498-531)
- Test: `web/src/accounts/AccountsView.test.tsx` (add an integration test)

- [ ] **Step 1: Write the failing test**

Add to the existing AccountsView test file (match its existing render/setup helpers — reuse `installFetchMock` seeding `GET /api/companies`, `/api/connections`, `/api/accounts`, `/api/assets`, `/api/loans`, `/api/brokerage` exactly as the sibling tests do):

```tsx
it('car tile is enabled and opens the car form', async () => {
  // ...standard AccountsView mock seeding (copy from a sibling test in this file)...
  render(<AccountsView />);
  fireEvent.click(await screen.findByRole('button', { name: /add asset/i }));
  const carTile = await screen.findByRole('button', { name: 'Car' });
  expect(carTile).not.toBeDisabled();
  fireEvent.click(carTile);
  // CarAssetForm is lazy → assert async
  expect(await screen.findByRole('dialog', { name: /add a car/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/accounts/AccountsView.test.tsx -t "car tile"`
Expected: FAIL — car tile is `disabled` (or form never appears).

- [ ] **Step 3: Implementation — four edits**

**3a. Lazy import** (top of file, alongside the existing `lazy()` imports ~line 14):

```tsx
const CarAssetForm = lazy(() =>
  import('./CarAssetForm').then((m) => ({ default: m.CarAssetForm })));
```

**3b. Extend the `AddFlow` union** (line ~150):

```tsx
type AddFlow = null | 'picker' | 'manual-asset' | 'manual-loan' | 'manual-pension' | 'car' | Company;
```

**3c. `AddConnectionPicker`** — add an `onPickCar` prop, enable the tile, route the click:

- In `AddConnectionPickerProps` (near `onPickManualPension`):
  ```tsx
  /** Picked the Car tile → caller opens CarAssetForm. */
  onPickCar: () => void;
  ```
- In the destructure (line ~1324):
  ```tsx
  onPickManualPension, onPickCar, onPickBrokerage, onClose }:
  ```
- Remove `comingSoon: true` from the car tile (lines 1306-1307) so it becomes:
  ```tsx
  { key: 'car', label: 'Car', emoji: '🚗', subOverride: 'looked up by plate' },
  ```
  (Update the explanatory comment above `PICKER_TILES` so it no longer claims Car is disabled — only Car has changed; leave the rest accurate.)
- In the tile `onClick` (lines 1351-1358), add before the `bank`/`card` branch:
  ```tsx
  if (tile.key === 'car') { onPickCar(); return; }
  ```

**3d. Wire the props + render branch** (the `addFlow === 'picker'` block, line ~498, and a new branch after `manual-pension` ~531):

- Add the prop to the rendered `<AddConnectionPicker …>`:
  ```tsx
  onPickCar={() => setAddFlow('car')}
  ```
- Add the render branch (lazy → wrap in `Suspense`, mirroring the SnapTrade flow's loader at line ~559):
  ```tsx
  {addFlow === 'car' && (
    <Suspense fallback={null}>
      <CarAssetForm
        onClose={() => setAddFlow(null)}
        onSaved={async () => { setAddFlow(null); await refresh(); }}
      />
    </Suspense>
  )}
  ```
  (`Suspense` is already imported — it's used by the SnapTrade flow.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/accounts/AccountsView.test.tsx`
Expected: PASS (new test + existing picker tests unaffected).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx
git commit -m "feat(accounts): enable Car tile, route to CarAssetForm"
```

---

## Task 4: Car `AssetCard` — spec sub-line + "Re-check value"

**Files:**
- Modify: `web/src/accounts/AccountsView.tsx` (`AssetCard`, line 943)
- Test: `web/src/accounts/AccountsView.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('car asset card shows a spec sub-line and a Re-check value button', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  // seed /api/assets with one car asset:
  //   { id:'c1', kind:'car', name:'Toyota Corolla', value:55000, currency:'ILS',
  //     excluded:false, details:{ plate:'12345678', year:2020, km:60000, color:'Blue' } }
  // ...standard AccountsView mock seeding with that asset...
  render(<AccountsView />);
  expect(await screen.findByText('2020 · 60,000 km · Blue')).toBeInTheDocument();
  const recheck = screen.getByRole('button', { name: /re-check value/i });
  fireEvent.click(recheck);
  expect(open).toHaveBeenCalledWith('https://www.yad2.co.il/price-list', '_blank');
  // the existing edit modal opens (value-focused)
  expect(await screen.findByRole('dialog', { name: /asset|edit/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/accounts/AccountsView.test.tsx -t "spec sub-line"`
Expected: FAIL — card renders `{asset.kind}` ("car"), no Re-check button.

- [ ] **Step 3: Implementation — edit `AssetCard` (line 943)**

Add the import at top of file (with the other `./vehicle`-free imports):
```tsx
import { carSubline } from './vehicle';
```

Replace the `AssetCard` body so a car shows the spec sub-line and a Re-check button (keep the non-car path identical):

```tsx
function AssetCard({ asset, callbacks }: { asset: ManualAsset; callbacks: RowCallbacks }) {
  const isCar = asset.kind === 'car';
  const sub = isCar ? carSubline(asset.details) : '';
  return (
    <article className={`asset-card${asset.excluded ? ' nw-off' : ''}`}>
      <div className="asset-head">
        <div className="asset-title">{asset.name}</div>
        <NetWorthPill
          excluded={asset.excluded}
          onChange={(next) => callbacks.onToggleAssetExcluded(asset, next)}
        />
      </div>
      <div className="asset-meta">{isCar ? (sub || 'car') : asset.kind}</div>
      <div className="amount">{money(asset.value, asset.currency)}</div>
      <div className="conn-buttons" style={{ marginTop: 10 }}>
        {isCar && (
          <button
            type="button"
            className="mini"
            onClick={() => {
              window.open('https://www.yad2.co.il/price-list', '_blank');
              callbacks.onEditAsset(asset);
            }}
          >
            Re-check value ↗
          </button>
        )}
        <button type="button" className="mini" onClick={() => callbacks.onEditAsset(asset)}>Edit</button>
        <button type="button" className="mini danger" onClick={() => callbacks.onRemoveAsset(asset)}>Remove</button>
      </div>
    </article>
  );
}
```

> **Check `ManualAsset.details` typing:** if `details` is typed as
> `Record<string, unknown> | null` (matches the engine), `carSubline` accepts it
> directly. If the web type omits `details`, add `details: Record<string, unknown> | null`
> to the `ManualAsset` interface (likely in `web/src/accounts/types.ts`) in this
> task and note it in the commit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/accounts/AccountsView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add web/src/accounts/AccountsView.tsx web/src/accounts/AccountsView.test.tsx web/src/accounts/types.ts
git commit -m "feat(accounts): car asset card spec line + Re-check value"
```

---

## Task 5: Styles

**Files:**
- Modify: `web/src/styles.css`

No test (CSS). Add minimal scoped classes used by `CarAssetForm`. Reuse existing
`.field`, `.modal`, `.mini`, `.est-note`, `.modal-err` (already styled).

- [ ] **Step 1: Append styles**

```css
/* Car asset form */
.car-plate-row { display: flex; gap: 8px; align-items: stretch; }
.car-plate-row input { flex: 1 1 auto; min-width: 0; }
.car-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.car-yad2 { width: 100%; margin: 4px 0 2px; }
.car-spec-card {
  display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px;
  padding: 10px 12px; margin: 4px 0 10px;
  background: var(--surface-2, rgba(255,255,255,0.04));
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  border-radius: 10px; font-size: 0.85rem;
}
.car-spec-row { display: flex; justify-content: space-between; gap: 8px; }
.car-spec-label { opacity: 0.6; }
.car-spec-value { font-weight: 600; }
@media (max-width: 420px) {
  .car-grid2, .car-spec-card { grid-template-columns: 1fr; }
}
```

> **Var check:** confirm `--surface-2`, `--border` exist in `styles.css` (grep
> `:root`). The `var(…, fallback)` form degrades gracefully if not — but prefer
> the project's real token names if they differ.

- [ ] **Step 2: Commit**

```bash
git add web/src/styles.css
git commit -m "style(accounts): car form layout + spec card"
```

---

## Task 6: Full verification (the "done" gate)

- [ ] **Step 1: Full web suite + typecheck**

Run (from `web/`):
```bash
npm test
npm run typecheck
```
Expected: all tests pass (≈479 + the new car tests); typecheck clean. Also run
`cd ../sidecar && npm run typecheck` (no sidecar changes expected — sanity only).

- [ ] **Step 2: Visual verification (PROJECT-RULES §2 — hard gate)**

The engine + vite must be running (`cd Hon && npm run dev`; the user runs their
own — do **not** `preview_start`). Use chrome-devtools MCP against the live app
(read the dev token from `<dataDir>/dev-token`):

1. Navigate to `http://localhost:5173/#token=<TOKEN>`, go to **Assets**.
2. Click **+ Add asset** → confirm the **Car** tile is enabled → click it.
3. Screenshot the empty car form. (`/tmp/car-form.png`, then Read it.)
4. Type a **real plate** (ask the user for one, or use the user's own car) →
   **Look up** → screenshot the populated **spec card** + autofilled fields.
   Confirm `GET /vehicle/:plate` 200 in the network panel.
5. Set a value → **Add car** → confirm the new car appears in the Assets grid
   with the **spec sub-line** (e.g. `2020 · 60,000 km · Blue`).
6. Screenshot the car card showing **Re-check value ↗** + Edit + Remove.
7. Click **Re-check value** → confirm Yad2 opens (new tab) and the edit modal
   appears. No console errors throughout.

Only after these screenshots exist may the work be called done.

- [ ] **Step 3: Merge prep**

Return to the main worktree and show the diff for the user to decide merge/PR
(PROJECT-RULES §3). Do **not** push without explicit go-ahead.
```bash
cd /Users/shaharsolomons/Documents/Code/Hon
git log --oneline main..session/car-react-port-2026-05-30
git diff main...session/car-react-port-2026-05-30 --stat
```

- [ ] **Step 4: Update HANDOFF.md** — move "Car flow port to React" from
  *Deferred / Highest-value next steps* into a "What shipped" entry; note the
  dedicated-PickerStep pattern reused and that the manual hand-test used a real
  plate. (Commit on the session branch or main per the merge decision.)

---

## Self-review notes

- **Spec coverage:** manual fallback → Task 2 (fields stay editable on failed
  lookup) + dedicated tile route. Re-valuation → Task 4 (stored plate +
  Re-check value). Polished card → Task 2 `CarSpecCard`. Full spec stored →
  Task 2 POST `details`. Visual verify → Task 6. All four brainstorm decisions
  covered.
- **No engine changes** — `/vehicle/:plate`, `POST /assets`, `PUT /assets/:id`
  all pre-exist; confirmed in the reference section.
- **Type consistency:** `VehicleInfo`/`Ownership`/`CarDetails` defined in Task 1,
  consumed unchanged in Tasks 2 & 4; `carSubline` signature matches its Task-4
  call; `onPickCar` named identically in prop, destructure, and render.
- **Open verifications flagged inline** (not placeholders — real "confirm before
  copying" checks): `installFetchMock` function-value support, `ModalPortal`/`api`
  import paths, `ManualAsset.details` typing, CSS var names. Each names the exact
  file to check and the fallback.
