import { useState } from 'react';
import { money } from '../format';
import { useSplitwise } from '../splitwise/useSplitwise';
import { SplitwiseSheet } from '../splitwise/SplitwiseSheet';
import type { Transaction } from './types';

// The Splitwise block in a transaction's sidebar. Hidden entirely until
// Splitwise is connected. Unlinked → opens the split sheet; linked → shows the
// outstanding balance + a delete button (which removes the expense remotely too).
export function SplitwiseSection({ transaction }: { transaction: Transaction }) {
  const sw = useSplitwise();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sw.connected) return null;

  const link = sw.linkByTxnId.get(transaction.id);
  const remaining = link ? Math.max(0, link.owedToMe - (link.paidAmount || 0)) : 0;
  const who = link ? link.counterparties.map((c) => c.name).join(', ') : '';

  const onUnlink = async (): Promise<void> => {
    if (!window.confirm(
      'Delete this expense from Splitwise? It will be removed for everyone it is shared with.',
    )) return;
    setBusy(true); setError(null);
    try { await sw.deleteExpense(transaction.id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="txn-sidebar-section">
      <div className="label">Splitwise</div>
      {link ? (
        <div className="rf-linked">
          <div className="rf-linked-name">
            {link.paidState === 'paid'
              ? 'Paid back'
              : `${money(remaining, link.currency)} owed to you`}
            {who && <span className="txn-sub"> · {who}</span>}
          </div>
          <button
            type="button" className="rf-unlink" aria-label="Delete from Splitwise"
            disabled={busy} onClick={() => void onUnlink()}
          >✕</button>
        </div>
      ) : (
        <button type="button" className="txn-sidebar-action" onClick={() => setOpen(true)}>
          + Split on Splitwise
        </button>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
      <SplitwiseSheet
        open={open}
        transaction={transaction}
        loadPickList={sw.loadPickList}
        onCreate={async (groupId, shares) => {
          await sw.createExpense(transaction.id, groupId, shares);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
