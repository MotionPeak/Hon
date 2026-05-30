# Car flow → React port — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorm complete)
**Topic:** Port the car-asset flow from the legacy SPA into the React Add-asset
picker, following the pension-port precedent.

---

## Goal

The React Add-asset picker shows a `🚗 Car` tile that is currently disabled
(`comingSoon: true`) — the car flow only lives in the legacy SPA
(`sidecar/public/app.html` `renderCarStep`). This port makes the tile live with
a dedicated React form that:

1. Looks up a car by licence plate (autofill from the Ministry of Transport
   registry), with a **polished** result card.
2. Always allows **manual entry** (failed lookup is never a dead end).
3. Stores the **full vehicle spec** + plate so the value can be **re-checked
   later**.

**No engine changes.** `GET /vehicle/:plate`, `POST /assets`, and
`PUT /assets/:id` already exist.

---

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Manual fallback when lookup fails / no plate | **Yes** — built into the single form; all fields stay editable, no separate dead-end. |
| Re-valuation (cars depreciate) | **Store plate + "Re-check value" later** on the car asset card. |
| Result UI polish | **Polished spec card** (make/model/trim/year/fuel/color/ownership). |
| Stored detail richness | **Full spec** stored in `details`, beyond the legacy plate/year/km/ownership set. |

---

## Existing code (reference)

- **Legacy flow:** `sidecar/public/app.html` `renderCarStep` (~7790–7908) — plate
  lookup, Yad2 deep-link, `POST /assets { kind:'car', details:{plate,year,km,ownership} }`.
- **Engine:** `GET /vehicle/:plate` (`sidecar/src/server.ts` ~2011) →
  `{ found, vehicle }`; `lookupVehicle` in `sidecar/src/vehicle.ts` returns
  `VehicleInfo { plate, make, model, trim, year, fuel, ownership, color }` (all
  nullable) via data.gov.il. `POST /assets` validates `kind ∈ ASSET_KINDS`
  (includes `'car'`), `name` non-empty, `value` finite > 0, `currency` default
  `ILS`, `details` arbitrary object.
- **Pension precedent:** `web/src/accounts/PensionPickerStep.tsx` +
  `AccountsView.tsx` wiring (`AddFlow`/`PickerStep` unions, `comingSoon` tiles,
  `AddManualAssetForm initialKind`).
- **Asset card:** `AssetCard` (`web/src/accounts/AccountsView.tsx:943`) — renders
  `{asset.kind}` + value + Edit/Remove. Edit → `AssetEditModal`
  (`PUT /assets/:id`). Excluded toggle uses `PUT /assets/:id { excluded }`.

---

## Components

### 1. `web/src/accounts/vehicle.ts` (new — pure, TDD first)

No React. Fully unit-testable.

- `cleanPlate(raw: string): string` — strip non-digits.
- `isValidPlate(digits: string): boolean` — length 5–8.
- `vehicleName(v: VehicleInfo): string` — `[make, model].filter(Boolean).join(' ')`.
- `ownershipKey(raw: string | null): Ownership | ''` — map gov `baalut` → one of
  `private | company | lease | rental` (port `ownershipKey` from the legacy SPA).
- Types: `VehicleInfo` (mirror engine), `CarDetails`, `Ownership`.

### 2. `web/src/accounts/CarAssetForm.tsx` (new)

Modal form. Props `{ onClose: () => void; onSaved: () => Promise<void> }`.
Lazy-loaded (matches `SnapTradeLinkFlow` / `InteractiveSignInModal`). All
subcomponents at module level (Vercel `rerender-no-inline-components`).

**Layout / flow:**
- **Plate row:** text input + `Look up` button. `< 5` digits → inline error, no
  fetch. Button → `GET /vehicle/:plate`.
- **On `{ found: true }`:** render a polished spec card showing
  make · model · trim · year · fuel · color · ownership — **prefilled and
  editable** (name = make+model, year, ownership select autoselected).
