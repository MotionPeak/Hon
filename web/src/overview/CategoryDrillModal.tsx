import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { money } from '../format';
import { cycleKey, currentCycleKey, cycleLabel } from '../cycle';
import type { Transaction } from '../activity/types';
import type { Account } from '../accounts/types';

interface CategoryDrillModalProps {
  category: string;
  color: string;
  emoji: string;
  transactions: Transaction[];
  accounts: Account[];
  monthStartDay: number;
  /** Card-bill / manually-excluded predicate — same one the donut uses, so
   *  this list reconciles with the slice it was opened from. */
  isExcluded: (t: Transaction) => boolean;
  currency: string;
  onClose: () => void;
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Drill-in for one spending category — opens when a donut slice or legend row
 * is clicked. Lists every ILS expense in that category within the current
 * billing cycle, newest first, with the cycle total in the header. Mirrors the
 * legacy SPA's `categoryDrillModal`. Filters identically to the donut (ILS,
 * non-refund, non-excluded, expenses only) so the total matches the slice.
 */
export function CategoryDrillModal({
  category, color, emoji, transactions, accounts, monthStartDay, isExcluded, currency, onClose,
}: CategoryDrillModalProps) {
  // Esc closes, matching the app's other dismissible surfaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cycle = currentCycleKey(monthStartDay);
  const acctById = new Map<string, Account>();
  for (const a of accounts) acctById.set(a.id, a);

  const rows = transactions
    .filter((t) => t.currency === 'ILS' && !t.refundForId && !isExcluded(t))
    .filter((t) => cycleKey(t.date, monthStartDay) === cycle)
    .filter((t) => (t.category || 'Uncategorized') === category)
    .filter((t) => t.amount < 0)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const total = rows.reduce((s, t) => s + -t.amount, 0);

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`${category} this cycle`}
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drill-head">
          <span className="drill-em" style={{ background: `${color}22`, color }}>{emoji}</span>
          <div className="drill-h-main">
            <div className="drill-h-cat">{category}</div>
            <div className="drill-h-sub">
              {cycleLabel(cycle)} · {rows.length} transaction{rows.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="drill-h-total">{money(total, currency)}</div>
        </div>
        <div className="drill-list">
          {rows.length === 0 ? (
            <div className="empty">No transactions in this category this cycle.</div>
          ) : (
            rows.map((t) => {
              const acct = acctById.get(t.accountId);
              const place = acct ? ` · ${acct.label || acct.connectionName || ''}` : '';
              return (
                <div className="drill-row" key={t.id}>
                  <div className="drill-main">
                    <div className="drill-name">{t.description || '—'}</div>
                    <div className="drill-sub">{fmtDate(t.date)}{place}</div>
                  </div>
                  <div className="drill-amt">{money(t.amount, t.currency)}</div>
                </div>
              );
            })
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
