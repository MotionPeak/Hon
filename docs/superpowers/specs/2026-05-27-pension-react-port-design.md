# Pension flow → React port — design

**Date:** 2026-05-27
**Worktree:** `.claude/worktrees/pension-react-port-2026-05-27`
**Branch:** `session/pension-react-port-2026-05-27`
**Source brief:** HANDOFF.md "Pension flow port to React" — tile in
the React Assets picker is visible-but-disabled; engine-side scrapers
(Migdal/Harel/Clal automated; Meitav/Menora visible-window;
Altshuler manual) all ship and work in the legacy SPA.

## Goal

Make the Pension tile in `web/src/accounts/AccountsView.tsx`
functional with full parity to the legacy `sidecar/public/app.html`
pension flow: list pension/gemel/קרן השתלמות accounts, sync them
(including the visible-window flow for interactive funds), and
add/edit/remove connections. Custom (manual-entry) pensions also
covered.

Engine-side: no changes. `PENSION_COMPANIES`, `runPensionScrape`,
the OS visible-Chromium pop, vault/credentials persistence, and the
sync polling pipeline are already in place. This port is UI-only.

## Approach (B — dedicated PickerStep)

A new `{ kind: 'pension' }` variant in the existing `PickerStep`
discriminated union, backed by a new `PensionPickerStep` component
and a new `InteractiveSignInModal`. Everything else reuses the
existing infrastructure (credentials step, manual-asset form, sync
polling loop, OTP sheet for any non-interactive `needs-otp`).

**Why B over A (extend the bank-picker step) or C (split-by-interactive
sub-sections):**

- **Customization** — each asset category gets a focused picker
  component. Adding pension-specific UI later (e.g., retirement
  projection peek, per-product collapsed view) doesn't disturb the
  bank picker.
- **Look** — a dedicated component lets us actually design the
  pension picker (prominent provider logos, clear auto/browser-window
  tag chips, distinct "Custom pension account" row). Approach A
  would lock pension into the bank-picker visual treatment.
- **Scaling** — the upcoming Car port (next on the HANDOFF) will use
  the same dedicated-step pattern. So will any future asset category
  with scraped providers (crypto exchanges, alternative funds).
  Approach A grafts conditional branches onto one growing file.
- **Architecture vs visuals** — C's "auto vs interactive" split is
  a *property of pension today*; it doesn't generalize to Car or
  other categories. If we want that visual grouping later, it's a
  render-time choice inside the pension picker, not an architectural
  variant.

## Component contracts

### `PensionPickerStep.tsx` (new)

```ts
interface PensionPickerStepProps {
  companies: Company[];                          // unfiltered; component filters type==='pension'
  onPickProvider: (company: Company) => void;    // → InstitutionCredentialsStep
  onPickCustom: () => void;                      // → AddManualAssetForm (preset kind='pension')
  onBack: () => void;                            // → category step
}
```

- Stateless. List rendered from `companies.filter(c => c.type === 'pension')`.
- Row: provider logo (large), name, sub-line, tag chip (`auto` / `browser-window`).
- Sub-line copy: `!interactive` → "Synced automatically in the background"; `interactive` → "A browser window opens on each sync to clear a security check".
- Trailing custom row: ✍️ icon + "Custom pension account" + hint sub-line.
- Header copy mirrors legacy `renderPensionStep` (with Hebrew terms inline via `<bdi>`).
- **Customization seam:** row rendered by an exported `<PensionProviderRow>` sub-component so per-provider variants can be added later without touching the picker.

### `InteractiveSignInModal.tsx` (new)

```ts
interface InteractiveSignInModalProps {
  company: Company;          // for header (name + logo)
  onCancel: () => void;      // → POST /scrape/:runId/cancel
  hints?: ReactNode;         // per-provider hint slot
}
```

