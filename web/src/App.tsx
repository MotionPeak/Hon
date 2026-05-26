import { useEffect, useState } from 'react';
import { AccountsView } from './accounts/AccountsView';
import { api, ApiError, hasToken } from './api';
import { SettingsView } from './settings/SettingsView';
import { VouchersView } from './vouchers/VouchersView';

type Tab = 'health' | 'accounts' | 'vouchers' | 'settings';

const TABS: Array<[Tab, string]> = [
  ['health', 'Health'],
  ['accounts', 'Accounts'],
  ['vouchers', 'Vouchers'],
  ['settings', 'Settings'],
];

export function App() {
  const [tab, setTab] = useState<Tab>('health');

  if (!hasToken()) return <NoTokenScreen />;

  return (
    <main className="app-shell">
      <div role="tablist" className="tab-nav">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'health' && <HealthView />}
        {tab === 'accounts' && <AccountsView />}
        {tab === 'vouchers' && <VouchersView />}
        {tab === 'settings' && <SettingsView />}
      </div>
    </main>
  );
}

interface Health {
  ok: boolean;
  name: string;
  version: string;
  uptimeMs: number;
  db: string;
  pid: number;
}

type HealthStatus =
  | { kind: 'loading' }
  | { kind: 'connected'; health: Health }
  | { kind: 'error'; message: string };

function HealthView() {
  const [status, setStatus] = useState<HealthStatus>({ kind: 'loading' });
  useEffect(() => {
    api<Health>('/health')
      .then((health) => setStatus({ kind: 'connected', health }))
      .catch((err) => setStatus({
        kind: 'error',
        message: err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : String(err),
      }));
  }, []);
  return (
    <section className="health-view">
      <h2>Engine connectivity</h2>
      {status.kind === 'loading' && <p>Checking /health…</p>}
      {status.kind === 'connected' && (
        <div>
          <p style={{ color: '#7CE5A0' }}>
            ✓ Connected to {status.health.name} {status.health.version}
          </p>
          <pre style={{
            background: '#1a1a1a', padding: '0.75rem',
            borderRadius: 6, fontSize: 13, overflow: 'auto',
          }}>{JSON.stringify(status.health, null, 2)}</pre>
        </div>
      )}
      {status.kind === 'error' && (
        <div>
          <p style={{ color: '#ff7a7a' }}>✗ {status.message}</p>
          <p style={{ opacity: 0.7, fontSize: 14 }}>
            If this is 401: the token in your URL is wrong. Restart the engine and use
            its current URL. If it's a network error: the engine isn't running.
          </p>
        </div>
      )}
    </section>
  );
}

function NoTokenScreen() {
  return (
    <main style={{
      fontFamily: 'system-ui, sans-serif',
      maxWidth: 600,
      margin: '2rem auto',
      padding: '0 1rem',
      color: '#e6e6e6',
    }}>
      <h1>Hon — React UI</h1>
      <p>
        <strong>No access token.</strong> Start the engine
        (<code>cd ../sidecar &amp;&amp; npm run web</code>), copy the
        <code> #token=…</code> from its URL, and append it to this page's URL.
      </p>
      <p style={{ opacity: 0.7, fontSize: 14 }}>
        Example: <code>http://localhost:5173/#token=&lt;uuid&gt;</code>
      </p>
    </main>
  );
}
