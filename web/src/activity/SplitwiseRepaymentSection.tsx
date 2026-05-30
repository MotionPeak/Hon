import { useState } from 'react';
import { useSplitwise } from '../splitwise/useSplitwise';
import type { SplitwiseFriend } from '../splitwise/types';
import type { Transaction } from './types';

// Sidebar block for an INCOMING transaction: mark it as a friend repaying the
// user. Drives Splitwise paid-state from the real money, not Splitwise's
// settle-up flag. Hidden unless connected, the amount is positive, and the txn
// isn't already a split expense.
export function SplitwiseRepaymentSection({ transaction }: { transaction: Transaction }) {
  const sw = useSplitwise();
  const [picking, setPicking] = useState(false);
  const [friends, setFriends] = useState<SplitwiseFriend[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isExpenseLink = sw.linkByTxnId.has(transaction.id);
  if (!sw.connected || !(transaction.amount > 0) || isExpenseLink) return null;

  const existing = sw.repaymentByTxnId.get(transaction.id);

  const openPicker = async (): Promise<void> => {
    setError(null);
    setPicking(true);
    if (!friends) {
      try { setFriends((await sw.loadPickList()).friends); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); setPicking(false); }
    }
  };

  const pick = async (f: SplitwiseFriend): Promise<void> => {
    setBusy(true); setError(null);
    try { await sw.markRepayment(transaction.id, f.id, f.name); setPicking(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const unmark = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { await sw.unmarkRepayment(transaction.id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="txn-sidebar-section">
      <div className="label">Splitwise repayment</div>
      {existing ? (
        <div className="rf-linked">
          <div className="rf-linked-name">&#x21A9; Repayment from {existing.counterpartyName}</div>
          <button
            type="button" className="rf-unlink" aria-label="Remove repayment"
            disabled={busy} onClick={() => void unmark()}
          >&#x2715;</button>
        </div>
      ) : picking ? (
        <div className="rf-picklist">
          {(friends ?? []).map((f) => (
            <button
              key={f.id} type="button" className="txn-sidebar-action"
              disabled={busy} onClick={() => void pick(f)}
            >{f.name}</button>
          ))}
        </div>
      ) : (
        <button type="button" className="txn-sidebar-action" onClick={() => void openPicker()}>
          Mark as Splitwise repayment
        </button>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
}
