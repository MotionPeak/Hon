import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccountsView } from './accounts/AccountsView';
import { VaultBanner } from './vault/VaultBanner';
import { ActivityView } from './activity/ActivityView';
import { api, ApiError, hasToken } from './api';
import { InsightsView } from './insights/InsightsView';
import { LoansView } from './loans/LoansView';
import { OverviewView } from './overview/OverviewView';
import { PiggyView } from './piggy/PiggyView';
import { RecurringView } from './recurring/RecurringView';
import { SettingsProvider } from './settings/useSettings';
import { SettingsView } from './settings/SettingsView';
import { VouchersView } from './vouchers/VouchersView';

type Tab =
  | 'overview' | 'accounts' | 'activity' | 'recurring'
  | 'piggy' | 'vouchers' | 'loans' | 'insights' | 'settings';

interface TabDef {
  id: Tab;
  label: string;
  emoji: string;
}

const TABS: TabDef[] = [
  { id: 'overview',  label: 'Overview',    emoji: '📊' },
  { id: 'accounts',  label: 'Assets',      emoji: '🏦' },
  { id: 'activity',  label: 'Activity',    emoji: '🧾' },
  { id: 'recurring',     label: 'Fixed bills',   emoji: '📆' },
{ id: 'piggy',         label: 'Piggy banks',   emoji: '🐷' },
  { id: 'loans',     label: 'Loans',       emoji: '📉' },
  { id: 'vouchers',  label: 'Vouchers',    emoji: '🎟️' },
  { id: 'insights',  label: 'Insights',    emoji: '💡' },
  { id: 'settings',  label: 'Settings',    emoji: '⚙️' },
];

interface Health {
  ok: boolean;
  name: string;
  version: string;
  uptimeMs: number;
  db: string;
  pid: number;
}

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  // Activity row's "→ Loan name" chip dispatches this to ask the shell
  // to flip to the Loans tab. Decouples the chip from prop-drilling a
  // navigation callback through five components.
  useEffect(() => {
    const h = (): void => setTab('loans');
    window.addEventListener('hon.go-to-loans', h);
    return () => window.removeEventListener('hon.go-to-loans', h);
  }, []);

  // The empty Loans tab's "+ Add a loan" button dispatches this to flip to the
  // Assets tab; AccountsView then opens the loan form (via its
  // 'hon.pendingAddLoan' localStorage flag, read on mount).
  useEffect(() => {
    const h = (): void => setTab('accounts');
    window.addEventListener('hon.go-to-assets', h);
    return () => window.removeEventListener('hon.go-to-assets', h);
  }, []);

  // Reads localStorage['hon.unseenLoanIds'] (written by AccountsView's
  // new-loan detector). Non-empty → the Loans nav button gets data-unseen
  // so it can render an amber pulse dot. Same-tab updates fire via a
  // custom event since the browser's storage event is cross-tab only.
  const [unseenLoanCount, setUnseenLoanCount] = useState(0);
  useEffect(() => {
    const read = (): void => {
      try {
        const v = JSON.parse(window.localStorage.getItem('hon.unseenLoanIds') ?? '[]');
        setUnseenLoanCount(Array.isArray(v) ? v.length : 0);
      } catch { setUnseenLoanCount(0); }
    };
    read();
    window.addEventListener('hon.loan-ids-changed', read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener('hon.loan-ids-changed', read);
      window.removeEventListener('storage', read);
    };
  }, []);
  // The amber pill that slides behind the active tab. Measured from the
  // selected button after every tab change so it tracks any layout shift.
  const navRef = useRef<HTMLElement | null>(null);
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;
    setPill({ top: active.offsetTop, height: active.offsetHeight });
  }, [tab]);

  useEffect(() => {
    if (!hasToken()) return;
    api<Health>('/health')
      .then(setHealth)
      .catch((err) => setHealthError(
        err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : String(err),
      ));
  }, []);

  if (!hasToken()) return <NoTokenScreen />;

  return (
    <SettingsProvider>
      <main className="app">
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="hm-g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1f1810" />
                    <stop offset="100%" stopColor="#2d2010" />
                  </linearGradient>
                </defs>
                <g fill="url(#hm-g)">
                  <rect x="4" y="7" width="24" height="4.6" rx="2.3" />
                  <rect x="4" y="7" width="4.6" height="21" rx="2.3" />
                  <rect x="23.4" y="14" width="4.6" height="14" rx="2.3" />
                </g>
                <path
                  d="M5.5 7.8 L26.5 7.8"
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth="0.9"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </span>
            <div className="brand-words">
              <h1>Hon</h1>
              <span className="brand-he" lang="he" dir="rtl">הוֹן</span>
            </div>
          </div>
          {health && (
            <span className="engine-version" title={`PID ${health.pid} · ${health.db}`}>
              engine v{health.version}
            </span>
          )}
          {!health && healthError && (
            <span className="engine-version engine-err" title={healthError}>
              ✗ engine offline
            </span>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="theme-toggle icon-btn"
            title="Light / dark"
            aria-label="Toggle theme"
          >☀</button>
        </header>
        <VaultBanner onUnlockClick={() => setTab('settings')} />
        <div className="shell">
          <nav
            ref={navRef}
            className="app-nav"
            role="tablist"
            aria-orientation="vertical"
          >
            {pill && (
              <span
                className="nav-pill"
                aria-hidden="true"
                style={{
                  transform: `translateY(${pill.top}px)`,
                  height: `${pill.height}px`,
                }}
              />
            )}
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`nav-btn${tab === t.id ? ' active' : ''}`}
                data-unseen={t.id === 'loans' && unseenLoanCount > 0 ? 'true' : undefined}
                onClick={() => setTab(t.id)}
              >
                <span className="rn-ico" aria-hidden="true">{t.emoji}</span>
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <div className="app-content" role="tabpanel">
            {/* The keyed wrapper remounts on tab change, which re-triggers
                the .app-tab-view fade-up CSS animation. */}
            <div key={tab} className="app-tab-view">
              {tab === 'overview' && <OverviewView />}
              {tab === 'accounts' && <AccountsView />}
              {tab === 'activity' && <ActivityView />}
              {tab === 'recurring' && <RecurringView />}
{tab === 'piggy' && <PiggyView />}
              {tab === 'vouchers' && <VouchersView />}
              {tab === 'loans' && <LoansView />}
              {tab === 'insights' && <InsightsView />}
              {tab === 'settings' && <SettingsView />}
            </div>
          </div>
        </div>
      </main>
    </SettingsProvider>
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
