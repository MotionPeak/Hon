import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';
import { money } from '../format';
import type {
  Account, AssetSectionKey, Company, Connection, Holding, Loan, ManualAsset,
} from './types';

// Polling interval while a scrape is in-flight. Short enough that tests
// resolve quickly via waitFor; long enough that production polling isn't
// a CPU/network drag.
const SCRAPE_POLL_INTERVAL_MS = 200;

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
  { key: 'loan',      label: 'Loans',             emoji: '📉' },
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
  // Add-connection flow: null = closed; 'picker' = list of companies;
  // a Company = chosen, showing the credential form for that company.
  const [addFlow, setAddFlow] = useState<null | 'picker' | Company>(null);

  const toggleHoldings = useCallback((accountId: string) => {
    setExpandedHoldings((prev) => ({ ...prev, [accountId]: !prev[accountId] }));
  }, []);
  // Active polling timers per connection — kept in a ref so re-renders don't
  // forget pending intervals when a sync transitions states.
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const refresh = useCallback(async () => {
    try {
      const [c, conn, acc, ast, l, brk] = await Promise.all([
        api<{ companies: Company[] }>('/companies'),
        api<{ connections: Connection[] }>('/connections'),
        api<{ accounts: Account[] }>('/accounts'),
        api<{ assets: ManualAsset[] }>('/assets'),
        api<{ loans: Loan[] }>('/loans'),
        api<{ holdings: Holding[] }>('/brokerage'),
      ]);
      setData({
        companies: c.companies, connections: conn.connections, accounts: acc.accounts,
        assets: ast.assets, loans: l.loans, holdings: brk.holdings,
      });
    } catch {
      setData({
        companies: [], connections: [], accounts: [], assets: [], loans: [], holdings: [],
      });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Clear all polling timers on unmount.
  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      Object.values(timers).forEach((t) => clearTimeout(t));
    };
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
        pollTimers.current[connectionId] = setTimeout(
          () => void pollRun(connectionId, runId),
          SCRAPE_POLL_INTERVAL_MS,
        );
      } else if (run.status === 'needs-otp') {
        setSyncForConnection(connectionId, { kind: 'needs-otp', runId, message: run.message });
        // Keep polling — the OTP modal posts the code, then the run goes
        // back to running and eventually success/error.
        pollTimers.current[connectionId] = setTimeout(
          () => void pollRun(connectionId, runId),
          SCRAPE_POLL_INTERVAL_MS,
        );
      } else if (run.status === 'success') {
        setSyncForConnection(connectionId, { kind: 'idle' });
        await refresh();
      } else {
        setSyncForConnection(connectionId, { kind: 'error', message: run.message || 'Sync failed' });
      }
    } catch (e) {
      setSyncForConnection(connectionId, {
        kind: 'error',
        message: e instanceof ApiError ? e.message : String(e),
      });
    }
  }, [refresh, setSyncForConnection]);

  const startSync = useCallback(async (connection: Connection) => {
    setSyncForConnection(connection.id, { kind: 'starting' });
    try {
      // Mirror the legacy app's POST body. interactive=true picks the
      // engine's runInteractiveScrape path, which wires the OTP watcher
      // for the banks in HON_OTP_WATCHER_COMPANIES (Beinleumi, Hapoalim,
      // Otsar Hahayal, Massad, Pagi). Headless mode has no watcher and
      // hangs at LOGGING_IN when the bank shows its 2FA page.
      // monthsBack=24 matches the legacy default so initial syncs pull
      // a sensible window even when the engine's incremental shortcut
      // can't kick in.
      const { runId } = await api<{ runId: string }>(
        `/connections/${encodeURIComponent(connection.id)}/scrape`,
        'POST',
        { interactive: true, monthsBack: 24 },
      );
      setSyncForConnection(connection.id, { kind: 'running', runId, message: 'Starting…' });
      void pollRun(connection.id, runId);
    } catch (e) {
      setSyncForConnection(connection.id, {
        kind: 'error',
        message: e instanceof ApiError ? e.message : String(e),
      });
    }
  }, [pollRun, setSyncForConnection]);

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

  if (!data) return <p>Loading…</p>;

  const sectionCount = (key: AssetSectionKey): number => {
    if (key === 'asset') return data.assets.length;
    if (key === 'loan') return data.loans.length;
    return data.connections.filter(
      (c) => sectionKeyForConnection(c, data.companies) === key,
    ).length;
  };

  const totalItems =
    data.connections.length + data.assets.length + data.loans.length;
  if (totalItems === 0) {
    return (
      <div className="accounts-view">
        <h1>Assets</h1>
        <p className="hint">Nothing here yet — hit + Add asset.</p>
      </div>
    );
  }

  return (
    <div className="accounts-view">
      <div className="accounts-head">
        <h1>Assets</h1>
        <button type="button" className="mini" onClick={() => setAddFlow('picker')}>
          + Add asset
        </button>
      </div>
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
                  onSync: startSync,
                  onToggleHoldings: toggleHoldings,
                  onEditAsset: setEditingAsset,
                  onRemoveAsset: setRemovingAsset,
                  onEditLoan: setEditingLoan,
                  onRemoveLoan: setRemovingLoan,
                  syncStates,
                  holdings: data.holdings,
                  expandedHoldings,
                })}
              </div>
            </section>
          );
        })}
      </div>
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
          onPick={(c) => setAddFlow(c)}
          onClose={() => setAddFlow(null)}
        />
      )}
      {addFlow !== null && addFlow !== 'picker' && (
        <AddConnectionForm
          company={addFlow}
          onClose={() => setAddFlow(null)}
          onSaved={async () => { setAddFlow(null); await refresh(); }}
        />
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
  onToggleHoldings: (accountId: string) => void;
  onEditAsset: (asset: ManualAsset) => void;
  onRemoveAsset: (asset: ManualAsset) => void;
  onEditLoan: (loan: Loan) => void;
  onRemoveLoan: (loan: Loan) => void;
  syncStates: Record<string, SyncState>;
  holdings: Holding[];
  expandedHoldings: Record<string, boolean>;
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
      />
    ));
}

