import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { api, ApiError } from '../api';
import { money } from '../format';
import type { Voucher } from './types';

type AddMode =
  | { kind: 'closed' }
  | { kind: 'picker' }
  | { kind: 'custom' }
  | { kind: 'shufersal' }
  | { kind: 'buyme' }
  | { kind: 'htzone' };

interface VoucherProvider {
  id: 'shufersal' | 'buyme' | 'htzone' | 'pluxee' | 'cibus';
  label: string;
  sub: string;
  emoji: string;
  available: boolean;
  note?: string;
}

const VOUCHER_SOURCES: VoucherProvider[] = [
  { id: 'shufersal', emoji: '🛒',
    label: 'Shufersal — תו הזהב / GiftCard',
    sub: 'Tav Hazahav and GiftCard balances',
    available: true },
  { id: 'buyme', emoji: '🎁',
    label: 'BuyMe',
    sub: 'Digital gift cards from BuyMe',
    available: true },
  { id: 'htzone', emoji: '💎',
    label: 'Hi-Tech Zone — היי טק זון',
    sub: 'Balance lookup by your 8–9 digit digital code',
    available: true },
  { id: 'pluxee', emoji: '🍱',
    label: 'Pluxee / Sodexo',
    sub: 'Food vouchers loaded by your employer',
    available: false,
    note: 'Coming soon — check the Pluxee app for the live balance.' },
  { id: 'cibus', emoji: '🍽️',
    label: 'Cibus / 10bis',
    sub: 'Restaurant credit',
    available: false,
    note: 'Coming soon — Cibus loads the daily allowance, no card to track.' },
];

function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

/** "BUYME ALL - מגוון אדיר במתנה אחת" → headline + subtitle. */
function splitTitle(name: string): { title: string; description: string } {
  const idx = name.indexOf(' - ');
  if (idx > 0 && idx < name.length - 3) {
    return { title: name.slice(0, idx).trim(), description: name.slice(idx + 3).trim() };
  }
  return { title: name, description: '' };
}

function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const target = new Date(date + 'T00:00:00');
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function PROVIDER_EMOJI(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('shufersal')) return '🛒';
  if (p.includes('buyme')) return '🎁';
  if (p.includes('cibus') || p.includes('pluxee')) return '🍽️';
  if (p.includes('hi-tech') || p.includes('htzone')) return '🎮';
  return '🎟️';
}

