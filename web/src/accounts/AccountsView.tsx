import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from '../format';
import type {
  Account, AssetSectionKey, Company, Connection, Loan, ManualAsset,
} from './types';

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

  useEffect(() => {
    Promise.all([
      api<{ companies: Company[] }>('/companies'),
      api<{ connections: Connection[] }>('/connections'),
      api<{ accounts: Account[] }>('/accounts'),
      api<{ assets: ManualAsset[] }>('/assets'),
      api<{ loans: Loan[] }>('/loans'),
    ]).then(([c, conn, acc, ast, l]) => setData({
      companies: c.companies,
      connections: conn.connections,
      accounts: acc.accounts,
      assets: ast.assets,
      loans: l.loans,
    })).catch(() => setData({
      companies: [], connections: [], accounts: [], assets: [], loans: [],
    }));
  }, []);

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
              <div className="assets-stack">{renderSectionItems(s.key, data)}</div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function renderSectionItems(key: AssetSectionKey, data: AccountsData) {
  if (key === 'asset') {
    return data.assets
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => <AssetCard key={a.id} asset={a} />);
  }
  if (key === 'loan') {
    return data.loans
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => <LoanCard key={l.id} loan={l} />);
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
      />
    ));
}

interface ConnectionCardProps {
  connection: Connection;
  company?: Company;
  accounts: Account[];
}

function ConnectionCard({ connection, company, accounts }: ConnectionCardProps) {
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
        <div className="conn-title">{connection.displayName}</div>
        <div className="conn-meta">{meta}</div>
      </header>
      <ul className="conn-accounts">
        {accounts.map((a) => {
          const negative = a.balance != null && a.balance < 0;
          return (
            <li key={a.id} className="conn-account">
              <span className="conn-account-label">{a.label || a.accountNumber}</span>
              <span className={`amount${negative ? ' neg' : ''}`}>
                {money(a.balance, a.currency)}
              </span>
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

function AssetCard({ asset }: { asset: ManualAsset }) {
  return (
    <article className="asset-card">
      <div className="asset-title">{asset.name}</div>
      <div className="asset-meta">{asset.kind}</div>
      <div className="amount">{money(asset.value, asset.currency)}</div>
    </article>
  );
}

function LoanCard({ loan }: { loan: Loan }) {
  // The full Spitzer remaining-balance math is server-side via /loans.
  // For the read-only card, the principal is enough to identify + compare.
  return (
    <article className="loan-card">
      <div className="loan-title">{loan.name}</div>
      <div className="amount neg">{money(loan.principal, loan.currency)}</div>
    </article>
  );
}
