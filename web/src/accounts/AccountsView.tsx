import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';
import { money } from '../format';
import type {
  Account, AssetSectionKey, Company, Connection, Loan, ManualAsset,
} from './types';

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
}

export function AccountsView() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [editingBalance, setEditingBalance] = useState<Account | null>(null);
  const [removingConnection, setRemovingConnection] = useState<Connection | null>(null);
  const [editingCredentials, setEditingCredentials] = useState<Connection | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, conn, acc, ast, l] = await Promise.all([
        api<{ companies: Company[] }>('/companies'),
        api<{ connections: Connection[] }>('/connections'),
        api<{ accounts: Account[] }>('/accounts'),
        api<{ assets: ManualAsset[] }>('/assets'),
        api<{ loans: Loan[] }>('/loans'),
      ]);
      setData({
        companies: c.companies, connections: conn.connections, accounts: acc.accounts,
        assets: ast.assets, loans: l.loans,
      });
    } catch {
      setData({ companies: [], connections: [], accounts: [], assets: [], loans: [] });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
      <h1>Assets</h1>
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
      </header>
      <ul className="conn-accounts">
        {accounts.map((a) => {
          const negative = a.balance != null && a.balance < 0;
          return (
            <li key={a.id} className={`conn-account${a.excluded ? ' nw-off' : ''}`}>
              <span className="conn-account-label">{a.label || a.accountNumber}</span>
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