- Mount/unmount fully driven by the parent: parent mounts the modal when it starts a sync on a `company.interactive` connection and unmounts it when the sync's existing status (`'running' | 'needs-otp' | 'success' | 'error'`) leaves `running`. No internal status machine.
- Copy: "A browser window has opened — sign in there. Hon will grab your balances once you're in."
- Soft progress indicator + provider logo for grounding.
- **Customization seam:** `hints` slot allows provider-specific tips (e.g., Meitav captcha quirks) without rewriting the modal.
- Lazy-loaded via `React.lazy` + `Suspense` — matches the existing `SnapTradeLinkFlow` pattern in `AccountsView.tsx:11`. It's not on the hot path; only mounts on an interactive sync.

### Reuses (no contract changes)

- **`InstitutionCredentialsStep`** (~`AccountsView.tsx:1571`) — already generic, driven by `company.loginFields` + `company.interactive`. Pension providers' fields come straight from `PENSION_COMPANIES` on the engine.
- **`AddManualAssetForm`** (~`AccountsView.tsx:1487`) — already branches on `kind`; `kind: 'pension'` swaps the value label to "Amount accumulated". We pass it the preset.
- **`OtpSheet`** — covers any `needs-otp` from the engine. Pension scrapes that emit `needs-otp` get the existing path for free.

### `AccountsView.tsx` edits

```ts
type PickerStep =
  | { kind: 'category' }
  | { kind: 'institution'; category: 'bank' | 'card' }
  | { kind: 'pension' }                                    // NEW
  | { kind: 'snaptrade-credentials' }
  | { kind: 'snaptrade-brokerages'; connectionId: string }
  | { kind: 'institution-credentials'; company: Company }
  | { kind: 'manual-pension' };                            // NEW
```

- Pension tile loses `comingSoon: true`; click sets `{ kind: 'pension' }`.
- `PensionPickerStep` callbacks:
  - `onPickProvider(company)` → `setStep({ kind: 'institution-credentials', company })`
  - `onPickCustom()` → `setStep({ kind: 'manual-pension' })`
- New local state `interactiveModalForConnectionId: string | null`.
  - Sync starter sets it when `company.interactive`.
  - Poll loop unsets it when status leaves `running`.

## Data flow & state ownership

| State | Owner | Why here |
|---|---|---|
| `PickerStep` | `AddConnectionPicker` local `useState` | Picker concern only; pension adds two variants. |
| `companies`, `connections` | `AccountsView` (already fetched) | Pension providers are part of the same companies list — no new fetch. |
| `syncStateByConnection` (run status) | `AccountsView` map (existing) | Existing poll loop covers pension runs unchanged. |
| `interactiveModalForConnectionId` | `AccountsView` (NEW local state) | Co-located with sync state so modal lifecycle tracks poll updates. |
| Vault unlock | `AccountsView` global (existing) | Pension scrapes require unlocked vault — same path as banks. |

**Customization seam:** modal trigger is a single `string | null` — straightforward to evolve into a richer shape later without touching call sites.

### Lifecycles

**Connect a scraped fund (Migdal/Harel/Clal/Meitav/Menora):**

```
Click pension tile → setStep({ kind: 'pension' })
PensionPickerStep → click provider →
  setStep({ kind: 'institution-credentials', company })
InstitutionCredentialsStep → fill loginFields → POST /connections (existing)
  → refresh connections → close picker → toast "Connected."
```

**First sync on an interactive fund (Meitav/Menora):**

```
Click Sync → POST /connections/:id/scrape (existing) → { runId }
  → syncState = { kind: 'running', runId }
  → company.interactive === true → interactiveModalForConnectionId = id
Poll /scrape/:runId every ~1.5s (existing)
  → engine pops OS Chrome window (OS-side, not in our DOM)
  → status stays 'running' while user signs in there
  → InteractiveSignInModal stays open
User completes sign-in → engine finishes → next poll returns 'success'
  → syncState transitions → interactiveModalForConnectionId = null
  → modal unmounts → card shows fresh balances

Cancel button → POST /scrape/:runId/cancel (existing)
  → poll terminates → modal unmounts
```

