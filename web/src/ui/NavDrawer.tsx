import { useEffect } from 'react';
import type { TabDef } from '../nav';
import type { Tab } from '../store/uiStore';

interface NavDrawerProps {
  tabs: TabDef[];
  activeTab: Tab;
  open: boolean;
  onSelect: (tab: Tab) => void;
  onClose: () => void;
}

/**
 * Off-canvas navigation drawer for the phone shell. Mounted always (so it can
 * animate in and out); slid off-screen and `inert` when closed. Items are plain
 * buttons — the desktop `.app-nav` owns the ARIA tablist, so keeping these as
 * buttons keeps `getByRole('tab', …)` unambiguous in App tests.
 */
export function NavDrawer({ tabs, activeTab, open, onSelect, onClose }: NavDrawerProps) {
  // Body scroll-lock + Escape-to-close, only while open.
  useEffect(() => {
    if (!open) return;
    document.body.classList.add('drawer-open');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('drawer-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <>
      <div
        data-testid="nav-scrim"
        className={`nav-scrim${open ? ' open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <nav
        className={`nav-drawer${open ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        aria-hidden={open ? undefined : true}
        inert={!open}
      >
        <div className="nav-drawer-head">
          <span className="nav-drawer-title">Hon</span>
          <span className="nav-drawer-he" lang="he" dir="rtl">הוֹן</span>
        </div>
        <div className="nav-drawer-list">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`nav-drawer-item${t.id === activeTab ? ' active' : ''}`}
              aria-current={t.id === activeTab ? 'page' : undefined}
              onClick={() => { onSelect(t.id); onClose(); }}
            >
              <span className="nav-drawer-ico" aria-hidden="true">{t.emoji}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