- **On `{ found: false }` or 502:** inline note "No car found — enter the details
  by hand." Fields stay editable → manual fallback.
- **Always-visible fields:** name, year, mileage (km), ownership (select), and
  **value ₪** + `Look up price on Yad2 ↗` button (opens
  `https://www.yad2.co.il/price-list` in a new tab — manual handoff; every price
  site is CAPTCHA-walled).
- **Save** → `POST /assets`:
  ```json
  { "kind": "car", "name": "<make model>", "value": <num>, "currency": "ILS",
    "details": { "plate", "year", "km", "ownership",
                 "make", "model", "trim", "fuel", "color" } }
  ```
  then `onSaved()`. Network error → keep modal open, inline error. Value
  required (finite > 0) before save.

### 3. `web/src/accounts/AccountsView.tsx` (edits)

- Drop `comingSoon: true` from the car tile.
- `AddFlow` union gains `'car'`.
- Car tile `onClick` → `setAddFlow('car')` (direct, like a leaf — no intermediate
  picker, since there is no provider list).
- Render `<Suspense><CarAssetForm onClose onSaved /></Suspense>` when
  `addFlow === 'car'`.
- **`AssetCard` car branch** (`kind === 'car'`):
  - Spec sub-line from `details` instead of the bare `{asset.kind}` —
    e.g. `2020 · 60,000 km · Blue` (graceful when fields are absent).
  - **`Re-check value ↗`** mini-button → opens Yad2 in a new tab **and** opens
    the existing `AssetEditModal` (value-focused). Plate is stored, so the user
    has it on hand to search Yad2.

---

## Data flow

```
Car tile → CarAssetForm
  → [optional] GET /vehicle/:plate → autofill spec card
  → user confirms / edits value (Yad2 handoff)
  → POST /assets → onSaved() → refresh()

Later: AssetCard (kind=car)
  → Re-check value → window.open(Yad2) + AssetEditModal → PUT /assets/:id
```

---

## Error handling

- Plate length `< 5` or `> 8` → inline validation, no network call.
- `GET /vehicle/:plate` returns `{ found:false }` or HTTP 502 → inline
  "enter by hand" note; form remains fully usable.
- `POST /assets` failure → modal stays open, inline `modal-err`.
- Missing/invalid value on save → inline validation, no POST.

---

## Testing (TDD — RED → verify fail → GREEN → verify pass → commit)

- **`vehicle.test.ts`** — `cleanPlate`, `isValidPlate` (4/5/8/9 digits),
  `vehicleName` (missing make or model), `ownershipKey` mapping incl. empty/null.
- **`CarAssetForm.test.tsx`** — lookup success autofills the spec card (mocked
  `GET /vehicle/:plate`); lookup `found:false` shows manual-entry hint and fields
  stay editable; save POSTs the exact payload shape; value-required guard; Yad2
  button calls `window.open` (mocked).
- **`AssetCard` car branch** — spec sub-line renders from details;
  `Re-check value` opens the editor + Yad2.
- **AccountsView integration** — car tile no longer `disabled`; clicking opens
  `CarAssetForm`.

Run from `web/` directly (`npm test`, `npm run typecheck`) — root double-passes
`--run`.

## Visual verification (PROJECT-RULES §2 — hard gate before "done")

chrome-devtools against the live engine: Assets → `+ Add asset` → Car →
screenshot the empty form → run a **real** plate lookup → screenshot the
populated polished spec card → save → screenshot the new car card's spec line +
`Re-check value` button. No "done"/commit-summary message before the screenshots
exist. Full web suite + both typechecks green.

---

## Out of scope

- Engine changes (none needed).
- Automatic price scraping (Yad2 stays a manual handoff — CAPTCHA-walled).
- Editing the plate after creation (re-check is value-focused).
- Re-running the plate lookup to diff spec changes over time (possible future
  follow-up; `details` stores the full spec to enable it later).
