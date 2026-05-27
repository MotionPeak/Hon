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
  onClose: () => void;       // hides modal locally; scrape continues engine-side
  hints?: ReactNode;         // per-provider hint slot
}
```

- Mount/unmount fully driven by the parent: parent mounts the modal when it starts a sync on a `company.interactive` connection and unmounts it when the sync's existing status (`'running' | 'needs-otp' | 'success' | 'error'`) leaves `running`. No internal status machine.
- Copy: "A browser window has opened — sign in there. Hon will grab your balances once you're in."
- Soft progress indicator + provider logo for grounding.
- **Customization seam:** `hints` slot allows provider-specific tips (e.g., Meitav captcha quirks) without rewriting the modal.
- Lazy-loaded via `React.lazy` + `Suspense` — matches the existing `SnapTradeLinkFlow` pattern in `AccountsView.tsx:11`. It's not on the hot path; only mounts on an interactive sync.

### Reuses (no contract changes)

- **`AddConnectionForm`** (~`AccountsView.tsx:1571`) — the existing credentials form, already generic over `company.loginFields`. **Mounted by `AccountsView` itself, not by the picker** — the picker calls `onPickCompany(c)` and the parent handles the rest. Pension providers route through the exact same path as banks/cards; nothing new to wire on the picker side beyond the `onPickCompany` callback.
- **`AddManualAssetForm`** (~`AccountsView.tsx:1487`) — currently defaults `kind` to `'cash'` and shows the same "Value" label regardless of kind. **Extension needed:** add an optional `initialKind?: string` prop (defaults to `'cash'`) so the picker can preset `'pension'`. The legacy SPA's "Amount accumulated" label tweak per kind is not currently implemented in this React form — out of scope for the first cut (label stays "Value"; the form still creates an asset with `kind: 'pension'`, which is what dashboard rendering keys off).
- **`OtpSheet`** — covers any `needs-otp` from the engine. Pension scrapes that emit `needs-otp` get the existing path for free.

### `AccountsView.tsx` edits

```ts
type PickerStep =
  | { kind: 'category' }
  | { kind: 'institution'; category: 'bank' | 'card' }
  | { kind: 'pension' }                                    // NEW
  | { kind: 'snaptrade-credentials' }
  | { kind: 'snaptrade-brokerages'; connectionId: string };
```

- Pension tile loses `comingSoon: true`; click handler in `renderCategoryStep` adds a branch for `tile.key === 'pension'` → `setStep({ kind: 'pension' })`.
- `PensionPickerStep` callbacks:
  - `onPickProvider(company)` → `onPickCompany(company)` (existing parent prop — closes picker, parent opens `AddConnectionForm` exactly as for banks).
  - `onPickCustom()` → `onPickManualAsset()` with a new `initialKind: 'pension'` arg (parent's `onPickManualAsset` will pass that through to `AddManualAssetForm`'s new `initialKind` prop).
  - `onBack()` → `setStep({ kind: 'category' })`.
- **No `institution-credentials` or `manual-pension` step variants needed** — the picker closes and the parent's existing credentials/manual-asset flows take over.
- **`onPickManualAsset` signature change:** add optional `initialKind?: string` arg, propagated to `AddManualAssetForm`. Existing call sites pass nothing → defaults to `'cash'` → unchanged behavior.
- **Interactive modal trigger:** the AccountsView render gains a second IIFE next to the existing OtpModal one, scanning `syncStates` for the first entry where `state.kind === 'running'` AND the corresponding connection's company has `interactive: true`. That mounts `InteractiveSignInModal`. Same single-modal-at-a-time pattern as OtpModal.
- New local state `dismissedInteractiveModalRunIds: Set<string>` (or equivalent) so the user's "Close" click on the modal doesn't immediately re-mount it on the next poll tick. Cleared when the run terminates.

## Data flow & state ownership

| State | Owner | Why here |
|---|---|---|
| `PickerStep` | `AddConnectionPicker` local `useState` | Picker concern only; pension adds one variant (`{ kind: 'pension' }`). |
| `companies`, `connections` | `AccountsView` (already fetched) | Pension providers are part of the same companies list — no new fetch. |
| `syncStateByConnection` (run status) | `AccountsView` map (existing) | Existing poll loop covers pension runs unchanged. |
| `dismissedInteractiveRunIds: Set<string>` | `AccountsView` (NEW local state) | Tracks runIds the user dismissed so the modal doesn't re-mount on the next poll tick. Cleared when a run terminates. Modal-render decision is derived: `state.kind === 'running' && company.interactive && !dismissedInteractiveRunIds.has(runId)`. |
| Vault unlock | `AccountsView` global (existing) | Pension scrapes require unlocked vault — same path as banks. |

**Customization seam:** modal trigger is a single `string | null` — straightforward to evolve into a richer shape later without touching call sites.

### Lifecycles

**Connect a scraped fund (Migdal/Harel/Clal/Meitav/Menora):**

```
Click pension tile → setStep({ kind: 'pension' })
PensionPickerStep → click provider → onPickCompany(company)
  → picker closes → parent opens AddConnectionForm (existing)
AddConnectionForm → fill loginFields → POST /connections (existing)
  → refresh connections → close form → toast (existing path).
```

**First sync on an interactive fund (Meitav/Menora):**

```
Click Sync → existing startSync(connection) → POST /connections/:id/scrape → { runId }
  → syncState[connectionId] = { kind: 'starting' }
Poll /scrape/:runId (existing pollRun) → syncState = { kind: 'running', runId }
  → AccountsView render detects: state.kind === 'running'
                              && company.interactive === true
                              && !dismissedInteractiveRunIds.has(runId)
  → mounts <InteractiveSignInModal company={...} onClose={...} />
  → engine pops OS Chrome window (OS-side, not in our DOM)
  → status stays 'running' while user signs in there
User completes sign-in → engine finishes → next poll returns 'success'
  → existing path: setSyncForConnection(id, { kind: 'idle' }) + refresh()
  → render condition no longer true → modal unmounts
  → card shows fresh balances

Close button → adds runId to dismissedInteractiveRunIds
  → render condition no longer true → modal unmounts
  → engine scrape continues; card still shows 'running' pill until poll terminates
  → on terminal status (success/error) the runId is removed from the dismissed set
```

**Custom pension:**

```
Click "Custom pension account" → onPickManualAsset('pension')
  → picker closes → parent opens AddManualAssetForm with initialKind='pension'
AddManualAssetForm (pension preselected in the Kind dropdown)
  → fill name + value → POST /assets (existing)
  → refresh assets → close form → existing path.
```

`AddManualAssetForm` gets an optional `initialKind?: string` prop (defaults to `'cash'`). The picker passes `'pension'`; user can still change the Kind dropdown if they hit the wrong row. The legacy SPA's "Amount accumulated" label tweak per kind is deferred (called out in non-goals).

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
| User clicks Close in modal | Local state clears `interactiveModalForConnectionId` | Modal unmounts; scrape continues engine-side; card still shows `running` pill until the scrape terminates (success / error / engine timeout). If the user also closes the OS Chrome window, the engine's interactive-timeout will surface as `error` on the next poll tick. |
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
- **New:** clicking Close in the modal hides it locally without posting anything; the connection's sync state stays `running` until the next poll tick resolves.
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
   - **Path C (custom):** Pension tile → "Custom pension account" → `AddManualAssetForm` renders with the Kind dropdown preselected to "Pension".
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
