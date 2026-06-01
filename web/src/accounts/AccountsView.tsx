import { useCallback, useEffect, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from '../api';
import { uiActions } from '../store/uiStore';
import { money } from '../format';
import type {
  Account, AssetSectionKey, BrokerageOption, Company, Connection, Holding, Loan, ManualAsset,
} from './types';
import { carSubline, YAD2_PRICE_LIST } from './vehicle';
import { DelayedLoader } from '../ui/DelayedLoader';
import { SnapTradeBrokeragePicker } from './SnapTradeBrokeragePicker';
import { PensionPickerStep } from './PensionPickerStep';
import { CompanyLogo } from './CompanyLogo';
import { HistoryMonthsSelect } from './HistoryMonthsSelect';

const SnapTradeLinkFlow = lazy(() =>
  import('./SnapTradeLinkFlow').then((m) => ({ default: m.SnapTradeLinkFlow })),
);

const InteractiveSignInModal = lazy(() =>
  import('./InteractiveSignInModal').then((m) => ({ default: m.InteractiveSignInModal })),
);

const CarAssetForm = lazy(() =>
  import('./CarAssetForm').then((m) => ({ default: m.CarAssetForm })),
);

// Polling interval while a scrape is in-flight. Short enough that tests
// resolve quickly via waitFor; long enough that production polling isn't
// a CPU/network drag.
const SCRAPE_POLL_INTERVAL_MS = 200;

// localStorage keys backing the new-loan detection.
// - `STORE_KNOWN`: ids the user has acknowledged (cleared + rewritten when
//   they open the Loans tab OR dismiss the banner).
// - `STORE_UNSEEN`: queue of fresh ids that triggered the banner / nav dot.
// The custom event lets same-tab listeners (the nav dot in App.tsx)
// re-render — the built-in `storage` event only fires across tabs.
const STORE_KNOWN = 'hon.knownLoanIds';
const STORE_UNSEEN = 'hon.unseenLoanIds';
const LOAN_IDS_EVENT = 'hon.loan-ids-changed';
const readLoanIds = (key: string): string[] => {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const writeLoanIds = (key: string, ids: string[]): void => {
  window.localStorage.setItem(key, JSON.stringify(Array.from(new Set(ids))));
  window.dispatchEvent(new Event(LOAN_IDS_EVENT));
  // Same-tab writes don't fire the browser `storage` event (cross-tab only),
  // so refresh the Zustand nav-badge count directly — otherwise the Loans dot
  // goes stale after a sync or dismiss until a reload.
  uiActions.refreshUnseenLoans();
};

interface RunStatus {
  runId: string;
  connectionId: string;
  status: 'running' | 'needs-otp' | 'success' | 'error';
  message: string;
  accountsCount: number;
  transactionsCount: number;
  startedAt: string;
  finishedAt?: string;
}

type SyncState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; runId: string; message: string }
  | { kind: 'needs-otp'; runId: string; message: string }
  | { kind: 'success'; accountsCount: number; transactionsCount: number }
  | { kind: 'error'; message: string };

// Modals escape stacking contexts (cards have transforms / animations that
// turn into containing blocks). Same pattern as CategoriesPanel.
function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

interface SectionDef {
  key: AssetSectionKey;
  label: string;
  emoji: string;
}

const SECTIONS: SectionDef[] = [
  { key: 'bank',      label: 'Banks',             emoji: '🏦' },
  { key: 'card',      label: 'Credit cards',      emoji: '💳' },
  { key: 'brokerage', label: 'Investments',       emoji: '📈' },
  { key: 'pension',   label: 'Pension',           emoji: '🪺' },
  { key: 'asset',     label: 'Other assets',      emoji: '💎' },
  // Loans intentionally NOT rendered here — they live exclusively in
  // the Loans tab. The /loans fetch is kept so the new-loan banner +
  // nav-dot can still diff against localStorage.
];

function sectionKeyForConnection(conn: Connection, companies: Company[]): AssetSectionKey {
  const company = companies.find((c) => c.id === conn.companyId);
  if (!company) return 'bank';
  if (company.type === 'card') return 'card';
  if (company.type === 'brokerage') return 'brokerage';
  if (company.type === 'pension') return 'pension';
  return 'bank';
}

interface AccountsData {
  companies: Company[];
  connections: Connection[];
  accounts: Account[];
  assets: ManualAsset[];
  loans: Loan[];
  holdings: Holding[];
}

/** Value/gain math for one holding. Mirrors holdingStats() in app.html. */
function holdingStats(h: Holding): {
  value: number | null; cost: number | null;
  gain: number | null; gainPct: number | null;
} {
  const value = h.value != null
    ? h.value
    : h.price != null ? h.units * h.price : null;
  const cost = h.costBasis != null ? h.units * h.costBasis : null;
  const gain = value != null && cost != null
    ? value - cost
    : h.openPnl;
  const gainPct = gain != null && cost ? (gain / Math.abs(cost)) * 100 : null;
  return { value, cost, gain, gainPct };
}

function fmtUnits(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return Number.isInteger(r) ? String(r) : r.toFixed(4).replace(/0+$/, '');
}

export function AccountsView() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [editingBalance, setEditingBalance] = useState<Account | null>(null);
  const [removingConnection, setRemovingConnection] = useState<Connection | null>(null);
  const [editingCredentials, setEditingCredentials] = useState<Connection | null>(null);
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({});
  const [expandedHoldings, setExpandedHoldings] = useState<Record<string, boolean>>({});
  const [editingAsset, setEditingAsset] = useState<ManualAsset | null>(null);
  const [removingAsset, setRemovingAsset] = useState<ManualAsset | null>(null);
  const [editingLoan, setEditingLoan] = useState<Loan | null>(null);
  const [removingLoan, setRemovingLoan] = useState<Loan | null>(null);
  // runIds that the user has dismissed from the InteractiveSignInModal.
  // The engine-side scrape continues; we just hide the modal locally.
  // Cleared when the run terminates so a re-sync shows the modal again.
  const [dismissedInteractiveRunIds, setDismissedInteractiveRunIds] =
    useState<Set<string>>(() => new Set());
  // Add-asset flow:
  //   null            — closed
  //   'picker'        — list of companies + manual-asset / manual-loan rows
  //   Company         — credential form for a bank/card provider
  //   'manual-asset'  — form for a hand-entered asset (car/property/cash/…)
  //   'manual-loan'   — form for a hand-entered loan (Spitzer amortisation)
  type AddFlow = null | 'picker' | 'manual-asset' | 'manual-loan' | 'manual-pension' | 'car' | Company;
  const [addFlow, setAddFlow] = useState<AddFlow>(null);

  // The empty Loans tab's "+ Add a loan" button sends the user here and asks us
  // to open the loan form. The handoff rides a localStorage flag (not a window
  // event) because AccountsView isn't mounted when Loans dispatches — we read it
  // once on mount and clear it.
  useEffect(() => {
    if (window.localStorage.getItem('hon.pendingAddLoan') === '1') {
      window.localStorage.removeItem('hon.pendingAddLoan');
      setAddFlow('manual-loan');
    }
  }, []);
  // When set, render <SnapTradeLinkFlow> in its own modal portal. Holds the
  // connectionId of the newly-created (or existing) SnapTrade connection,
  // and (optionally) a pre-selected broker if the user picked one in the
  // Add-asset modal's inline brokerage list.
  interface LinkTarget {
    connectionId: string;
    brokerSlug?: string;
    brokerName?: string;
  }
  const [linkSnapTradeFor, setLinkSnapTradeFor] = useState<LinkTarget | null>(null);

  const toggleHoldings = useCallback((accountId: string) => {
    setExpandedHoldings((prev) => ({ ...prev, [accountId]: !prev[accountId] }));
  }, []);
  // Active polling timers per connection — kept in a ref so re-renders don't
  // forget pending intervals when a sync transitions states.
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const refresh = useCallback(async (): Promise<AccountsData> => {
    try {
      const [c, conn, acc, ast, l, brk] = await Promise.all([
        api<{ companies: Company[] }>('/companies'),
        api<{ connections: Connection[] }>('/connections'),
        api<{ accounts: Account[] }>('/accounts'),
        api<{ assets: ManualAsset[] }>('/assets'),
        api<{ loans: Loan[] }>('/loans'),
        api<{ holdings: Holding[] }>('/brokerage'),
      ]);
      const next: AccountsData = {
        companies: c.companies, connections: conn.connections, accounts: acc.accounts,
        assets: ast.assets, loans: l.loans, holdings: brk.holdings,
      };
      setData(next);
      return next;
    } catch {
      const empty: AccountsData = {
        companies: [], connections: [], accounts: [], assets: [], loans: [], holdings: [],
      };
      setData(empty);
      return empty;
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // New-loan detection. After every /loans load, diff current ids against
  // the user-acknowledged set in localStorage; unfamiliar ids land in the
  // "unseen" queue, which renders the inline banner below and lights up
  // the Loans sidebar nav dot. Acknowledgement happens when the user
  // dismisses the banner or opens the Loans tab.
  const [storageTick, setStorageTick] = useState(0);
  useEffect(() => {
    if (!data) return;
    const currentIds = data.loans.map((l) => l.id);
    const known = readLoanIds(STORE_KNOWN);
    const fresh = currentIds.filter((id) => !known.includes(id));
    if (fresh.length === 0) return;
    const unseen = readLoanIds(STORE_UNSEEN);
    writeLoanIds(STORE_UNSEEN, [...unseen, ...fresh]);
  }, [data]);
  // Re-render when localStorage changes (the dismiss button mutates it).
  useEffect(() => {
    const h = (): void => setStorageTick((t) => t + 1);
    window.addEventListener(LOAN_IDS_EVENT, h);
    window.addEventListener('storage', h);
    return () => {
      window.removeEventListener(LOAN_IDS_EVENT, h);
      window.removeEventListener('storage', h);
    };
  }, []);
  void storageTick; // touched only as a re-render trigger

  // Clear all polling timers on unmount.
  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      Object.values(timers).forEach((t) => clearTimeout(t));
    };
  }, []);

  // Store a connection's pending timer, cancelling any handle already in the
  // slot first. Without this, overwriting pollTimers.current[id] by direct
  // assignment leaves the prior setTimeout scheduled — most dangerously the
  // 5s success auto-clear, which would fire on a re-started sync and force the
  // live run back to idle (and leak timers besides).
  const schedule = useCallback((connectionId: string, fn: () => void, ms: number) => {
    clearTimeout(pollTimers.current[connectionId]);
    pollTimers.current[connectionId] = setTimeout(fn, ms);
  }, []);
  // Cancel a connection's pending timer and free the slot.
  const clearScheduled = useCallback((connectionId: string) => {
    clearTimeout(pollTimers.current[connectionId]);
    delete pollTimers.current[connectionId];
  }, []);

  const setSyncForConnection = useCallback((connectionId: string, next: SyncState) => {
    setSyncStates((prev) => ({ ...prev, [connectionId]: next }));
  }, []);

  // Poll one connection's run until it terminates. Schedules itself via
  // setTimeout to avoid stacked intervals if the previous poll is slow.
  const pollRun = useCallback(async (connectionId: string, runId: string) => {
    try {
      const { run } = await api<{ run: RunStatus }>(`/scrape/${encodeURIComponent(runId)}`);
      if (run.status === 'running') {
        setSyncForConnection(connectionId, { kind: 'running', runId, message: run.message });
        schedule(connectionId, () => void pollRun(connectionId, runId), SCRAPE_POLL_INTERVAL_MS);
      } else if (run.status === 'needs-otp') {
        setSyncForConnection(connectionId, { kind: 'needs-otp', runId, message: run.message });
        // Keep polling — the OTP modal posts the code, then the run goes
        // back to running and eventually success/error.
        schedule(connectionId, () => void pollRun(connectionId, runId), SCRAPE_POLL_INTERVAL_MS);
      } else if (run.status === 'success') {
        setSyncForConnection(connectionId, {
          kind: 'success',
          accountsCount: run.accountsCount,
          transactionsCount: run.transactionsCount,
        });
        // Clear any dismissed interactive-run marker for this run before
        // refresh() flushes — both setters batch together before the await,
        // so the dismissed entry never outlives the run.
        setDismissedInteractiveRunIds((prev) => {
          if (!prev.has(runId)) return prev;
          const next = new Set(prev);
          next.delete(runId);
          return next;
        });
        await refresh();
        // Auto-clear after 5s. Stash the timer in pollTimers so the
        // existing unmount-cleanup catches it.
        schedule(connectionId, () => {
          setSyncForConnection(connectionId, { kind: 'idle' });
        }, 5000);
      } else {
        setSyncForConnection(connectionId, { kind: 'error', message: run.message || 'Sync failed' });
        setDismissedInteractiveRunIds((prev) => {
          if (!prev.has(runId)) return prev;
          const next = new Set(prev);
          next.delete(runId);
          return next;
        });
      }
    } catch (e) {
      setSyncForConnection(connectionId, {
        kind: 'error',
        message: e instanceof ApiError ? e.message : String(e),
      });
      setDismissedInteractiveRunIds((prev) => {
        if (!prev.has(runId)) return prev;
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  }, [refresh, setSyncForConnection, schedule]);

  const startSync = useCallback(async (connectionId: string) => {
    // Cancel any lingering timer for this connection (e.g. the 5s success
    // auto-clear from a just-finished run) so it can't fire mid-flight and
    // knock this fresh run back to idle.
    clearScheduled(connectionId);
    setSyncForConnection(connectionId, { kind: 'starting' });
    try {
      // interactive=true picks the engine's runInteractiveScrape path,
      // which wires the OTP watcher for the banks in
      // HON_OTP_WATCHER_COMPANIES (Beinleumi, Hapoalim, Otsar Hahayal,
      // Massad, Pagi). Headless mode has no watcher and hangs at
      // LOGGING_IN when the bank shows its 2FA page.
      // Engine picks the per-connection historyMonths default.
      const { runId } = await api<{ runId: string }>(
        `/connections/${encodeURIComponent(connectionId)}/scrape`,
        'POST',
        { interactive: true },
      );
      setSyncForConnection(connectionId, { kind: 'running', runId, message: 'Starting…' });
      void pollRun(connectionId, runId);
    } catch (e) {
      setSyncForConnection(connectionId, {
        kind: 'error',
        message: e instanceof ApiError ? e.message : String(e),
      });
    }
  }, [pollRun, setSyncForConnection, clearScheduled]);

  const setHistoryMonths = useCallback(async (connection: Connection, months: number) => {
    // Optimistic update.
    const previous = connection.historyMonths;
    setData((d) => d && ({
      ...d,
      connections: d.connections.map((c) =>
        c.id === connection.id ? { ...c, historyMonths: months } : c,
      ),
    }));
    try {
      await api(
        `/connections/${encodeURIComponent(connection.id)}/history-months`,
        'PATCH',
        { historyMonths: months },
      );
    } catch {
      // Revert on failure.
      setData((d) => d && ({
        ...d,
        connections: d.connections.map((c) =>
          c.id === connection.id ? { ...c, historyMonths: previous } : c,
        ),
      }));
    }
  }, []);

  const toggleAccountExcluded = useCallback(async (a: Account, excluded: boolean) => {
    try {
      await api(`/accounts/${encodeURIComponent(a.id)}/excluded`, 'PATCH', { excluded });
      await refresh();
    } catch {
      // Best-effort — re-fetch so the pill reverts to the stored state.
      await refresh();
    }
  }, [refresh]);

  const toggleAssetExcluded = useCallback(async (a: ManualAsset, excluded: boolean) => {
    try {
      await api(`/assets/${encodeURIComponent(a.id)}`, 'PUT', { excluded });
      await refresh();
    } catch {
      await refresh();
    }
  }, [refresh]);

  const toggleLoanExcluded = useCallback(async (l: Loan, excluded: boolean) => {
    try {
      await api(`/loans/${encodeURIComponent(l.id)}/excluded`, 'PATCH', { excluded });
      await refresh();
    } catch {
      await refresh();
    }
  }, [refresh]);

  if (!data) return <DelayedLoader />;

  const sectionCount = (key: AssetSectionKey): number => {
    if (key === 'asset') return data.assets.length;
    if (key === 'loan') return 0; // see SECTIONS comment
    return data.connections.filter(
      (c) => sectionKeyForConnection(c, data.companies) === key,
    ).length;
  };

  const totalItems = data.connections.length + data.assets.length;

  return (
    <div className="accounts-view">
      <div className="accounts-head">
        <h1>Assets</h1>
        <button type="button" className="mini" onClick={() => setAddFlow('picker')}>
          + Add asset
        </button>
      </div>
      <NewLoanBanner data={data} />
      {totalItems === 0 ? (
        <p className="hint">Nothing here yet — hit + Add asset.</p>
      ) : (
      <div className="assets-grid">
        {SECTIONS.map((s) => {
          const count = sectionCount(s.key);
          if (count === 0) return null;
          return (
            <section key={s.key} className="assets-section">
              <h3 className="assets-sub-head">
                <span className="ash-emoji">{s.emoji}</span>
                <span className="ash-label">{s.label}</span>
                <span className="ash-count">{count}</span>
              </h3>
              <div className="assets-stack">
                {renderSectionItems(s.key, data, {
                  onEditBalance: setEditingBalance,
                  onToggleAccountExcluded: toggleAccountExcluded,
                  onToggleAssetExcluded: toggleAssetExcluded,
                  onToggleLoanExcluded: toggleLoanExcluded,
                  onRemoveConnection: setRemovingConnection,
                  onSetCredentials: setEditingCredentials,
                  onSync: (c) => startSync(c.id),
                  onSetHistoryMonths: setHistoryMonths,
                  onToggleHoldings: toggleHoldings,
                  onEditAsset: setEditingAsset,
                  onRemoveAsset: setRemovingAsset,
                  onEditLoan: setEditingLoan,
                  onRemoveLoan: setRemovingLoan,
                  onLinkSnapTradeBrokerage: (connectionId) => setLinkSnapTradeFor({ connectionId }),
                  syncStates,
                  holdings: data.holdings,
                  expandedHoldings,
                })}
              </div>
            </section>
          );
        })}
      </div>
      )}
      {editingBalance && (
        <BalanceModal
          account={editingBalance}
          onClose={() => setEditingBalance(null)}
          onSaved={async () => { setEditingBalance(null); await refresh(); }}
        />
      )}
      {removingConnection && (
        <RemoveConnectionDialog
          connection={removingConnection}
          onClose={() => setRemovingConnection(null)}
          onConfirmed={async () => { setRemovingConnection(null); await refresh(); }}
        />
      )}
      {editingCredentials && (
        <CredentialsModal
          connection={editingCredentials}
          company={data.companies.find((c) => c.id === editingCredentials.companyId)}
          onClose={() => setEditingCredentials(null)}
          onSaved={async () => { setEditingCredentials(null); await refresh(); }}
        />
      )}
      {editingAsset && (
        <AssetEditModal
          asset={editingAsset}
          onClose={() => setEditingAsset(null)}
          onSaved={async () => { setEditingAsset(null); await refresh(); }}
        />
      )}
      {removingAsset && (
        <ConfirmRemoveDialog
          title={removingAsset.name}
          body="Remove this asset. Manual entries elsewhere are unaffected. This cannot be undone."
          onClose={() => setRemovingAsset(null)}
          onConfirmed={async () => {
            await api(`/assets/${encodeURIComponent(removingAsset.id)}`, 'DELETE');
            setRemovingAsset(null);
            await refresh();
          }}
        />
      )}
      {editingLoan && (
        <LoanEditModal
          loan={editingLoan}
          onClose={() => setEditingLoan(null)}
          onSaved={async () => { setEditingLoan(null); await refresh(); }}
        />
      )}
      {removingLoan && (
        <ConfirmRemoveDialog
          title={removingLoan.name}
          body="Remove this loan. The amortisation schedule and any computed payoff projections will go with it."
          onClose={() => setRemovingLoan(null)}
          onConfirmed={async () => {
            await api(`/loans/${encodeURIComponent(removingLoan.id)}`, 'DELETE');
            setRemovingLoan(null);
            await refresh();
          }}
        />
      )}
      {addFlow === 'picker' && (
        <AddConnectionPicker
          companies={data.companies}
          connections={data.connections}
          onPickCompany={(c) => setAddFlow(c)}
          onPickManualAsset={() => setAddFlow('manual-asset')}
          onPickManualLoan={() => setAddFlow('manual-loan')}
          onPickManualPension={() => setAddFlow('manual-pension')}
          onPickCar={() => setAddFlow('car')}
          onPickBrokerage={(connectionId, brokerSlug, brokerName) => {
            setAddFlow(null);
            setLinkSnapTradeFor({ connectionId, brokerSlug, brokerName });
          }}
          onClose={() => setAddFlow(null)}
        />
      )}
      {addFlow === 'manual-asset' && (
        <AddManualAssetForm
          onClose={() => setAddFlow(null)}
          onSaved={async () => { setAddFlow(null); await refresh(); }}
        />
      )}
      {addFlow === 'manual-loan' && (
        <AddManualLoanForm
          onClose={() => setAddFlow(null)}
          onSaved={async () => { setAddFlow(null); await refresh(); }}
        />
      )}
      {addFlow === 'manual-pension' && (
        <AddManualAssetForm
          initialKind="pension"
          onClose={() => setAddFlow(null)}
          onSaved={async () => { setAddFlow(null); await refresh(); }}
        />
      )}
      {addFlow === 'car' && (
        <Suspense fallback={null}>
          <CarAssetForm
            onClose={() => setAddFlow(null)}
            onSaved={async () => { setAddFlow(null); await refresh(); }}
          />
        </Suspense>
      )}
      {typeof addFlow === 'object' && addFlow !== null && (
        <AddConnectionForm
          company={addFlow}
          onClose={() => setAddFlow(null)}
          onSaved={async (connectionId) => {
            await refresh();
            if (addFlow.type === 'brokerage') {
              setAddFlow(null);
              setLinkSnapTradeFor({ connectionId });
            } else {
              // Scraped connection (bank / card / pension): kick off the
              // first sync immediately so the user doesn't have to find and
              // press Sync after connecting. refresh() above has already
              // put the connection into `data`, so the running-state UI
              // (incl. the interactive sign-in modal for Meitav/Menora) can
              // resolve it. Brokerages skip this — they sync via the
              // SnapTrade link flow instead.
              setAddFlow(null);
              void startSync(connectionId);
            }
          }}
        />
      )}
      {linkSnapTradeFor !== null && (
        <ModalPortal>
          <div className="overlay">
            <div role="dialog" aria-label="Link a brokerage" className="modal">
              <Suspense fallback={<p className="snaptrade-flow-loading">Loading…</p>}>
                <SnapTradeLinkFlow
                  connectionId={linkSnapTradeFor.connectionId}
                  initialBrokerSlug={linkSnapTradeFor.brokerSlug}
                  initialBrokerName={linkSnapTradeFor.brokerName}
                  onLinked={async () => {
                    const before = data?.accounts.length ?? 0;
                    await api(`/connections/${linkSnapTradeFor.connectionId}/scrape`, 'POST', {});
                    const next = await refresh();
                    const after = next.accounts.length;
                    return { accountsAdded: Math.max(0, after - before) };
                  }}
                  onCancel={() => setLinkSnapTradeFor(null)}
                />
              </Suspense>
            </div>
          </div>
        </ModalPortal>
      )}
      {(() => {
        // Render at most one OTP modal — the first connection that needs one.
        const entry = Object.entries(syncStates)
          .find(([, s]) => s.kind === 'needs-otp');
        if (!entry) return null;
        const [connectionId, state] = entry;
        if (state.kind !== 'needs-otp') return null;
        return (
          <OtpModal
            runId={state.runId}
            message={state.message}
            onClose={() => setSyncForConnection(connectionId, { kind: 'idle' })}
            onSubmitted={() => {
              // Keep state as needs-otp briefly — the next poll will move to
              // running or success. Don't reset to idle here.
            }}
          />
        );
      })()}
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
              // Scope the modal to its connection so that when the chosen
              // running connection changes (multiple interactive syncs in
              // flight), React remounts a fresh modal instead of reusing the
              // previous connection's instance — which otherwise flickers /
              // briefly shows the wrong company in the header.
              key={connectionId}
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
    </div>
  );
}

interface RowCallbacks {
  onEditBalance: (account: Account) => void;
  onToggleAccountExcluded: (account: Account, excluded: boolean) => void | Promise<void>;
  onToggleAssetExcluded: (asset: ManualAsset, excluded: boolean) => void | Promise<void>;
  onToggleLoanExcluded: (loan: Loan, excluded: boolean) => void | Promise<void>;
  onRemoveConnection: (connection: Connection) => void;
  onSetCredentials: (connection: Connection) => void;
  onSync: (connection: Connection) => void;
  onSetHistoryMonths: (connection: Connection, months: number) => void;
  onToggleHoldings: (accountId: string) => void;
  onEditAsset: (asset: ManualAsset) => void;
  onRemoveAsset: (asset: ManualAsset) => void;
  onEditLoan: (loan: Loan) => void;
  onRemoveLoan: (loan: Loan) => void;
  onLinkSnapTradeBrokerage: (connectionId: string) => void;
  syncStates: Record<string, SyncState>;
  holdings: Holding[];
  expandedHoldings: Record<string, boolean>;
}

function NewLoanBanner({ data }: { data: AccountsData }) {
  const unseen = readLoanIds(STORE_UNSEEN);
  if (unseen.length === 0) return null;
  const ids = new Set(unseen);
  const newLoans = data.loans.filter((l) => ids.has(l.id));
  if (newLoans.length === 0) return null;
  const connNameById = new Map(data.connections.map((c) => [c.id, c.displayName]));
  const bankNames = Array.from(new Set(
    newLoans.map((l) => (l.connectionId && connNameById.get(l.connectionId)) || 'a connection'),
  ));
  const dismiss = (): void => {
    const known = readLoanIds(STORE_KNOWN);
    writeLoanIds(STORE_KNOWN, [...known, ...unseen]);
    writeLoanIds(STORE_UNSEEN, []);
  };
  return (
    <div className="new-loan-banner" data-testid="new-loan-banner">
      <span className="new-loan-banner-emoji">✨</span>
      <span>
        Found {newLoans.length} new loan{newLoans.length === 1 ? '' : 's'}
        {' from '}{bankNames.join(', ')}
        {' — '}
        <button
          type="button"
          className="new-loan-banner-link"
          onClick={dismiss}
        >View in Loans</button>
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="new-loan-banner-dismiss"
        aria-label="Dismiss"
        onClick={dismiss}
      >✕</button>
    </div>
  );
}

function renderSectionItems(key: AssetSectionKey, data: AccountsData, cb: RowCallbacks) {
  if (key === 'asset') {
    return data.assets
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => <AssetCard key={a.id} asset={a} callbacks={cb} />);
  }
  if (key === 'loan') {
    return data.loans
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => <LoanCard key={l.id} loan={l} callbacks={cb} />);
  }
  return data.connections
    .filter((c) => sectionKeyForConnection(c, data.companies) === key)
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((c) => (
      <ConnectionCard
        key={c.id}
        connection={c}
        company={data.companies.find((x) => x.id === c.companyId)}
        accounts={data.accounts.filter((a) => a.connectionId === c.id)}
        callbacks={cb}
        showHistory={key === 'bank' || key === 'card'}
      />
    ));
}

interface ConnectionCardProps {
  connection: Connection;
  company?: Company;
  accounts: Account[];
  callbacks: RowCallbacks;
  showHistory: boolean;
}

function ConnectionCard({ connection, company, accounts, callbacks, showHistory }: ConnectionCardProps) {
  const meta = company?.name ?? connection.companyId;
  const balanceAccounts = accounts.filter((a) => a.balance != null && !a.excluded);
  const total = balanceAccounts.reduce((sum, a) => sum + (a.balance ?? 0), 0);
  const totalCurrency = balanceAccounts[0]?.currency ?? 'ILS';
  // Only a single-currency connection has a meaningful summed total — never add
  // dollars and shekels into one figure under one symbol.
  const sameCurrency = new Set(balanceAccounts.map((a) => a.currency)).size === 1;
  const hasBalances = balanceAccounts.length > 0;
  const syncState = callbacks.syncStates[connection.id] ?? { kind: 'idle' as const };
  const syncing = syncState.kind === 'starting' || syncState.kind === 'running'
    || syncState.kind === 'needs-otp';
  return (
    <article className="conn-card">
      <header className="conn-head">
        <div className="conn-title-row">
          <div className="conn-title-main">
            {company && <CompanyLogo company={company} />}
            <div className="conn-title">{connection.displayName}</div>
          </div>
          <div className="conn-buttons">
            {!connection.hasCredentials && (
              <button
                type="button"
                className="mini primary"
                onClick={() => callbacks.onSetCredentials(connection)}
              >
                Set credentials
              </button>
            )}
            {company?.id === 'snaptrade' && (
              <LinkBrokerageButton
                count={accounts.length}
                onLink={() => callbacks.onLinkSnapTradeBrokerage(connection.id)}
              />
            )}
            {connection.hasCredentials && (
              <button
                type="button"
                className="mini"
                disabled={syncing}
                onClick={() => callbacks.onSync(connection)}
              >
                {syncing ? 'Syncing…' : 'Sync'}
              </button>
            )}
            {connection.hasCredentials && showHistory && (
              <span className="conn-history-label">
                <span className="conn-history-text">History</span>
                <HistoryMonthsSelect
                  value={connection.historyMonths}
                  onChange={(m) => callbacks.onSetHistoryMonths(connection, m)}
                />
              </span>
            )}
            <button
              type="button"
              className="mini danger"
              onClick={() => callbacks.onRemoveConnection(connection)}
            >
              Remove
            </button>
          </div>
        </div>
        <div className="conn-meta">{meta}</div>
        {syncState.kind === 'running' && syncState.message && (
          <div className="conn-sync-msg">{syncState.message}</div>
        )}
        {syncState.kind === 'error' && (
          <div className="conn-sync-err">{syncState.message}</div>
        )}
        {syncState.kind === 'success' && (
          <div className="conn-sync-done" role="status">
            ✓ Done — {syncState.transactionsCount} transaction
            {syncState.transactionsCount === 1 ? '' : 's'}
          </div>
        )}
      </header>
      <ul className="conn-accounts">
        {accounts.map((a) => {
          const negative = a.balance != null && a.balance < 0;
          const holdings = callbacks.holdings.filter((h) => h.accountId === a.id);
          const expanded = !!callbacks.expandedHoldings[a.id];
          return (
            <li key={a.id} className={`conn-account${a.excluded ? ' nw-off' : ''}`}>
              <span className="conn-account-label">
                {holdings.length > 0 && (
                  <button
                    type="button"
                    className="holds-toggle"
                    aria-label={expanded ? 'Collapse holdings' : 'Expand holdings'}
                    aria-expanded={expanded}
                    onClick={() => callbacks.onToggleHoldings(a.id)}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                )}
                {a.label || a.accountNumber}
              </span>
              <NetWorthPill
                excluded={a.excluded}
                onChange={(next) => callbacks.onToggleAccountExcluded(a, next)}
              />
              <button
                type="button"
                className={`amount bal-edit${negative ? ' neg' : ''}`}
                title="Set balance"
                onClick={() => callbacks.onEditBalance(a)}
              >
                {money(a.balance, a.currency)}
              </button>
              {expanded && holdings.length > 0 && (
                <HoldingsList holdings={holdings} />
              )}
            </li>
          );
        })}
      </ul>
      {hasBalances && sameCurrency && (
        <footer className="conn-total">
          <span>Total</span>
          <span className="amount">{money(total, totalCurrency)}</span>
        </footer>
      )}
    </article>
  );
}

interface BalanceModalProps {
  account: Account;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

// Single-balance edit. Kept as a string field (parsed to a number in onSubmit)
// so the input shows the rounded value and the "Enter a number." message lands
// on the same bad input the old guard caught.
const balanceFormSchema = z.object({
  balance: z
    .string()
    .refine((s) => s.trim() !== '' && Number.isFinite(Number(s)), { message: 'Enter a number.' }),
});
type BalanceForm = z.infer<typeof balanceFormSchema>;

function BalanceModal({ account, onClose, onSaved }: BalanceModalProps) {
  // Round to 2dp to suppress floating-point artefacts like
  // "-2945.5500000000006". Bank/card balances are always 2dp; brokerage
  // balances are also reported at cent precision elsewhere in the UI.
  const initial = account.balance != null
    ? String(Math.round(account.balance * 100) / 100)
    : '';
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<BalanceForm>({
    resolver: zodResolver(balanceFormSchema),
    defaultValues: { balance: initial },
  });
  const submit = handleSubmit(async (values) => {
    try {
      await api(`/accounts/${encodeURIComponent(account.id)}/balance`, 'PATCH', {
        balance: Number(values.balance),
      });
      await onSaved();
    } catch (e) {
      setError('root', { message: e instanceof ApiError ? e.message : String(e) });
    }
  });
  return (
    <ModalPortal>
      <div className="overlay">
        <form role="dialog" aria-label="Account balance" className="modal" onSubmit={submit}>
          <h2>Account balance</h2>
          <p>
            Set the current balance for{' '}
            <strong>{account.label || `Account ${account.accountNumber}`}</strong>.
            Use a minus sign for an overdraft.
          </p>
          <label className="field">
            <span>Balance</span>
            <input
              type="number"
              step="0.01"
              autoFocus
              {...register('balance')}
            />
          </label>
          {errors.balance && <div className="modal-err">{errors.balance.message}</div>}
          {errors.root && <div className="modal-err">{errors.root.message}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={isSubmitting}>Save</button>
          </div>
        </form>
      </div>
    </ModalPortal>
  );
}

const SNAPTRADE_FREE_TIER_LIMIT = 5;

interface LinkBrokerageButtonProps {
  // Count of this connection's accounts — ConnectionCard already scoped them.
  count: number;
  onLink: () => void;
}

function LinkBrokerageButton({ count, onLink }: LinkBrokerageButtonProps) {
  const atLimit = count >= SNAPTRADE_FREE_TIER_LIMIT;
  const label = count === 0 ? 'Link a brokerage' : 'Link another brokerage';
  return (
    <button
      type="button"
      className="mini primary"
      onClick={onLink}
      disabled={atLimit}
      title={atLimit ? "You're at the 5-brokerage SnapTrade free tier limit." : undefined}
    >
      {label}
    </button>
  );
}

function AssetCard({ asset, callbacks }: { asset: ManualAsset; callbacks: RowCallbacks }) {
  const isCar = asset.kind === 'car';
  // ManualAsset.details is typed Record<string, unknown> | null (matches the
  // engine), so carSubline accepts it directly — no cast needed.
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
              window.open(YAD2_PRICE_LIST, '_blank');
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

function LoanCard({ loan, callbacks }: { loan: Loan; callbacks: RowCallbacks }) {
  // The full Spitzer remaining-balance math is server-side via /loans.
  // For the read-only card, the principal is enough to identify + compare.
  return (
    <article className={`loan-card${loan.excluded ? ' nw-off' : ''}`}>
      <div className="loan-head">
        <div className="loan-title">{loan.name}</div>
        <NetWorthPill
          excluded={loan.excluded}
          onChange={(next) => callbacks.onToggleLoanExcluded(loan, next)}
        />
      </div>
      <div className="amount neg">{money(loan.principal, loan.currency)}</div>
      <div className="conn-buttons" style={{ marginTop: 10 }}>
        <button type="button" className="mini" onClick={() => callbacks.onEditLoan(loan)}>Edit</button>
        <button type="button" className="mini danger" onClick={() => callbacks.onRemoveLoan(loan)}>Remove</button>
      </div>
    </article>
  );
}

interface RemoveConnectionDialogProps {
  connection: Connection;
  onClose: () => void;
  onConfirmed: () => void | Promise<void>;
}

function RemoveConnectionDialog({ connection, onClose, onConfirmed }: RemoveConnectionDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setError(null);
    try {
      await api(`/connections/${encodeURIComponent(connection.id)}`, 'DELETE');
      await onConfirmed();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label={`Remove ${connection.displayName}`} className="modal">
          <h2>{connection.displayName}</h2>
          <p>
            Remove this connection and every account, transaction, and saved
            session belonging to it. Manual edits stay; bank-pulled data is
            gone. This cannot be undone.
          </p>
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="danger" onClick={confirm}>
              Confirm remove
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

interface CredentialsModalProps {
  connection: Connection;
  company?: Company;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function CredentialsModal({ connection, company, onClose, onSaved }: CredentialsModalProps) {
  const fields = company?.loginFields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f, ''])),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (fields.some((f) => !values[f])) {
      setError('Fill every field.');
      return;
    }
    try {
      await api(`/connections/${encodeURIComponent(connection.id)}/credentials`, 'PUT', {
        credentials: values,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Set credentials" className="modal">
          <h2>Credentials for {connection.displayName}</h2>
          <p>
            Stored encrypted in the local vault; never sent anywhere except
            the bank's own site when a scrape runs.
          </p>
          {fields.map((f) => (
            <label key={f} className="field">
              <span>{f}</span>
              <input
                type={f.toLowerCase().includes('password') ? 'password' : 'text'}
                value={values[f] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [f]: e.target.value }))}
                autoComplete="off"
              />
            </label>
          ))}
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={submit}>Save</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

interface AssetEditModalProps {
  asset: ManualAsset;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

// name + value edit. Local schema (string `value`, parsed in onSubmit) keeps the
// input text-faithful and reproduces the original per-field messages. The shared
// assetUpdateSchema models the numeric wire shape, which the onSubmit maps to.
const assetEditFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  value: z
    .string()
    // Match AddManualAssetForm: a manual asset value must be positive, so a 0 or
    // negative edit can't slip in and distort net worth.
    .refine((s) => Number.isFinite(Number(s)) && Number(s) > 0, {
      message: 'Enter a positive value.',
    }),
});
type AssetEditForm = z.infer<typeof assetEditFormSchema>;

function AssetEditModal({ asset, onClose, onSaved }: AssetEditModalProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AssetEditForm>({
    resolver: zodResolver(assetEditFormSchema),
    defaultValues: { name: asset.name, value: String(asset.value) },
  });
  const submit = handleSubmit(async (values) => {
    try {
      await api(`/assets/${encodeURIComponent(asset.id)}`, 'PUT', {
        name: values.name.trim(), value: Number(values.value),
      });
      await onSaved();
    } catch (e) {
      setError('root', { message: e instanceof ApiError ? e.message : String(e) });
    }
  });
  return (
    <ModalPortal>
      <div className="overlay">
        <form role="dialog" aria-label={`Edit ${asset.name}`} className="modal" onSubmit={submit}>
          <h2>Edit asset</h2>
          <label className="field">
            <span>Name</span>
            <input type="text" {...register('name')} />
          </label>
          <label className="field">
            <span>Value ({asset.currency})</span>
            <input
              type="number"
              step="0.01"
              {...register('value')}
            />
          </label>
          {errors.name && <div className="modal-err">{errors.name.message}</div>}
          {errors.value && <div className="modal-err">{errors.value.message}</div>}
          {errors.root && <div className="modal-err">{errors.root.message}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={isSubmitting}>Save</button>
          </div>
        </form>
      </div>
    </ModalPortal>
  );
}

interface LoanEditModalProps {
  loan: Loan;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

// Loan edit. Local schema (string inputs parsed in onSubmit) reproduces the
// original per-field guards + messages. The rate track stays fixed — switching
// it would invalidate the CPI snapshot — so it isn't part of the form. Maps to
// loanUpdateSchema's numeric shape in onSubmit.
const loanEditFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  principal: z
    .string()
    .refine((s) => Number.isFinite(Number(s)) && Number(s) > 0, {
      message: 'Principal must be a positive number.',
    }),
  termMonths: z
    .string()
    .refine((s) => Number.isFinite(Number(s)) && Number(s) > 0, {
      message: 'Term must be a positive integer.',
    }),
  rateValue: z
    .string()
    .refine((s) => Number.isFinite(Number(s)), { message: 'Rate must be a number.' }),
  notes: z.string(),
});
type LoanEditForm = z.infer<typeof loanEditFormSchema>;

function LoanEditModal({ loan, onClose, onSaved }: LoanEditModalProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoanEditForm>({
    resolver: zodResolver(loanEditFormSchema),
    defaultValues: {
      name: loan.name,
      principal: String(loan.principal),
      termMonths: String(loan.termMonths),
      rateValue: String(loan.rateValue),
      notes: loan.notes ?? '',
    },
  });
  const submit = handleSubmit(async (values) => {
    try {
      await api(`/loans/${encodeURIComponent(loan.id)}`, 'PUT', {
        name: values.name.trim(),
        principal: Number(values.principal),
        termMonths: Math.round(Number(values.termMonths)),
        rateValue: Number(values.rateValue),
        notes: values.notes.trim() || null,
      });
      await onSaved();
    } catch (e) {
      setError('root', { message: e instanceof ApiError ? e.message : String(e) });
    }
  });
  // Single .modal-err line showing the first failing field, matching the
  // original's one-message-at-a-time guard ordering.
  const firstError = errors.name?.message
    ?? errors.principal?.message
    ?? errors.termMonths?.message
    ?? errors.rateValue?.message
    ?? errors.root?.message;
  return (
    <ModalPortal>
      <div className="overlay">
        <form role="dialog" aria-label={`Edit ${loan.name}`} className="modal" onSubmit={submit}>
          <h2>Edit loan</h2>
          <label className="field">
            <span>Name</span>
            <input type="text" {...register('name')} />
          </label>
          <label className="field">
            <span>Principal ({loan.currency})</span>
            <input
              type="number"
              step="0.01"
              {...register('principal')}
            />
          </label>
          <label className="field">
            <span>Term (months)</span>
            <input
              type="number"
              step="1"
              {...register('termMonths')}
            />
          </label>
          <label className="field">
            <span>Rate (% annual)</span>
            <input
              type="number"
              step="0.01"
              {...register('rateValue')}
            />
          </label>
          <label className="field">
            <span>Notes</span>
            <input
              type="text"
              placeholder="Optional"
              {...register('notes')}
            />
          </label>
          {firstError && <div className="modal-err">{firstError}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={isSubmitting}>Save</button>
          </div>
        </form>
      </div>
    </ModalPortal>
  );
}

interface ConfirmRemoveDialogProps {
  title: string;
  body: string;
  onClose: () => void;
  onConfirmed: () => void | Promise<void>;
}

function ConfirmRemoveDialog({ title, body, onClose, onConfirmed }: ConfirmRemoveDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setError(null);
    try {
      await onConfirmed();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label={`Remove ${title}`} className="modal">
          <h2>{title}</h2>
          <p>{body}</p>
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="danger" onClick={confirm}>Confirm remove</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

/** Company favicon overlaid on a typed emoji fallback. The engine serves
 *  the favicon via /logo/:companyId; on error we hide the img and the
 *  emoji shows through. Matches the legacy app's companyLogo() trick. */
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
  /** Picked the Car tile → caller opens CarAssetForm. */
  onPickCar: () => void;
  /** Fired when the user picks a brokerage in the inline brokerage list.
   *  The parent closes the picker and opens SnapTradeLinkFlow with the
   *  broker pre-selected. */
  onPickBrokerage: (connectionId: string, brokerSlug: string, brokerName: string) => void;
  onClose: () => void;
}

type PickerCategory = 'bank' | 'card' | 'brokerage' | 'car' | 'pension' | 'loan' | 'asset';

interface CategoryTile {
  key: PickerCategory;
  label: string;
  emoji: string;
  /** When set, fires immediately on click (leaf tile — no drilldown). */
  leaf?: 'manual-asset' | 'manual-loan';
  /** Static sub-label when the count would be misleading (e.g. SnapTrade). */
  subOverride?: string;
}

const PICKER_TILES: CategoryTile[] = [
  { key: 'bank', label: 'Banks', emoji: '🏦' },
  { key: 'card', label: 'Credit cards', emoji: '💳' },
  { key: 'brokerage', label: 'Brokerages', emoji: '📈', subOverride: 'via SnapTrade' },
  { key: 'car', label: 'Car', emoji: '🚗', subOverride: 'looked up by plate' },
  // Pension is intentionally shown but disabled — its flow still lives in
  // the legacy SPA; the tile keeps the React picker visually aligned with
  // the legacy design until that flow is ported.
  { key: 'pension', label: 'Pension & savings', emoji: '🪺',
    subOverride: 'pension, gemel & study fund' },
  { key: 'loan', label: 'Loan', emoji: '📉', leaf: 'manual-loan',
    subOverride: 'mortgage, car loan, prime / CPI-linked' },
  { key: 'asset', label: 'Other asset', emoji: '💎', leaf: 'manual-asset',
    subOverride: 'cash, property…' },
];

type PickerStep =
  | { kind: 'category' }
  | { kind: 'institution'; category: 'bank' | 'card' }
  | { kind: 'pension' }
  | { kind: 'snaptrade-credentials' }
  | { kind: 'snaptrade-brokerages'; connectionId: string };

function AddConnectionPicker(
  { companies, connections, onPickCompany, onPickManualAsset, onPickManualLoan,
    onPickManualPension, onPickCar, onPickBrokerage, onClose }:
    AddConnectionPickerProps,
) {
  const [step, setStep] = useState<PickerStep>({ kind: 'category' });
  const existingSnapTradeConn = connections.find((c) => c.companyId === 'snaptrade');
  const snapTradeCompany = companies.find((c) => c.id === 'snaptrade');

  const openBrokerageStep = () => {
    if (existingSnapTradeConn) {
      setStep({ kind: 'snaptrade-brokerages', connectionId: existingSnapTradeConn.id });
    } else {
      setStep({ kind: 'snaptrade-credentials' });
    }
  };

  const renderCategoryStep = () => (
    <>
      <h2>Add an asset</h2>
      <p>What would you like to add to Hon?</p>
      <div className="pick-grid">
        {PICKER_TILES.map((tile) => {
          const count = (tile.key === 'bank' || tile.key === 'card')
            ? companies.filter((c) => c.type === tile.key).length
            : null;
          const sub = tile.subOverride
            ?? (count !== null ? `${count} ${count === 1 ? 'option' : 'options'}` : '');
          const onClick = () => {
            if (tile.leaf === 'manual-asset') { onPickManualAsset(); return; }
            if (tile.leaf === 'manual-loan')  { onPickManualLoan();  return; }
            if (tile.key === 'car') { onPickCar(); return; }
            if (tile.key === 'pension') { setStep({ kind: 'pension' }); return; }
            if (tile.key === 'brokerage') { openBrokerageStep(); return; }
            if (tile.key === 'bank' || tile.key === 'card') {
              setStep({ kind: 'institution', category: tile.key });
            }
          };
          return (
            <button
              key={tile.key}
              type="button"
              className="pick-card"
              onClick={onClick}
              data-tile={tile.key}
              aria-label={tile.label}
            >
              <span className="pc-emoji">{tile.emoji}</span>
              <span className="pc-label">{tile.label}</span>
              <span className="pc-count">{sub}</span>
            </button>
          );
        })}
      </div>
    </>
  );

  const renderInstitutionStep = () => {
    if (step.kind !== 'institution') return null;
    const inGroup = companies.filter((c) => c.type === step.category);
    const tile = PICKER_TILES.find((t) => t.key === step.category);
    return (
      <>
        <h2>{tile?.label ?? step.category}</h2>
        <button
          type="button"
          className="back-btn"
          onClick={() => setStep({ kind: 'category' })}
        >‹ All categories</button>
        {inGroup.length === 0 ? (
          <p className="hint">No institutions in this category.</p>
        ) : (
          <ul className="add-picker">
            {inGroup.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="add-picker-row"
                  onClick={() => onPickCompany(c)}
                >
                  <CompanyLogo company={c} />
                  <span className="add-picker-name">{c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  };

  const renderStep = () => {
    if (step.kind === 'category') return renderCategoryStep();
    if (step.kind === 'institution') return renderInstitutionStep();
    if (step.kind === 'pension') {
      return (
        <PensionPickerStep
          companies={companies}
          onPickCompany={onPickCompany}
          onPickCustom={onPickManualPension}
          onBack={() => setStep({ kind: 'category' })}
        />
      );
    }
    if (step.kind === 'snaptrade-credentials') {
      if (!snapTradeCompany) {
        return (
          <>
            <h2>Brokerages</h2>
            <p className="hint">SnapTrade isn't available — the engine didn't return it in /companies.</p>
          </>
        );
      }
      return (
        <SnapTradeCredentialsStep
          company={snapTradeCompany}
          onBack={() => setStep({ kind: 'category' })}
          onSaved={(connectionId) => setStep({ kind: 'snaptrade-brokerages', connectionId })}
        />
      );
    }
    if (step.kind === 'snaptrade-brokerages') {
      return (
        <SnapTradeBrokeragesStep
          connectionId={step.connectionId}
          onBack={() => setStep({ kind: 'category' })}
          onPickBrokerage={(slug, name) => onPickBrokerage(step.connectionId, slug, name)}
        />
      );
    }
    return null;
  };

  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Add an asset" className="modal">
          {renderStep()}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

interface SnapTradeCredentialsStepProps {
  company: Company;
  onBack: () => void;
  onSaved: (connectionId: string) => void;
}

/** Inline SnapTrade dev-credentials form, rendered as a sub-step of
 *  AddConnectionPicker when the user clicks the Brokerages tile but
 *  no SnapTrade connection exists yet. */
function SnapTradeCredentialsStep(
  { company, onBack, onSaved }: SnapTradeCredentialsStepProps,
) {
  const [displayName, setDisplayName] = useState(company.name);
  const [credentials, setCredentials] = useState<Record<string, string>>(() =>
    Object.fromEntries(company.loginFields.map((f) => [f, ''])),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    if (!displayName.trim()) { setError('Display name is required.'); return; }
    if (company.loginFields.some((f) => !credentials[f])) {
      setError('Fill every credential field.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await api<{ connection: Connection }>(
        '/connections', 'POST', {
          companyId: company.id,
          displayName: displayName.trim(),
          credentials,
        },
      );
      onSaved(created.connection.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <>
      <h2>Connect a brokerage</h2>
      <button type="button" className="back-btn" onClick={onBack}>‹ All categories</button>
      <p>First, enter your SnapTrade developer keys (one time).</p>
      <label className="field">
        <span>Display name</span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      {company.loginFields.map((f) => (
        <label key={f} className="field">
          <span>{f}</span>
          <input
            type={f.toLowerCase().includes('password') ? 'password' : 'text'}
            value={credentials[f] ?? ''}
            autoComplete="off"
            onChange={(e) =>
              setCredentials((prev) => ({ ...prev, [f]: e.target.value }))
            }
          />
        </label>
      ))}
      <p className="hint">
        To get a Client ID and Consumer Key: sign up at dashboard.snaptrade.com,
        open the API Keys page, copy the Client ID, click the regenerate icon
        next to Consumer Key, then copy the revealed key. Paste both above.
      </p>
      {error && <div className="modal-err">{error}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onBack}>Cancel</button>
        <button type="button" className="primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </>
  );
}

interface SnapTradeBrokeragesStepProps {
  connectionId: string;
  onBack: () => void;
  onPickBrokerage: (slug: string, name: string) => void;
}

/** Inline brokerage list, rendered as a sub-step of AddConnectionPicker
 *  when the user clicks the Brokerages tile and a SnapTrade connection
 *  already exists. Fetches /snaptrade/brokerages once on mount. */
function SnapTradeBrokeragesStep(
  { connectionId, onBack, onPickBrokerage }: SnapTradeBrokeragesStepProps,
) {
  const [brokerages, setBrokerages] = useState<BrokerageOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ brokerages: BrokerageOption[] }>(
          '/snaptrade/brokerages', 'POST', { connectionId },
        );
        if (!cancelled) setBrokerages(res.brokerages);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [connectionId]);

  return (
    <>
      <h2>Brokerages</h2>
      <button type="button" className="back-btn" onClick={onBack}>‹ All categories</button>
      <p>Pick a brokerage to connect.</p>
      {error ? (
        <p className="modal-err">{error}</p>
      ) : brokerages === null ? (
        <DelayedLoader text="Loading brokerages…" />
      ) : (
        <SnapTradeBrokeragePicker brokerages={brokerages} onPick={onPickBrokerage} />
      )}
    </>
  );
}

const ASSET_KINDS = [
  ['cash', 'Cash / savings'],
  ['property', 'Property'],
  ['car', 'Car'],
  ['crypto', 'Crypto'],
  ['pension', 'Pension'],
  ['other', 'Other'],
] as const;

/** The legal kind values for a manual asset. Derived from ASSET_KINDS
 *  so a new entry there is automatically allowed as an initialKind. */
export type AssetKind = typeof ASSET_KINDS[number][0];

interface AddManualAssetFormProps {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  /** Preselects the Kind dropdown. Defaults to 'cash'. Used by the pension
   *  picker's "Custom pension account" row to land on the right kind. */
  initialKind?: AssetKind;
}

/**
 * Modal form for adding a manual (non-scraped) asset to the user's
 * net-worth view. Used both from the standalone "Other asset" picker
 * tile and from the pension picker's "Custom pension account" row
 * (which preselects the Kind dropdown via the `initialKind` prop).
 */
export function AddManualAssetForm({ onClose, onSaved, initialKind }: AddManualAssetFormProps) {
  const [kind, setKind] = useState(initialKind ?? 'cash');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('ILS');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) { setError('Enter a positive value.'); return; }
    try {
      await api('/assets', 'POST', {
        kind, name: name.trim(), value: n, currency,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Add a manual asset" className="modal">
          <h2>Add a manual asset</h2>
          <p>
            Anything you own with a value — counts toward your net worth.
          </p>
          <label className="field">
            <span>Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
              {ASSET_KINDS.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Apartment, emergency fund…"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Value</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0"
            />
          </label>
          <label className="field">
            <span>Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option>ILS</option><option>USD</option>
              <option>EUR</option><option>GBP</option>
            </select>
          </label>
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={submit}>Add</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

interface AddConnectionFormProps {
  company: Company;
  onClose: () => void;
  onSaved: (connectionId: string) => void | Promise<void>;
}

function AddConnectionForm({ company, onClose, onSaved }: AddConnectionFormProps) {
  const [displayName, setDisplayName] = useState(company.name);
  const [credentials, setCredentials] = useState<Record<string, string>>(() =>
    Object.fromEntries(company.loginFields.map((f) => [f, ''])),
  );
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!displayName.trim()) { setError('Display name is required.'); return; }
    if (company.loginFields.some((f) => !credentials[f])) {
      setError('Fill every credential field.');
      return;
    }
    try {
      const created = await api<{ connection: Connection }>(
        '/connections', 'POST', {
          companyId: company.id,
          displayName: displayName.trim(),
          credentials,
        },
      );
      await onSaved(created.connection.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label={`Add ${company.name}`} className="modal">
          <h2>Add {company.name}</h2>
          <p>
            Credentials are encrypted in the local vault and never sent
            anywhere except {company.name}'s own site when a scrape runs.
          </p>
          <label className="field">
            <span>Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          {company.loginFields.map((f) => (
            <label key={f} className="field">
              <span>{f}</span>
              <input
                type={f.toLowerCase().includes('password') ? 'password' : 'text'}
                value={credentials[f] ?? ''}
                onChange={(e) =>
                  setCredentials((prev) => ({ ...prev, [f]: e.target.value }))
                }
                autoComplete="off"
              />
            </label>
          ))}
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={submit}>Add</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

type RateType = 'fixed' | 'prime' | 'cpi-fixed' | 'cpi-prime';
const RATE_TRACKS: Array<[RateType, string, string]> = [
  ['fixed',     'Fixed',          'A fixed annual rate, not linked to anything.'],
  ['prime',     'Prime',          'Margin over the Bank of Israel prime rate.'],
  ['cpi-fixed', 'CPI-linked fixed', 'Principal indexed to CPI; fixed-rate spread on top.'],
  ['cpi-prime', 'CPI-linked prime', 'Principal indexed to CPI; prime+margin on top.'],
];

interface AddManualLoanFormProps {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function AddManualLoanForm({ onClose, onSaved }: AddManualLoanFormProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState('');
  const [principal, setPrincipal] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [termMonths, setTermMonths] = useState('');
  const [rateType, setRateType] = useState<RateType>('fixed');
  const [rateValue, setRateValue] = useState('');
  const [currency, setCurrency] = useState('ILS');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    const p = Number(principal);
    if (!Number.isFinite(p) || p <= 0) { setError('Principal must be a positive number.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      setError('Start date must be YYYY-MM-DD.'); return;
    }
    const t = Math.round(Number(termMonths));
    if (!Number.isFinite(t) || t <= 0) { setError('Term must be a positive integer.'); return; }
    const r = Number(rateValue);
    if (!Number.isFinite(r)) { setError('Rate must be a number.'); return; }
    try {
      await api('/loans', 'POST', {
        name: name.trim(),
        principal: p,
        startDate,
        termMonths: t,
        rateType,
        rateValue: r,
        currency,
        notes: notes.trim() || null,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Add a loan" className="modal">
          <h2>Add a loan</h2>
          <p>
            Hon computes the Spitzer schedule, monthly payment, and payoff
            date from the principal, term, and rate.
          </p>
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mortgage, car loan…"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Principal</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              placeholder="0"
            />
          </label>
          <label className="field">
            <span>Start date</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Term (months)</span>
            <input
              type="number"
              step="1"
              min="1"
              value={termMonths}
              onChange={(e) => setTermMonths(e.target.value)}
              placeholder="240"
            />
          </label>
          <fieldset className="field">
            <legend>Track</legend>
            {RATE_TRACKS.map(([id, label, sub]) => (
              <label key={id} className={`ce-group${rateType === id ? ' on' : ''}`}>
                <input
                  type="radio"
                  name="rate-track"
                  value={id}
                  checked={rateType === id}
                  onChange={() => setRateType(id)}
                  aria-label={label}
                />
                <span className="ce-group-name">{label}</span>
                <span className="ce-group-sub">{sub}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>Rate (% annual)</span>
            <input
              type="number"
              step="0.01"
              value={rateValue}
              onChange={(e) => setRateValue(e.target.value)}
              placeholder={rateType === 'prime' || rateType === 'cpi-prime'
                ? 'Margin over prime'
                : 'Annual %'}
            />
          </label>
          <label className="field">
            <span>Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option>ILS</option><option>USD</option>
              <option>EUR</option><option>GBP</option>
            </select>
          </label>
          <label className="field">
            <span>Notes</span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </label>
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={submit}>Add</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function HoldingsList({ holdings }: { holdings: Holding[] }) {
  return (
    <div className="holds-list">
      {holdings.map((h, i) => {
        const s = holdingStats(h);
        const gainCls = s.gain == null ? 'flat' : s.gain >= 0 ? 'good' : 'bad';
        return (
          // Composite key: the same symbol can appear more than once within an
          // account (multiple lots, or distinct currencies), so symbol alone
          // collides. Index disambiguates remaining duplicates.
          <div key={`${h.symbol}-${h.currency}-${i}`} className="hold-row">
            <div className="hold-sym">
              <span className="hold-tk">{h.symbol}</span>
              {h.description && <span className="hold-desc">{h.description}</span>}
            </div>
            <div className="hold-end">
              <span className="hold-val">
                {s.value != null ? money(s.value, h.currency) : '—'}
              </span>
              <span className="hold-units">
                {fmtUnits(h.units)} @ {h.price != null ? money(h.price, h.currency) : '—'}
              </span>
              {s.gainPct != null && (
                <span className={`hold-gain ${gainCls}`}>
                  {s.gain != null && s.gain >= 0 ? '↑' : '↓'}{' '}
                  {Math.abs(s.gainPct).toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface OtpModalProps {
  runId: string;
  message: string;
  onClose: () => void;
  onSubmitted: () => void;
}

function OtpModal({ runId, message, onClose, onSubmitted }: OtpModalProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!code.trim()) {
      setError('Enter the code.');
      return;
    }
    try {
      await api(`/scrape/${encodeURIComponent(runId)}/otp`, 'POST', { code: code.trim() });
      onSubmitted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="One-time code" className="modal">
          <h2>One-time code</h2>
          <p>{message || 'Enter the verification code from your bank.'}</p>
          <label className="field">
            <span>Code</span>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              autoComplete="one-time-code"
            />
          </label>
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={submit}>Submit</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function NetWorthPill(
  { excluded, onChange }: { excluded: boolean; onChange: (next: boolean) => void },
) {
  const counted = !excluded;
  return (
    <label
      className={`nw-pill${counted ? ' on' : ''}`}
      title={counted
        ? 'Counted in net worth. Untick to leave this balance out of the total.'
        : 'Excluded from net worth. Tick to count this balance in the total.'}
    >
      <input
        type="checkbox"
        className="nw-tick"
        checked={counted}
        aria-label="Net worth"
        onChange={(e) => onChange(!e.target.checked)}
      />
      <span>Net worth</span>
    </label>
  );
}
