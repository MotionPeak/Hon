# Assets page — History picker scope + polish

**Date:** 2026-05-30
**Status:** Approved (design)
**Scope:** UI-only. No engine, endpoint, schema, or sync-behaviour changes.

## Problem

On the Assets tab, every scraped connection card (Banks, Credit cards,
Investments, Pension) renders a per-connection **History** control — a native
`<select>` (`web/src/accounts/AccountsView.tsx:773`) that PATCHes
`/connections/:id/history-months`. Two issues:

1. **The control is shown where it does not belong.** The history window only
   meaningfully drives the date-windowed bank/card scrapers. On Pension and
   Investments (SnapTrade) cards it is noise.
2. **It is a raw native `<select>`.** Its resting state is unstyled relative to
   the card's Sync/Remove buttons, and opening it renders the OS-native option
   list, which clashes with the dark theme.

## Goal

1. Render the History control **only on Banks and Credit-cards** connection
   cards. Pension and Investments cards omit it entirely.
2. Replace the native `<select>` with a **custom dark dropdown** whose resting
   trigger matches the card-header buttons and whose open menu is fully styled
   (no OS-native list), with the active option highlighted in the app's amber
   accent.

## Non-goals

- **The mechanism stays.** `Connection.historyMonths`, `setHistoryMonths`, the
  optimistic-PATCH-with-revert flow, and `PATCH /connections/:id/history-months`
  are untouched. Pension and Investments connections keep their `historyMonths`
  default (12) and continue to sync with it — only the *visible control* is
  removed for those sections.
- No change to the Add-asset picker, the section grouping, or any other card
  region.
- No generic design-system extraction. The new component is focused on this one
  consumer (built on Radix so a future `MiniSelect` extraction is cheap, but not
  done now — YAGNI).

## Approach (A — Radix custom dropdown)

Selected over (B) an inline segmented pill — 5 segments crowd a header that
already holds Sync + Remove and drops the "opening" interaction the user wants —
and (C) a styled native `<select>`, which cannot restyle the OS-rendered open
list (the exact thing being rejected).

`@radix-ui/react-dropdown-menu` is already a project dependency and the
established primitive for action menus (`.menu-content` / `.menu-item` CSS
scaffolding already exists, jsdom pointer-capture polyfills already in
`web/src/test/setup.ts`).

## Components & changes

### 1. New component — `web/src/accounts/HistoryMonthsSelect.tsx`

A small controlled dropdown built on `@radix-ui/react-dropdown-menu`.

- **Props:** `{ value: number; onChange: (months: number) => void; disabled?: boolean }`.
- **Options:** `[3, 6, 12, 18, 24]` (module constant; matches today's native
  `<select>` options exactly).
- **Trigger:** a button styled to match the card-header buttons, rendering
  `{value} mo` + a chevron that rotates 180° when open (transition respects
  `prefers-reduced-motion`). `aria-label="History months"`.
- **Menu:** a `DropdownMenu.Content` reusing `.menu-content`; one
  `DropdownMenu.Item` per option rendering `{n} mo`; the item matching `value`
  gets an active treatment (amber text/background + a check glyph). Selecting an
  item calls `onChange(n)` and closes (Radix default). Escape / outside-click
  close handled by Radix.

### 2. Gating — `web/src/accounts/AccountsView.tsx`

- `renderSectionItems(key, …)` (`:691`) already knows each card's
  `AssetSectionKey`. Thread a `showHistory` boolean (`key === 'bank' || key === 'card'`)
  through `RowCallbacks` / the connection-card component's props.
- In the connection-card render (`:773`), wrap the existing
  `conn-history-label` block in `showHistory && (…)`, and swap the native
  `<select className="conn-history-select mini">` for
  `<HistoryMonthsSelect value={connection.historyMonths} onChange={(m) => callbacks.onSetHistoryMonths(connection, m)} />`.
- `onSetHistoryMonths` / `setHistoryMonths` are unchanged.

### 3. Styling — `web/src/styles.css`

- New trigger class (e.g. `.history-trigger`) mirroring the existing card-header
  button look (`.btn` family) — same height/radius/border so the header row
  stays aligned; overrides the global `button { white-space: nowrap }` only if
  needed (per PROJECT-RULES §6 reminder).
- Reuse `.menu-content` / `.menu-item` for the popup; add an active-item accent
  using the existing amber tone vars. Chevron rotation + menu open animation
  gated behind `@media (prefers-reduced-motion: no-preference)`.

## Data flow

Unchanged. `AccountsView` still fetches `/companies`, `/connections`,
`/accounts`, `/assets`, `/loans`, `/brokerage`; still holds `data.connections`
with `historyMonths`; selecting in the new dropdown calls the same
`setHistoryMonths` → optimistic state update → `PATCH /history-months` → revert
on error path that exists today.

## Testing

- **`web/src/accounts/HistoryMonthsSelect.test.tsx`** (new, TDD):
  - renders the current value in the trigger (`12 mo`);
  - opening the menu lists all five options;
  - clicking an option fires `onChange` with the right number;
  - the active option is marked (assert the active class / check).
- **`AccountsView` integration assertion** (extend existing test file):
  - History control present on a `bank` (and `card`) connection card;
  - History control absent on a `pension` and a `brokerage` connection card.
- `cd web && npm test` green; `cd web && npm run typecheck` clean. (Sidecar
  untouched, but run its suite once to confirm no incidental breakage.)

## Verification (PROJECT-RULES §2 — mandatory)

chrome-devtools MCP against the live app, screenshots read back:
1. A Banks/Credit-cards card — trigger restyled; open the menu and confirm the
   custom dark menu with amber active option (no OS-native list).
2. A Pension card and the IBKR/Investments card — confirm the History control is
   gone.
3. Selecting a new value updates the trigger and persists (re-open shows the new
   active option).

## Risks / edge cases

- **Header alignment.** The trigger must match button height or the Sync /
  Remove row will misalign — caught by the screenshot step.
- **Radix-in-jsdom.** Pointer-capture / `scrollIntoView` polyfills already exist
  in `web/src/test/setup.ts`; the dropdown-menu open-in-test pattern is used
  elsewhere in the suite — mirror it.
- **No other consumer of the native `conn-history-select`.** Confirm the
  `.conn-history-select` CSS is only used here before removing/replacing it.