export function VouchersView() {
  const [vouchers, setVouchers] = useState<Voucher[] | null>(null);
  const [addMode, setAddMode] = useState<AddMode>({ kind: 'closed' });
  const [editing, setEditing] = useState<Voucher | null>(null);
  const [deleting, setDeleting] = useState<Voucher | null>(null);
  const openAdd = (): void => setAddMode({ kind: 'picker' });
  const closeAdd = (): void => setAddMode({ kind: 'closed' });

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ vouchers: Voucher[] }>('/vouchers');
      setVouchers(d.vouchers);
    } catch {
      setVouchers([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggleExcluded = useCallback(async (v: Voucher) => {
    try {
      await api(`/vouchers/${encodeURIComponent(v.id)}`, 'PATCH', { excluded: !v.excluded });
      await refresh();
    } catch {
      await refresh();
    }
  }, [refresh]);

  if (vouchers === null) return <p>Loading…</p>;

  if (vouchers.length === 0) {
    return (
      <div className="vouchers-view">
        <div className="vouchers-head">
          <h1>Vouchers &amp; gift cards</h1>
          <button type="button" className="mini primary" onClick={openAdd}>
            + Add voucher
          </button>
        </div>
        <p className="blank">
          🎟️ No vouchers yet. Sync directly from a provider — Shufersal Tav HaZahav,
          BuyMe and more — or add one by hand.
        </p>
        <AddVoucherFlow
          mode={addMode}
          setMode={setAddMode}
          onClose={closeAdd}
          onSaved={async () => { closeAdd(); await refresh(); }}
        />
      </div>
    );
  }

  // Per-currency totals, excluding excluded vouchers.
  const totals: Record<string, number> = {};
  for (const v of vouchers) {
    if (v.excluded) continue;
    totals[v.currency] = (totals[v.currency] ?? 0) + (Number(v.balance) || 0);
  }
  const totalKeys = Object.keys(totals).sort();

  return (
    <div className="vouchers-view">
      <div className="vouchers-head">
        <h1>Vouchers &amp; gift cards</h1>
        <button type="button" className="mini primary" onClick={openAdd}>
          + Add voucher
        </button>
      </div>
      <p className="set-intro">
        Track current balances of gift cards and promo credits — they count
        toward your net worth and Hon reminds you when one is about to expire.
      </p>
      {totalKeys.length > 0 && (
        <div data-testid="voucher-totals" className="voucher-totals">
          <span className="emoji">🎟️</span>
          <span>Total balance:</span>
          {totalKeys.map((cur, i) => (
            <span key={cur} className="voucher-total-pill">
              {i > 0 && <span className="sep"> · </span>}
              <b>{money(totals[cur], cur)}</b>
            </span>
          ))}
        </div>
      )}
      <div className="voucher-grid">
        {vouchers.map((v) => (
          <VoucherCard
            key={v.id}
            voucher={v}
            onEdit={() => setEditing(v)}
            onToggleExcluded={() => toggleExcluded(v)}
            onDelete={() => setDeleting(v)}
          />
        ))}
      </div>
      <AddVoucherFlow
        mode={addMode}
        setMode={setAddMode}
        onClose={closeAdd}
        onSaved={async () => { closeAdd(); await refresh(); }}
      />
      {editing && (
        <VoucherFormModal
          voucher={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh(); }}
        />
      )}
      {deleting && (
        <ModalPortal>
          <div className="overlay">
            <div role="dialog" aria-label={`Delete ${deleting.name}`} className="modal">
              <h2>{deleting.name}</h2>
              <p>
                Delete this voucher. The balance disappears from your net worth.
                This can't be undone.
              </p>
              <div className="modal-actions">
                <button type="button" onClick={() => setDeleting(null)}>Cancel</button>
                <button
                  type="button"
                  className="danger"
                  onClick={async () => {
                    await api(`/vouchers/${encodeURIComponent(deleting.id)}`, 'DELETE');
                    setDeleting(null);
                    await refresh();
                  }}
                >
                  Confirm delete
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}

interface VoucherCardProps {
  voucher: Voucher;
  onEdit: () => void;
  onToggleExcluded: () => void;
  onDelete: () => void;
}

function VoucherCard({ voucher, onEdit, onToggleExcluded, onDelete }: VoucherCardProps) {
  const split = splitTitle(voucher.name);
  const days = daysUntil(voucher.expiresOn);
  let expiry: React.ReactNode = null;
  if (days != null && voucher.expiresOn) {
    if (days < 0) {
      expiry = (
        <div className="voucher-badge expired">
          ⌛ Expired {Math.abs(days)} day{Math.abs(days) === 1 ? '' : 's'} ago
        </div>
      );
    } else if (days <= 30) {
      expiry = (
        <div className="voucher-badge soon">
          ⌛ Expires in {days} day{days === 1 ? '' : 's'} ({voucher.expiresOn})
        </div>
      );
    } else {
      expiry = (
        <div className="voucher-badge later">
          📅 Expires {voucher.expiresOn}
        </div>
      );
    }
  }
  return (
    <article className={`voucher-card${voucher.excluded ? ' vc-excluded' : ''}`}>
      <header className="voucher-head">
        <span className="voucher-emoji">{PROVIDER_EMOJI(voucher.provider)}</span>
        <div className="voucher-title-wrap">
          <div className="voucher-title">
            {split.title}
            {voucher.excluded && <span className="voucher-tag"> excluded</span>}
          </div>
          <div className="voucher-sub">
            {voucher.provider}
            {split.description && (
              <>
                <span className="sep"> · </span>
                <span className="voucher-desc">{split.description}</span>
              </>
            )}
          </div>
        </div>
      </header>
      <div className="voucher-balance">{money(voucher.balance, voucher.currency)}</div>
      <div className="voucher-meta">
        current balance{voucher.excluded ? ' · not counted' : ''}
      </div>
      {voucher.notes && <div className="voucher-notes">{voucher.notes}</div>}
      {expiry}
      <div className="voucher-actions">
        <button type="button" className="mini" onClick={onEdit}>Edit</button>
        <button type="button" className="mini" onClick={onToggleExcluded}>
          {voucher.excluded ? 'Include' : 'Exclude'}
        </button>
        <span className="spacer" />
        <button type="button" className="mini danger" onClick={onDelete}>Delete</button>
      </div>
    </article>
  );
}

interface AddVoucherFlowProps {
  mode: AddMode;
  setMode: (m: AddMode) => void;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function AddVoucherFlow({
  mode, setMode, onClose, onSaved,
}: AddVoucherFlowProps) {
  return (
    <>
      <SourcePicker
        open={mode.kind === 'picker'}
        onClose={onClose}
        onPick={(id) => setMode({ kind: id })}
      />
      {mode.kind === 'custom' && (
        <VoucherFormModal onClose={onClose} onSaved={onSaved} />
      )}
      {mode.kind === 'shufersal' && (
        <ShufersalSyncDialog onClose={onClose} onSaved={onSaved} />
      )}
      {mode.kind === 'buyme' && (
        <BuyMeSyncDialog onClose={onClose} onSaved={onSaved} />
      )}
      {mode.kind === 'htzone' && (
        <HtzoneSyncDialog onClose={onClose} onSaved={onSaved} />
      )}
    </>
  );
}

function SourcePicker({
  open, onClose, onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: 'custom' | 'shufersal' | 'buyme' | 'htzone') => void;
}) {
  const [comingSoonId, setComingSoonId] = useState<string | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay" />
        <Dialog.Content className="rx-dialog">
          <Dialog.Title>Add a voucher</Dialog.Title>
          <Dialog.Description className="rx-dialog-desc">
            Pick a provider to sync your active gift cards, or enter one by
            hand. Coming-soon providers are a reminder to check those services
            manually until Hon can read them.
          </Dialog.Description>
          <ul className="vc-pick-list">
            {VOUCHER_SOURCES.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`vc-pick-row${p.available ? '' : ' disabled'}`}
                  aria-label={p.label}
                  disabled={!p.available}
                  onClick={() => {
                    if (!p.available) { setComingSoonId(p.id); return; }
                    onPick(p.id as 'shufersal' | 'buyme' | 'htzone');
                  }}
                >
                  <span className="vc-pick-emoji">{p.emoji}</span>
                  <span className="vc-pick-meta">
                    <span className="vc-pick-name">{p.label}</span>
                    <span className="vc-pick-sub">{p.sub}</span>
                  </span>
                  {!p.available && (
                    <span className="vc-pick-soon">Coming soon</span>
                  )}
                </button>
                {!p.available && comingSoonId === p.id && p.note && (
                  <div className="vc-pick-note">{p.note}</div>
                )}
              </li>
            ))}
            <li>
              <button
                type="button"
                className="vc-pick-row"
                aria-label="Custom voucher"
                onClick={() => onPick('custom')}
              >
                <span className="vc-pick-emoji">✏️</span>
                <span className="vc-pick-meta">
                  <span className="vc-pick-name">Custom voucher</span>
                  <span className="vc-pick-sub">
                    Type in a voucher Hon doesn't sync — a gift card you
                    received, an employer holiday sum, anything.
                  </span>
                </span>
              </button>
            </li>
          </ul>
          <div className="form-actions">
            <Dialog.Close asChild>
              <button type="button" className="btn-ghost">Close</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface SyncStatus {
  status: string;
  message: string | null;
  error: string | null;
  vouchers: { id: string; name: string; balance: number; currency: string }[] | null;
  finished: boolean;
}

interface ProviderConfig {
  id: 'shufersal' | 'buyme' | 'htzone';
  title: string;
  /** Field label and input type for the start step. */
  credentialLabel: string;
  credentialType: 'tel' | 'email' | 'text';
  /** Body key the engine expects on start. */
  credentialKey: 'phone' | 'email' | 'code';
  /** GET path returning { [credentialKey]: string | null }. */
  savedPath: string;
  /** Validation — returns null when ok, error string otherwise. */
  validate: (value: string) => string | null;
  /** True for OTP-based flows (Shufersal, BuyMe). */
  hasOtp: boolean;
}

const PROVIDER_CONFIGS: Record<'shufersal' | 'buyme' | 'htzone', ProviderConfig> = {
  shufersal: {
    id: 'shufersal',
    title: 'Sync Shufersal',
    credentialLabel: 'Phone number',
    credentialType: 'tel',
    credentialKey: 'phone',
    savedPath: '/vouchers/sync/shufersal/saved-phone',
    validate: (v) => /^[0-9\-+\s]{9,15}$/.test(v) ? null : 'Enter a phone number.',
    hasOtp: true,
  },
  buyme: {
    id: 'buyme',
    title: 'Sync BuyMe',
    credentialLabel: 'Email address',
    credentialType: 'email',
    credentialKey: 'email',
    savedPath: '/vouchers/sync/buyme/saved-email',
    validate: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Enter a valid email.',
    hasOtp: true,
  },
  htzone: {
    id: 'htzone',
    title: 'Sync Hi-Tech Zone',
    credentialLabel: 'Digital code (8–9 digits)',
    credentialType: 'text',
    credentialKey: 'code',
    savedPath: '/vouchers/sync/htzone/saved-code',
    validate: (v) => /^\d{8,9}$/.test(v.replace(/\D/g, '')) ? null : 'Code must be 8–9 digits.',
    hasOtp: false,
  },
};

function ShufersalSyncDialog(p: { onClose: () => void; onSaved: () => void | Promise<void> }) {
  return <ProviderSyncDialog cfg={PROVIDER_CONFIGS.shufersal} {...p} />;
}
function BuyMeSyncDialog(p: { onClose: () => void; onSaved: () => void | Promise<void> }) {
  return <ProviderSyncDialog cfg={PROVIDER_CONFIGS.buyme} {...p} />;
}
function HtzoneSyncDialog(p: { onClose: () => void; onSaved: () => void | Promise<void> }) {
  return <ProviderSyncDialog cfg={PROVIDER_CONFIGS.htzone} {...p} />;
}

function ProviderSyncDialog({
  cfg, onClose, onSaved,
}: {
  cfg: ProviderConfig;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [credential, setCredential] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncId, setSyncId] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [otp, setOtp] = useState('');
  const [otpSubmitting, setOtpSubmitting] = useState(false);

  // Best-effort pre-fill of the credential from the vault.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<Record<string, string | null>>(cfg.savedPath);
        if (!cancelled) {
          const saved = r[cfg.credentialKey];
          if (saved) setCredential(saved);
        }
      } catch { /* fine — no saved value */ }
    })();
    return () => { cancelled = true; };
  }, [cfg.savedPath, cfg.credentialKey]);

  // Poll status while a sync is running.
  useEffect(() => {
    if (!syncId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api<SyncStatus>(`/vouchers/sync/${cfg.id}/status/${syncId}`);
        if (cancelled) return;
        setStatus(s);
        if (s.finished) return;
      } catch { /* keep polling */ }
    };
    void tick();
    const handle = setInterval(() => { void tick(); }, 1500);
    return () => { cancelled = true; clearInterval(handle); };
  }, [syncId, cfg.id]);

  const start = async (): Promise<void> => {
    setError(null);
    const vErr = cfg.validate(credential);
    if (vErr) { setError(vErr); return; }
    try {
      const body: Record<string, unknown> = { remember };
      body[cfg.credentialKey] = credential.trim();
      const r = await api<{ syncId: string }>(
        `/vouchers/sync/${cfg.id}/start`, 'POST', body,
      );
      setSyncId(r.syncId);
      setStatus({
        status: cfg.hasOtp ? 'signing-in' : 'awaiting-user-action',
        message: cfg.hasOtp
          ? 'Opening…'
          : 'A browser window opened — tick the reCAPTCHA and click שלח.',
        error: null,
        vouchers: null,
        finished: false,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const submitOtp = async (): Promise<void> => {
    if (!syncId) return;
    setOtpSubmitting(true);
    try {
      await api(`/vouchers/sync/${cfg.id}/otp`, 'POST', { syncId, code: otp.trim() });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setOtpSubmitting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (syncId) {
      try { await api(`/vouchers/sync/${cfg.id}/cancel`, 'POST', { syncId }); }
      catch { /* best effort */ }
    }
    onClose();
  };

  const showOtpStep = cfg.hasOtp && status?.status === 'awaiting-otp';
  const showSuccess = status?.status === 'success';
  const showError = status?.status === 'error';
  const showProgress = !!status && !showOtpStep && !showSuccess && !showError;

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) void cancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay" />
        <Dialog.Content className="rx-dialog" aria-label={cfg.title}>
          <Dialog.Title>{cfg.title}</Dialog.Title>
          <Dialog.Description className="rx-dialog-desc">
            Hon opens a private browser window in the background, signs in
            with your {cfg.credentialLabel.toLowerCase()}, and reads the
            balance — nothing is shared with anyone but you.
          </Dialog.Description>

          {!syncId && (
            <form
              className="piggy-form"
              onSubmit={(e) => { e.preventDefault(); void start(); }}
            >
              <label htmlFor={`vc-${cfg.id}-cred`} className="fld-lbl">
                {cfg.credentialLabel}
              </label>
              <input
                id={`vc-${cfg.id}-cred`}
                type={cfg.credentialType}
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                autoFocus
              />
              <label className="vc-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember this for next time
              </label>
              {error && <p className="form-error">{error}</p>}
              <div className="form-actions">
                <Dialog.Close asChild>
                  <button type="button" className="btn-ghost">Cancel</button>
                </Dialog.Close>
                <button type="submit" className="btn-primary">Sync</button>
              </div>
            </form>
          )}

          {showProgress && (
            <div className="vc-sync-step">
              <div className="vc-sync-spinner" aria-hidden="true" />
              <p className="vc-sync-msg">{status?.message ?? 'Working…'}</p>
              <div className="form-actions">
                <button type="button" className="btn-ghost" onClick={cancel}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {showOtpStep && (
            <form
              className="piggy-form"
              onSubmit={(e) => { e.preventDefault(); void submitOtp(); }}
            >
              <p className="vc-sync-msg">{status?.message}</p>
              <label htmlFor={`vc-${cfg.id}-otp`} className="fld-lbl">
                Verification code
              </label>
              <input
                id={`vc-${cfg.id}-otp`}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                autoFocus
              />
              {error && <p className="form-error">{error}</p>}
              <div className="form-actions">
                <button type="button" className="btn-ghost" onClick={cancel}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={otpSubmitting || otp.trim().length < 3}
                >Verify</button>
              </div>
            </form>
          )}

          {showSuccess && (
            <div className="vc-sync-step">
              <p className="vc-sync-msg vc-sync-ok">
                ✓ {status?.message ?? 'Done.'}
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void onSaved()}
                >Done</button>
              </div>
            </div>
          )}

          {showError && (
            <div className="vc-sync-step">
              <p className="vc-sync-msg vc-sync-err">
                ✗ {status?.error ?? 'Sync failed.'}
              </p>
              <div className="form-actions">
                <button type="button" className="btn-ghost" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface VoucherFormModalProps {
  voucher?: Voucher;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function VoucherFormModal({ voucher, onClose, onSaved }: VoucherFormModalProps) {
  const isEdit = !!voucher;
  const [provider, setProvider] = useState(voucher?.provider ?? '');
  const [name, setName] = useState(voucher?.name ?? '');
  const [balance, setBalance] = useState(
    voucher ? String(Math.round(voucher.balance * 100) / 100) : '',
  );
  const [currency, setCurrency] = useState(voucher?.currency ?? 'ILS');
  const [expiresOn, setExpiresOn] = useState(voucher?.expiresOn ?? '');
  const [notes, setNotes] = useState(voucher?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!provider.trim()) { setError('Provider is required.'); return; }
    if (!name.trim()) { setError('Name is required.'); return; }
    const b = Number(balance);
    if (!Number.isFinite(b)) { setError('Balance must be a number.'); return; }
    const body = {
      provider: provider.trim(),
      name: name.trim(),
      balance: b,
      currency,
      expiresOn: expiresOn.trim() || null,
      notes: notes.trim() || null,
    };
    try {
      if (isEdit && voucher) {
        await api(`/vouchers/${encodeURIComponent(voucher.id)}`, 'PATCH', body);
      } else {
        await api('/vouchers', 'POST', body);
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div
          role="dialog"
          aria-label={isEdit ? 'Edit voucher' : 'Custom voucher'}
          className="modal"
        >
          <h2>{isEdit ? 'Edit voucher' : 'Add a voucher'}</h2>
          <label className="field">
            <span>Provider</span>
            <input
              type="text"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="Shufersal, BuyMe, Cibus…"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tav HaZahav, Birthday gift…"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Balance</span>
            <input
              type="number"
              step="0.01"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
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
            <span>Expires on</span>
            <input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
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
            <button type="button" className="primary" onClick={submit}>
              {isEdit ? 'Save' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