**Custom pension:**

```
Click "Custom pension account" → setStep({ kind: 'manual-pension' })
AddManualAssetForm preset { kind: 'pension' }
  → fill name + amount → POST /assets (existing)
  → refresh assets → close picker → toast "Pension added."
```

### Non-changes

- No new global store. Local state in `AccountsView` is sufficient.
- No new polling. Reuses the existing per-run poll loop.
- No engine-side status enum changes. "Interactive" UI keyed entirely off `company.interactive` in React.

## Error handling

### Connect-time

| Failure | Detection | Behavior |
|---|---|---|
| Vault locked | Existing `vaultStatus !== 'unlocked'` check | Vault-unlock dialog first; on unlock, returns to pension picker step |
| `POST /connections` 4xx (bad credential shape) | Existing path in `InstitutionCredentialsStep` | Inline error inside the credentials step |
| `POST /connections` 5xx / network | Same | Inline error + Retry |
| Custom: `POST /assets` 4xx | `AddManualAssetForm` existing path | Inline form error |

### Sync-time (interactive funds)

| Failure | Detection | Behavior |
|---|---|---|
| Chrome window can't launch | Engine: `errorType: 'browser-launch'` | Modal closes; card red pill: "Couldn't open browser window." + "Show what happened" |
| User closes window without signing in | Engine: `INTERACTIVE_TIMEOUT_MS` exceeded → `errorType: 'login-timeout'` | Modal closes; card pill: "Sign-in window was closed. Try again." |
| Portal layout shifted (selectors miss) | Engine: error + HTML dump to `<dataDir>/debug/<companyId>-otp.html` | Modal closes; card pill: "Couldn't read the portal." + "Show what happened" |
| User clicks Cancel in modal | `POST /scrape/:runId/cancel` | Modal closes optimistically; poll → `error: cancelled`; neutral card pill "Sync cancelled." |
| Network blip between poll ticks | Existing retry/backoff | Modal stays open during transient; only closes on terminal status |

### Sync-time (automatic funds)

Same path as bank scrapes. No new handling. If engine emits `needs-otp`, the existing `OtpSheet` handles it.

### Edge cases

1. **Vault locked mid-sync** — engine reads credentials at scrape start; once running, immune to subsequent lock. Modal stays until terminal. No new handling.
2. **Back-out from picker** — `setStep({ kind: 'category' })` resets cleanly; picker state is local.
3. **Two simultaneous interactive syncs** — modal is single-value (`interactiveModalForConnectionId: string | null`). Sync button on the second connection is disabled while the first is `running` (existing bank behavior). One modal at a time.
4. **App reload mid-sync** — existing post-reload run re-attach handles it. Modal re-keys off `(status === 'running' && company.interactive)`; no new code.
5. **Custom pension with `kind: 'pension'`** — flows into the Pension section of the dashboard via existing `asset.kind === 'pension'` logic. Renders alongside scraped pensions.
6. **Removing an interactive pension connection** — existing `DELETE /connections/:id`. Connection card overflow menu already has Remove.

### Explicit non-handling

- **No optimistic balances on failed scrape.** "Balances reflect the last successful scrape" invariant preserved.
- **No global error banner for sync failures.** Errors live on the connection card.
- **No new "session-expired" UI.** Saved-session reuse is an engine concern; both fresh sign-in and cookie sign-in present to the user as a normal interactive sync.

## Testing

### New unit tests

**`PensionPickerStep.test.tsx`**
- One row per `type === 'pension'` company; non-pension excluded.
- `auto` tag for `!interactive`; `browser-window` tag for `interactive`.
- Custom row last, visually distinct.
- Click provider row → `onPickProvider(company)` called with that company.
- Click custom row → `onPickCustom()` called.
- Click Back → `onBack()` called.
- Empty pension list → only custom row + hint.

