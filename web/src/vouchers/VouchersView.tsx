import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';
import { money } from '../format';
import type { Voucher } from './types';

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
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Voucher | null>(null);
  const [deleting, setDeleting] = useState<Voucher | null>(null);

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
          <button type="button" className="mini primary" onClick={() => setAdding(true)}>
            + Add voucher
          </button>
        </div>
        <p className="blank">
          🎟️ No vouchers yet. Sync directly from a provider — Shufersal Tav HaZahav,
          BuyMe and more — or add one by hand.
        </p>
        {adding && (
          <VoucherFormModal
            onClose={() => setAdding(false)}
            onSaved={async () => { setAdding(false); await refresh(); }}
          />
        )}
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
        <button type="button" className="mini primary" onClick={() => setAdding(true)}>
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
      {adding && (
        <VoucherFormModal
          onClose={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await refresh(); }}
        />
      )}
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
          aria-label={isEdit ? 'Edit voucher' : 'Add a voucher'}
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