interface ConnectionCardProps {
  connection: Connection;
  company?: Company;
  accounts: Account[];
  callbacks: RowCallbacks;
}

function ConnectionCard({ connection, company, accounts, callbacks }: ConnectionCardProps) {
  const meta = company?.name ?? connection.companyId;
  const total = accounts.reduce(
    (sum, a) => a.excluded || a.balance == null ? sum : sum + a.balance,
    0,
  );
  const totalCurrency = accounts.find((a) => !a.excluded && a.balance != null)?.currency ?? 'ILS';
  const hasBalances = accounts.some((a) => a.balance != null && !a.excluded);
  const syncState = callbacks.syncStates[connection.id] ?? { kind: 'idle' as const };
  const syncing = syncState.kind === 'starting' || syncState.kind === 'running'
    || syncState.kind === 'needs-otp';
  return (
    <article className="conn-card">
      <header className="conn-head">
        <div className="conn-title-row">
          <div className="conn-title">{connection.displayName}</div>
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
      {hasBalances && (
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

function BalanceModal({ account, onClose, onSaved }: BalanceModalProps) {
  // Round to 2dp to suppress floating-point artefacts like
  // "-2945.5500000000006". Bank/card balances are always 2dp; brokerage
  // balances are also reported at cent precision elsewhere in the UI.
  const initial = account.balance != null
    ? String(Math.round(account.balance * 100) / 100)
    : '';
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const n = Number(value);
    if (!Number.isFinite(n) || value.trim() === '') {
      setError('Enter a number.');
      return;
    }
    try {
      await api(`/accounts/${encodeURIComponent(account.id)}/balance`, 'PATCH', {
        balance: n,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Account balance" className="modal">
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
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </label>
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

function AssetCard({ asset, callbacks }: { asset: ManualAsset; callbacks: RowCallbacks }) {
  return (
    <article className={`asset-card${asset.excluded ? ' nw-off' : ''}`}>
      <div className="asset-head">
        <div className="asset-title">{asset.name}</div>
        <NetWorthPill
          excluded={asset.excluded}
          onChange={(next) => callbacks.onToggleAssetExcluded(asset, next)}
        />
      </div>
      <div className="asset-meta">{asset.kind}</div>
      <div className="amount">{money(asset.value, asset.currency)}</div>
      <div className="conn-buttons" style={{ marginTop: 10 }}>
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

function AssetEditModal({ asset, onClose, onSaved }: AssetEditModalProps) {
  const [name, setName] = useState(asset.name);
  const [value, setValue] = useState(String(asset.value));
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    const n = Number(value);
    if (!Number.isFinite(n)) { setError('Value must be a number.'); return; }
    try {
      await api(`/assets/${encodeURIComponent(asset.id)}`, 'PUT', {
        name: name.trim(), value: n,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label={`Edit ${asset.name}`} className="modal">
          <h2>Edit asset</h2>
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Value ({asset.currency})</span>
            <input
              type="number"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
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

interface LoanEditModalProps {
  loan: Loan;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function LoanEditModal({ loan, onClose, onSaved }: LoanEditModalProps) {
  const [name, setName] = useState(loan.name);
  const [principal, setPrincipal] = useState(String(loan.principal));
  const [termMonths, setTermMonths] = useState(String(loan.termMonths));
  const [rateValue, setRateValue] = useState(String(loan.rateValue));
  const [notes, setNotes] = useState(loan.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    const p = Number(principal);
    const t = Number(termMonths);
    const r = Number(rateValue);
    if (!Number.isFinite(p) || p <= 0) { setError('Principal must be a positive number.'); return; }
    if (!Number.isFinite(t) || t <= 0) { setError('Term must be a positive integer.'); return; }
    if (!Number.isFinite(r)) { setError('Rate must be a number.'); return; }
    try {
      // Track type stays fixed — switching prime/CPI invalidates the CPI snapshot.
      // To switch tracks the user can remove and re-add the loan.
      await api(`/loans/${encodeURIComponent(loan.id)}`, 'PUT', {
        name: name.trim(),
        principal: p,
        termMonths: Math.round(t),
        rateValue: r,
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
        <div role="dialog" aria-label={`Edit ${loan.name}`} className="modal">
          <h2>Edit loan</h2>
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Principal ({loan.currency})</span>
            <input
              type="number"
              step="0.01"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Term (months)</span>
            <input
              type="number"
              step="1"
              value={termMonths}
              onChange={(e) => setTermMonths(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Rate (% annual)</span>
            <input
              type="number"
              step="0.01"
              value={rateValue}
              onChange={(e) => setRateValue(e.target.value)}
            />
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
            <button type="button" className="primary" onClick={submit}>Save</button>
          </div>
        </div>
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

interface AddConnectionPickerProps {
  companies: Company[];
  onPick: (company: Company) => void;
  onClose: () => void;
}

function AddConnectionPicker({ companies, onPick, onClose }: AddConnectionPickerProps) {
  const [query, setQuery] = useState('');
  // Only bank + card flows are handled here; brokerage (SnapTrade) and
  // pension have their own multi-step flows that land in later sessions.
  const supported = companies.filter((c) => c.type === 'bank' || c.type === 'card');
  const filtered = supported.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Add an asset" className="modal">
          <h2>Add an asset</h2>
          <p>Pick a bank or credit-card provider.</p>
          <label className="field">
            <span>Search</span>
            <input
              type="text"
              placeholder="Search providers…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </label>
          <ul className="add-picker">
            {filtered.map((c) => (
              <li key={c.id}>
                <button type="button" className="add-picker-row" onClick={() => onPick(c)}>
                  <span className="add-picker-emoji">
                    {c.type === 'card' ? '💳' : '🏦'}
                  </span>
                  <span className="add-picker-name">{c.name}</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="add-picker-empty">No providers match.</li>
            )}
          </ul>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

interface AddConnectionFormProps {
  company: Company;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
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
      await api('/connections', 'POST', {
        companyId: company.id,
        displayName: displayName.trim(),
        credentials,
      });
      await onSaved();
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

function HoldingsList({ holdings }: { holdings: Holding[] }) {
  return (
    <div className="holds-list">
      {holdings.map((h) => {
        const s = holdingStats(h);
        const gainCls = s.gain == null ? 'flat' : s.gain >= 0 ? 'good' : 'bad';
        return (
          <div key={h.symbol} className="hold-row">
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