**`InteractiveSignInModal.test.tsx`**
- Renders only when given a connection; hidden otherwise.
- Shows company name + logo in header.
- Cancel calls `onCancel()`.
- Renders `hints` slot when provided.

### Updates to existing `AccountsView.test.tsx`

- **Replace** the assertion that the pension tile is disabled with: clicking it advances to `PensionPickerStep`.
- **New:** clicking Sync on an interactive pension connection mounts `InteractiveSignInModal`; mocked poll → `success` unmounts it.
- **New:** clicking Cancel in the modal POSTs `/scrape/:runId/cancel`.
- **New:** custom-pension row → `AddManualAssetForm` mounts with `kind='pension'` preset; submit posts to `/assets`.
- **Keep** the existing "Harel pension renders in Pension section" test as-is (already passes).

### Engine tests

None. Engine pension code is untouched.

### Visual verification (per PROJECT-RULES §2)

After tests pass, before claiming done:

1. `npm run dev` from the worktree (web at `localhost:5173`, sidecar at its dev port).
2. `chrome-devtools` MCP — headed Chrome on CDP 9222, throwaway profile (`/tmp/chrome-cdp-profile`) per the rules.
3. Load `http://localhost:5173/#token=<dev-token>` via `mcp__chrome-devtools__new_page`; token from `~/Library/Application Support/Hon/dev-token`.
4. Walk three paths, screenshot each:
   - **Path A (auto):** Assets → Add → Pension tile → picker shows providers + custom row → click Migdal → credential step renders one row per `loginFields` entry.
   - **Path B (interactive):** Pension tile → click Meitav → credential step shows interactive-fund copy.
   - **Path C (custom):** Pension tile → "Custom pension account" → `AddManualAssetForm` renders with "Amount accumulated" label.
5. `mcp__chrome-devtools__take_screenshot` → `Read` each PNG → confirm with own eyes.
6. If anything off: debug via `evaluate_script` (don't guess at CSS).

**Cannot verify end-to-end** without Shahar's real Meitav/Menora credentials — the live OS-window behavior stays an engine integration tested by hand. Call this out in the HANDOFF entry. The modal mount/unmount is covered by unit tests with a mocked poll.

## Non-goals

- No updates to `sidecar/public/app.html` pension flow — legacy stays parallel until cleanup later (same pattern as the other React ports).
- No engine-side pension changes.
- No new pension-specific dashboard widgets (retirement projection, payout estimates, etc.) — future work. The customization seams (sub-component row, modal hints slot) are in place to add these without churn.

## React best-practices applied (per PROJECT-RULES §4)

- `PensionPickerStep` and `InteractiveSignInModal` declared at module level — never as nested components — per `rerender-no-inline-components`.
- The modal is rendered lazily via `React.lazy` + `Suspense` (it's not on the hot path; only mounts on an interactive sync) per `bundle-dynamic-imports`.
- Sync-polling callbacks continue using the existing `use-latest` ref pattern from the bank flow — no change.
- `useDeferredValue` not applicable here (pension list is short — ≤6 providers).

## Files touched (estimated)

| Path | Change |
|---|---|
| `web/src/accounts/AccountsView.tsx` | Add `PickerStep` variants, drop `comingSoon`, route pension tile, render new step variants, modal state |
| `web/src/accounts/PensionPickerStep.tsx` | NEW |
| `web/src/accounts/InteractiveSignInModal.tsx` | NEW |
| `web/src/accounts/AccountsView.test.tsx` | Update disabled-tile test; add modal + custom-pension tests |
| `web/src/accounts/PensionPickerStep.test.tsx` | NEW |
| `web/src/accounts/InteractiveSignInModal.test.tsx` | NEW |

## Out of scope (deferred)

- Pension-specific dashboard widgets (retirement projection, expected payout)
- Per-provider variants of `PensionProviderRow` (seam exists; no real variant yet)
- Removing the legacy SPA pension flow
