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
import { useUiStore } from './store/uiStore';
import { TABS } from './nav';
import { BrandMark } from './ui/BrandMark';
import { MobileAppBar } from './ui/MobileAppBar';
import { NavDrawer } from './ui/NavDrawer';

interface Health {
  ok: boolean;
  name: string;
  version: string;
  uptimeMs: number;
  db: string;
  pid: number;
}

export function App() {
  // Tab + cross-component navigation now live in the Zustand UI store, which
  // replaced the custom window-event bus (hon.go-to-loans / hon.go-to-assets)
  // and the localStorage-polling unseen-loans listener. Components call
  // useUiStore / uiActions directly instead of dispatching DOM events.
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const unseenLoanCount = useUiStore((s) => s.unseenLoanCount);
  const refreshUnseenLoans = useUiStore((s) => s.refreshUnseenLoans);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The browser's `storage` event is cross-tab only, so a same-tab write by
  // AccountsView's new-loan detector still needs a nudge — but that now calls
  // uiActions.refreshUnseenLoans() directly. Here we only handle the cross-tab
  // case (another Hon tab syncing) by re-reading on the storage event.
  useEffect(() => {
    refreshUnseenLoans();
    window.addEventListener('storage', refreshUnseenLoans);
    return () => window.removeEventListener('storage', refreshUnseenLoans);
  }, [refreshUnseenLoans]);
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
        <MobileAppBar onMenu={() => setDrawerOpen(true)} />
        <header className="app-header">
          <div className="brand">
            <BrandMark />
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
        <div className="app-scroll">
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
        </div>
        <NavDrawer
          tabs={TABS}
          activeTab={tab}
          open={drawerOpen}
          onSelect={setTab}
          onClose={() => setDrawerOpen(false)}
        />
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
