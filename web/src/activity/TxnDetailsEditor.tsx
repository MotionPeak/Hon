import { useState } from 'react';
import { useSetTransactionDetails } from '../api/hooks/useTransactions';
import type { Transaction } from './types';
import './txnNames.css';

/** Title + notes editor for the transaction detail sidebar. Saves via the
 *  details mutation; empty fields clear (sent as null). */
export function TxnDetailsEditor({ transaction }: { transaction: Transaction }) {
  const [title, setTitle] = useState(transaction.customTitle ?? '');
  const [notes, setNotes] = useState(transaction.notes ?? '');
  const mutation = useSetTransactionDetails();

  const dirty = title !== (transaction.customTitle ?? '') || notes !== (transaction.notes ?? '');
  const onSave = () => {
    if (!dirty || mutation.isPending) return;
    mutation.mutate({
      id: transaction.id,
      customTitle: title.trim() === '' ? null : title,
      notes: notes.trim() === '' ? null : notes,
    });
  };

  return (
    <div className="txn-sidebar-section">
      <div className="label">Title &amp; notes</div>
      <input
        className="txn-detail-input"
        aria-label="Title"
        placeholder={transaction.description}
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="txn-detail-notes"
        aria-label="Notes"
        placeholder="Add a note…"
        maxLength={2000}
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button
        type="button"
        className="btn-primary"
        disabled={!dirty || mutation.isPending}
        onClick={onSave}
      >{mutation.isPending ? 'Saving…' : 'Save title & notes'}</button>
    </div>
  );
}
