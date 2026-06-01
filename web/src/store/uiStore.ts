// App-wide UI/client state, in a Zustand store. This replaces the custom
// window-event bus that previously wired cross-component navigation
// (`hon.go-to-loans`, `hon.go-to-assets`) and the localStorage-backed
// unseen-loans signal (`hon.loan-ids-changed`). Server state stays in TanStack
// Query — this store holds only CLIENT state (which tab is active, transient
// navigation intents, derived badge counts).
//
// Why Zustand: a tiny hooks store with no provider/boilerplate. Components
// select exactly the slice they use (`useUiStore((s) => s.tab)`) and only
// re-render when that slice changes. The old approach dispatched DOM
// CustomEvents and each listener re-read localStorage; this centralizes it.

import { create } from 'zustand';

export type Tab =
  | 'overview' | 'accounts' | 'activity' | 'recurring'
  | 'piggy' | 'vouchers' | 'loans' | 'insights' | 'settings';

/** localStorage key the AccountsView new-loan detector writes; the store
 *  reads it to seed + recompute the Loans-tab badge. */
const UNSEEN_LOANS_KEY = 'hon.unseenLoanIds';

function readUnseenLoanCount(): number {
  try {
    const v = JSON.parse(window.localStorage.getItem(UNSEEN_LOANS_KEY) ?? '[]');
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

interface UiState {
  /** The active top-level tab. */
  tab: Tab;
  setTab: (tab: Tab) => void;

  /**
   * One-shot intent for a tab to act on when it mounts — e.g. the empty Loans
   * tab asks to jump to Assets AND open the add-loan form. Replaces the
   * `hon.go-to-assets` + `hon.pendingAddLoan` event/flag pair. The target tab
   * reads then clears it.
   */
  pendingAction: 'add-loan' | null;
  /** Navigate to a tab, optionally carrying a pending action for it. */
  goTo: (tab: Tab, action?: 'add-loan') => void;
  clearPendingAction: () => void;

  /** Count of loans the user hasn't acknowledged — drives the Loans nav dot. */
  unseenLoanCount: number;
  /** Re-read the unseen-loans count from localStorage (call after a sync writes
   *  new loan ids; replaces the `hon.loan-ids-changed` event). */
  refreshUnseenLoans: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  tab: 'overview',
  setTab: (tab) => set({ tab }),

  pendingAction: null,
  goTo: (tab, action) => set({ tab, pendingAction: action ?? null }),
  clearPendingAction: () => set({ pendingAction: null }),

  unseenLoanCount: readUnseenLoanCount(),
  refreshUnseenLoans: () => set({ unseenLoanCount: readUnseenLoanCount() }),
}));

/** Imperative helpers for non-component call sites (e.g. inside other modules
 *  that used to `window.dispatchEvent(new CustomEvent('hon.go-to-loans'))`). */
export const uiActions = {
  goToLoans: () => useUiStore.getState().setTab('loans'),
  goToAssetsAddLoan: () => useUiStore.getState().goTo('accounts', 'add-loan'),
  refreshUnseenLoans: () => useUiStore.getState().refreshUnseenLoans(),
};
